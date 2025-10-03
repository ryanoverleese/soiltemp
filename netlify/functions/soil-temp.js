// netlify/functions/soil-temp.js
// Uses Netlify's built-in fetch (Node 18+) — no node-fetch needed.

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const name = params.name;                   // e.g. 25x4gcityw
    const depth = parseFloat(params.depth || "4");
    const tz = params.tz || "America/Chicago";
    const key = process.env.IRRIMAX_API_KEY;   // set in Netlify Environment variables

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Pull ~36h back to be safe, then we'll filter to "today" in the given TZ.
    const since = new Date(Date.now() - 36 * 3600 * 1000);
    const from = ymdHMS_utc(since);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&from=${from}`;
    const r = await fetch(url);
    if (!r.ok) {
      const body = await r.text().catch(()=>"");
      return json(502, { error: "IrriMAX fetch failed", status: r.status, body });
    }
    const csv = await r.text();
    const rows = parseCSV(csv);
    if (!rows.length) return json(200, { note: "No data" });

    // Find columns that look like depths in inches (e.g., "4 inches")
    const header = rows[0].map(s => s.trim());
    const cols = [];
    header.forEach((h,i) => {
      const m = h.match(/([0-9]+\.?[0-9]*)\s*(?:in|inch|inches)/i);
      if (m) cols.push({ colIdx: i, depthInches: parseFloat(m[1]) });
    });
    if (!cols.length) return json(500, { error: "No depth columns in CSV header" });

    // Nearest column to requested depth
    let best = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthInches - depth) < Math.abs(best.depthInches - depth)) best = c;
    }

    // Keep only readings that are "today" in the specified TZ
    const todayStr = dateOnly_tz(new Date(), tz);
    const readings = []; // { ts: Date, tempF: number }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const tsRaw = row[0];
      if (!tsRaw) continue;
      const d = new Date(tsRaw);
      if (isNaN(d)) continue;
      if (dateOnly_tz(d, tz) !== todayStr) continue;
      const val = parseFloat(row[best.colIdx]);
      if (Number.isFinite(val)) readings.push({ ts: d, tempF: val });
    }

    if (!readings.length) {
      return json(200, {
        name,
        depthRequestedIn: depth,
        depthMappedIn: best.depthInches,
        tz,
        note: "No readings today yet"
      });
    }

    // Compute current, high, low, avg
    let high = readings[0], low = readings[0], sum = 0;
    for (const r1 of readings) {
      sum += r1.tempF;
      if (r1.tempF > high.tempF) high = r1;
      if (r1.tempF < low.tempF)  low  = r1;
    }
    const avg = sum / readings.length;
    const current = readings[readings.length - 1];
    const fmtTime = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);

    return json(200, {
      name,
      tz,
      depthRequestedIn: depth,
      depthMappedIn: best.depthInches,
      current: { valueF: round1(current.tempF), time: fmtTime(current.ts) },
      high:    { valueF: round1(high.tempF),    time: fmtTime(high.ts) },
      low:     { valueF: round1(low.tempF),     time: fmtTime(low.ts) },
      avgF: round1(avg),
      count: readings.length
    });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};

// ---------- helpers ----------
function json(status, body) {
  return { statusCode: status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function round1(x){ return Math.round(x*10)/10; }
function ymdHMS_utc(d){
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const da= String(d.getUTCDate()).padStart(2,'0');
  const H = String(d.getUTCHours()).padStart(2,'0');
  const M = String(d.getUTCMinutes()).padStart(2,'0');
  const S = String(d.getUTCSeconds()).padStart(2,'0');
  return `${y}${m}${da}${H}${M}${S}`;
}
function dateOnly_tz(d, tz){
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
// Minimal CSV parser with quote support
function parseCSV(text){
  const out=[]; let row=[]; let cur=""; let inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i], nx=text[i+1];
    if (inQ){
      if (ch === '"' && nx === '"'){ cur+='"'; i++; }
      else if (ch === '"'){ inQ=false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ","){ row.push(cur); cur=""; }
      else if (ch === "\n"){ row.push(cur); out.push(row); row=[]; cur=""; }
      else if (ch === "\r"){ /* ignore */ }
      else cur += ch;
    }
  }
  if (cur.length || row.length){ row.push(cur); out.push(row); }
  return out;
}
