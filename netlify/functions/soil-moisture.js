// netlify/functions/soil-moisture.js
// Sentek Drill & Drop moisture (% VWC) from IrriMAX Live using A#(cm) columns.
// Query:
//   ?name=LOGGER_NAME        (required)
//   &depths=6,22             (optional CSV of inches; default "6,22")
//   &days=30                 (optional lookback days; default 30)
//   &tz=America/Chicago      (optional; for timestamp parsing/formatting)
//   &peek=1                  (optional; dumps header + sample rows for debugging)
//
// Env var required: IRRIMAX_API_KEY

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Content-Type",
      },
      body: "",
    };
  }

  try {
    const p = event.queryStringParameters || {};
    const name = p.name;
    const tz = p.tz || "America/Chicago";
    const days = Math.max(1, parseInt(p.days || "30", 10));
    const depthsReq = (p.depths || "6,22")
      .split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const key = process.env.IRRIMAX_API_KEY;
    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key) return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Fetch window
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const from = ymdHMS_utc(since);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${encodeURIComponent(
      key
    )}&name=${encodeURIComponent(name)}&from=${from}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return json(502, { error: "IrriMAX fetch failed", status: resp.status, body });
    }

    const csvText = await resp.text();
    const rows = parseCSV(csvText);
    if (!rows.length) return json(200, { note: "No data (empty CSV)" });

    const header = rows[0].map((x) => String(x || "").trim());

    // ---------- Identify moisture columns (Sentek) ----------
    // Use A#(cm) columns (true % VWC). Ignore V# (battery/voltage), S# (salinity), T# (temp).
    const mCols = []; // { colIdx, depthInches }
    header.forEach((h, i) => {
      // e.g., "A2(15)" or "A6(55)"
      let m = h.match(/^A(\d+)\((\d+(?:\.\d+)?)\)\s*$/i);
      if (m) {
        const cm = parseFloat(m[2]);
        mCols.push({ colIdx: i, depthInches: cm / 2.54 });
        return;
      }
      // Optional fallback: text labels like "Apparent (15cm)" / "Water Content 15 cm"
      m = h.match(/(?:apparent|water\s*content|moisture)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m) mCols.push({ colIdx: i, depthInches: parseFloat(m[1]) / 2.54 });
    });

    if (!mCols.length) {
      return json(500, { error: "No A#(cm) moisture columns detected", header });
    }

    // ---------- Parse rows ----------
    const dateIdx = 0; // first column is typically "Date Time"
    const readings = []; // [{ ts: Date, vals: {colIdx: %} }]
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rawTs = row[dateIdx];
      if (!rawTs) continue;

      // Treat bare stamps as wall-time in tz (DST-safe)
      const ts = parseLocalWallTime(rawTs, tz);
      if (isNaN(ts)) continue;

      const vals = {};
      for (const col of mCols) {
        const v = parseFloat(row[col.colIdx]);
        if (Number.isFinite(v)) vals[col.colIdx] = v;
      }
      if (Object.keys(vals).length) readings.push({ ts, vals });
    }

    if (!readings.length) return json(200, { error: "No moisture readings parsed.", header });

    // Debug peek
    if (p.peek === "1") {
      const sample = readings.slice(-6).map((x) => ({
        utcISO: x.ts.toISOString(),
        local: new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          dateStyle: "short",
          timeStyle: "short",
        }).format(x.ts),
        values: x.vals,
      }));
      return json(200, { header, mappedColumns: mCols, sample });
    }

    // Detect units: values may already be % (typical). If median <= 1, scale by 100.
    const last = readings[readings.length - 1];
    const sampleVals = Object.values(last.vals);
    const median = sampleVals.sort((a, b) => a - b)[Math.floor(sampleVals.length / 2)] || 0;
    const factor = median > 1 ? 1 : 100;

    // Build per-column series within window
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
    const series = new Map(); // colIdx -> [{ ts, v% }]
    for (const c of mCols) series.set(c.colIdx, []);
    for (const r of readings) {
      if (r.ts.getTime() < cutoffMs) continue;
      for (const c of mCols) {
        const raw = r.vals[c.colIdx];
        if (raw == null) continue;
        series.get(c.colIdx).push({ ts: r.ts, v: raw * factor });
      }
    }

    // For each requested depth: choose nearest column → latest + avg over whole window
    const depths = [];
    for (const wantIn of depthsReq) {
      let best = mCols[0];
      for (const c of mCols) {
        if (Math.abs(c.depthInches - wantIn) < Math.abs(best.depthInches - wantIn)) best = c;
      }
      const ser = series.get(best.colIdx) || [];
      if (!ser.length) {
        depths.push({
          depthIn: wantIn,
          vwc: null,
          avg30: null,
          mappedDepthIn: round1(best.depthInches),
        });
        continue;
      }
      ser.sort((a, b) => a.ts - b.ts);
      const latest = ser[ser.length - 1].v;
      const avg = ser.reduce((acc, x) => acc + x.v, 0) / ser.length;
      depths.push({
        depthIn: wantIn,
        vwc: round1(latest),
        avg30: round1(avg),
        mappedDepthIn: round1(best.depthInches),
      });
    }

    return json(200, { name, tz, days, depths });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};

/* ---------------- helpers ---------------- */
function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
function round1(x) { return Math.round(x * 10) / 10; }
function ymdHMS_utc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const H = String(d.getUTCHours()).padStart(2, "0");
  const M = String(d.getUTCMinutes()).padStart(2, "0");
  const S = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${da}${H}${M}${S}`;
}
// Parse 'YYYY-MM-DD HH:MM[:SS]' (or with / or T) as local wall-time in given tz (DST-safe)
function parseLocalWallTime(tsRaw, timeZone = "America/Chicago") {
  const s = String(tsRaw).trim();
  // If stamp already has zone (Z or ±HH:MM), let Date parse it.
  if (/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? new Date(NaN) : d;
  }
  const m = s.replace(/\//g, "-").replace(" ", "T")
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date(NaN);
  const want = { Y:+m[1], M:+m[2], D:+m[3], h:+m[4], i:+m[5], s: +(m[6] || 0) };
  const guessMs = Date.UTC(want.Y, want.M-1, want.D, want.h, want.i, want.s);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guessMs)).map(p => [p.type, p.value]));
  const gotMs = Date.UTC(+parts.year, +parts.month-1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const wantMs = Date.UTC(want.Y, want.M-1, want.D, want.h, want.i, want.s);
  return new Date(guessMs + (wantMs - gotMs));
}
// Tiny CSV parser (handles quotes)
function parseCSV(text) {
  const out = [], rowInit = () => [], pushRow = (arr) => out.push(arr);
  let row = rowInit(), cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ""; }
      else if (ch === '\n') { row.push(cur); pushRow(row); row = rowInit(); cur = ""; }
      else if (ch !== '\r') { cur += ch; }
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}
