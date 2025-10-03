// netlify/functions/soil-temp.js
// No external deps required. Uses native fetch and a tiny CSV parser.
//
// Query:
//   ?name=LOGGER_NAME   (required)
//   &depth=4            (inches; optional, default 4)
//   &tz=America/Chicago (optional; default America/Chicago)
//   &debug=1            (optional; returns header only)

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const name = params.name;
    const depthReqIn = parseFloat(params.depth || "4"); // inches
    const tz = params.tz || "America/Chicago";
    const key = process.env.IRRIMAX_API_KEY;

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Pull last ~36h to be safe
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

    // Debug: show header
    if (params.debug === "1") return json(200, { header: rows[0] });

    // ----- Detect temperature columns like T1(5), T2(15) where () is cm -----
    const header = rows[0].map(s => String(s || "").trim());
    const cols = []; // {colIdx, depthInches}
    function pushCol(i, inches) { cols.push({ colIdx: i, depthInches: inches }); }

    header.forEach((h, i) => {
      const m = h.match(/^T\d+\((\d+(?:\.\d+)?)\)\s*$/i); // e.g., "T2(15)"
      if (m) {
        const cm = parseFloat(m[1]);
        pushCol(i, cm / 2.54); // cm -> in
        return;
      }
      // Fallback: "Temp 10cm"
      const m2 = h.match(/(?:temp|temperature)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m2) {
        const cm = parseFloat(m2[1]);
        pushCol(i, cm / 2.54);
      }
    });

    if (!cols.length) {
      return json(500, { error: "No depth columns detected (expected T#(cm) headers)", header });
    }

    // Pick nearest column to requested depth (inches)
    let mapped = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthInches - depthReqIn) < Math.abs(mapped.depthInches - depthReqIn)) mapped = c;
    }

    // ----- Parse rows: treat CSV times as UTC, then format in tz -----
    // Many systems write naive timestamps; appending 'Z' forces UTC.
    function parseAsUTC(tsRaw) {
      // Normalize "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SSZ"
      const iso = String(tsRaw).trim().replace(" ", "T");
      return new Date(iso.endsWith("Z") ? iso : iso + "Z");
    }

    const readings = []; // { tsUTC: Date, temp: number }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tsRaw = row[0];
      if (!tsRaw) continue;
      const dUTC = parseAsUTC(tsRaw);
      if (isNaN(dUTC)) continue;

      const v = parseFloat(row[mapped.colIdx]);
      if (Number.isFinite(v)) readings.push({ tsUTC: dUTC, temp: v });
    }

    if (!readings.length) {
      return json(200, {
        name, tz,
        depthRequestedIn: depthReqIn,
        depthMappedIn: round1(mapped.depthInches),
        note: "No readings in range"
      });
    }

    // Sort and get absolute latest reading (no "today" filter for latest)
    readings.sort((a, b) => a.tsUTC - b.tsUTC);
    const latest = readings[readings.length - 1];

    // Compute today's high/low/avg in the requested tz
    const todayKey = dateOnly_tz(new Date(), tz);
    const todayReadings = readings.filter(r => dateOnly_tz(r.tsUTC, tz) === todayKey);

    let high = null, low = null, sum = 0;
    for (const r1 of todayReadings) {
      sum += r1.temp;
      if (!high || r1.temp > high.temp) high = r1;
      if (!low  || r1.temp < low.temp)  low  = r1;
    }
    const avg = todayReadings.length ? sum / todayReadings.length : null;

    const fmtTime = (dUTC) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(dUTC);

    return json(200, {
      name,
      tz,
      units: "as-reported",
      depthRequestedIn: depthReqIn,
      depthMappedIn: round1(mapped.depthInches),
      columnHeader: header[mapped.colIdx],
      current: { value: round1(latest.temp), time: fmtTime(latest.tsUTC) },
      high:    high ? { value: round1(high.temp), time: fmtTime(high.tsUTC) } : null,
      low:     low  ? { value: round1(low.temp),  time: fmtTime(low.tsUTC) }  : null,
      avg:     avg !== null ? round1(avg) : null,
      count:   todayReadings.length
    });

  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};

// ---------- helpers ----------
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
function dateOnly_tz(dUTC, tz) {
  // get "YYYY-MM-DD" in the target timezone
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(dUTC);
}

// Minimal CSV parser that handles quotes and commas
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