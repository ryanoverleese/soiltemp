// netlify/functions/soil-temp.js
// Reads Sentek IrriMAX Live CSV via API and returns JSON with current/high/low/avg
// Expects env var IRRIMAX_API_KEY set in Netlify.
// Query params:
//   name=LOGGER_NAME   (required)
//   depth=4            (inches; optional, default 4)
//   tz=America/Chicago (optional; default America/Chicago)
//   debug=1            (optional; returns header only)

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const name = params.name;                          // e.g. 25x4gcityw
    const depthReqIn = parseFloat(params.depth || "4");// inches requested (we map to nearest cm column)
    const tz = params.tz || "America/Chicago";
    const key = process.env.IRRIMAX_API_KEY;

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Pull ~36h back, then we’ll filter to "today" in the target timezone
    const since = new Date(Date.now() - 36 * 3600 * 1000);
    const from = ymdHMS_utc(since);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&from=${from}`;
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return json(502, { error: "IrriMAX fetch failed", status: r.status, body });
    }
    const csv = await r.text();
    const rows = parseCSV(csv);
    if (!rows.length) return json(200, { note: "No data" });

    // Debug: show the header as returned by IrriMAX
    if (params.debug === "1") {
      return json(200, { header: rows[0] });
    }

    // ----------------------------
    // Identify temperature columns by pattern T#(cm), e.g. T1(5), T2(15)
    // Convert cm → inches (1 in = 2.54 cm)
    const header = rows[0].map(s => String(s || "").trim());
    const cols = []; // [{ colIdx, depthInches }]
    function pushCol(colIdx, inches) {
      cols.push({ colIdx, depthInches: inches });
    }

    header.forEach((h, i) => {
      // Strict T#(cm) pattern: T1(5), T2(15), T3(25) ...
      let m = h.match(/^T\d+\((\d+(?:\.\d+)?)\)\s*$/i);
      if (m) {
        const cm = parseFloat(m[1]);
        pushCol(i, cm / 2.54);
        return;
      }

      // Optional fallback: "Temp 10cm", "Temperature @ 10 cm"
      m = h.match(/(?:temp|temperature)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m) {
        const cm = parseFloat(m[1]);
        pushCol(i, cm / 2.54);
        return;
      }
    });

    if (!cols.length) {
      return json(500, { error: "No depth columns detected (expected T#(cm) headers)", header });
    }

    // Pick the nearest temperature column to the requested depth (in)
    let mapped = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthInches - depthReqIn) < Math.abs(mapped.depthInches - depthReqIn)) {
        mapped = c;
      }
    }

    // ----------------------------
    // Keep only "today" in given TZ, compute current/high/low/avg
    const todayStr = dateOnly_tz(new Date(), tz);
    const readings = []; // { ts: Date, temp: number }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tsRaw = row[0];
      if (!tsRaw) continue;
      const d = new Date(tsRaw);
      if (isNaN(d)) continue;
      if (dateOnly_tz(d, tz) !== todayStr) continue;

      const v = parseFloat(row[mapped.colIdx]);
      if (Number.isFinite(v)) readings.push({ ts: d, temp: v });
    }

    if (!readings.length) {
      return json(200, {
        name,
        tz,
        depthRequestedIn: depthReqIn,
        depthMappedIn: round1(mapped.depthInches),
        note: "No readings today yet"
      });
    }

    let high = readings[0], low = readings[0], sum = 0;
    for (const r1 of readings) {
      sum += r1.temp;
      if (r1.temp > high.temp) high = r1;
      if (r1.temp < low.temp)  low  = r1;
    }
    const avg = sum / readings.length;
    const current = readings[readings.length - 1];

    const fmtTime = (d) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);

    // Note: Units are "as reported" by IrriMAX (often °C if your logger is in °C; °F if °F)
    return json(200, {
      name,
      tz,
      units: "as-reported",
      depthRequestedIn: depthReqIn,
      depthMappedIn: round1(mapped.depthInches),
      current: { value: round1(current.temp), time: fmtTime(current.ts) },
      high:    { value: round1(high.temp),    time: fmtTime(high.ts) },
      low:     { value: round1(low.temp),     time: fmtTime(low.ts) },
      avg: round1(avg),
      count: readings.length,
      columnHeader: header[mapped.colIdx] // e.g., "T1(5)"
    });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};

// -------------- helpers --------------
function json(status, body) {
  return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function round1(x) { return Math.round(x * 10) / 10; }
function ymdHMS_utc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da= String(d.getUTCDate()).padStart(2, '0');
  const H = String(d.getUTCHours()).padStart(2, '0');
  const M = String(d.getUTCMinutes()).padStart(2, '0');
  const S = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${da}${H}${M}${S}`;
}
function dateOnly_tz(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
// Minimal CSV parser with quote handling
function parseCSV(text) {
  const out = []; let row = []; let cur = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (inQ) {
      if (ch === '"' && nx === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* ignore */ }
      else { cur += ch; }
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

