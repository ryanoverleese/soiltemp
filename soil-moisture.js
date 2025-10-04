// netlify/functions/soil-moisture.js
// Live soil moisture (VWC %) from IrriMAX Live for specified depths.
// Example:
//   /.netlify/functions/soil-moisture?name=LOGGER_NAME&depths=6,22&days=30&tz=America/Chicago
//
// Env var required:
//   IRRIMAX_API_KEY
//
// Output:
// {
//   "name":"...",
///  "tz":"America/Chicago",
//   "days":30,
//   "depths":[
//     {"depthIn":6,"vwc":31.2,"avg30":29.8,"mappedDepthIn":5.9},
//     {"depthIn":22,"vwc":52.1,"avg30":54.0,"mappedDepthIn":22.4}
//   ]
// }

exports.handler = async (event) => {
  // CORS preflight support
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "Content-Type"
      },
      body: ""
    };
  }

  try {
    const p = event.queryStringParameters || {};
    const name = p.name;
    const tz = p.tz || "America/Chicago";
    const days = Math.max(1, parseInt(p.days || "30", 10));
    const depthsReq = (p.depths || "6,22")
      .split(",")
      .map(s => parseFloat(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0);

    const key = process.env.IRRIMAX_API_KEY;
    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Fetch window
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const from = ymdHMS_utc(since);

    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}&from=${from}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text().catch(()=> "");
      return json(502, { error: "IrriMAX fetch failed", status: resp.status, body });
    }
    const csvText = await resp.text();
    const rows = parseCSV(csvText);
    if (!rows.length) return json(200, { note: "No data (empty CSV)" });

    const header = rows[0].map(x => String(x||"").trim());

    // --- Find VWC columns like V1(5), V2(15) (cm) or headers with 'vwc/theta (cm)'
    const vCols = []; // { colIdx, depthInches }
    header.forEach((h, i) => {
      let m = h.match(/^V\d+\((\d+(?:\.\d+)?)\)\s*$/i); // V1(5)
      if (m) { vCols.push({ colIdx: i, depthInches: parseFloat(m[1]) / 2.54 }); return; }
      m = h.match(/(?:vwc|theta|θ|water\s*content)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m) vCols.push({ colIdx: i, depthInches: parseFloat(m[1]) / 2.54 });
    });
    if (!vCols.length) {
      return json(500, { error: "No moisture (VWC) columns detected", header });
    }

    // --- Parse rows into time series ---
    const dateIdx = 0; // usually first column is "Date Time"
    const readings = []; // [{ ts: Date, vals: {colIdx: vwc} }]
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rawTs = row[dateIdx];
      if (!rawTs) continue;

      // Parse 'YYYY-MM-DD HH:MM[:SS]' as wall time in tz (DST-safe)
      const ts = parseLocalWallTime(rawTs, tz);
      if (isNaN(ts)) continue;

      const vals = {};
      for (const col of vCols) {
        const v = parseFloat(row[col.colIdx]);
        if (Number.isFinite(v)) vals[col.colIdx] = v;
      }
      if (Object.keys(vals).length) readings.push({ ts, vals });
    }
    if (!readings.length) return json(200, { error: "No VWC readings parsed.", header });

    // Detect units: if recent values look like 0..1, scale to percent
    const last = readings[readings.length - 1];
    const sample = Object.values(last.vals);
    const median = sample.sort((a,b)=>a-b)[Math.floor(sample.length/2)];
    const factor = median > 1 ? 1 : 100;

    // Build per-column series within window
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
    const series = new Map(); // colIdx -> [{ts, v%}]
    for (const c of vCols) series.set(c.colIdx, []);
    for (const r of readings) {
      if (r.ts.getTime() < cutoffMs) continue;
      for (const c of vCols) {
        const raw = r.vals[c.colIdx];
        if (raw == null) continue;
        series.get(c.colIdx).push({ ts: r.ts, v: raw * factor });
      }
    }

    // For each requested depth: nearest column → latest + 30-day avg
    const depths = [];
    for (const wantIn of depthsReq) {
      let best = vCols[0];
      for (const c of vCols) {
        if (Math.abs(c.depthInches - wantIn) < Math.abs(best.depthInches - wantIn)) best = c;
      }
      const ser = series.get(best.colIdx) || [];
      if (!ser.length) {
        depths.push({ depthIn: wantIn, vwc: null, avg30: null, mappedDepthIn: round1(best.depthInches) });
        continue;
      }
      ser.sort((a,b)=> a.ts - b.ts);
      const latest = ser[ser.length - 1].v;
      const avg30 = ser.reduce((a,b)=> a + b.v, 0) / ser.length;
      depths.push({
        depthIn: wantIn,
        vwc: round1(latest),
        avg30: round1(avg30),
        mappedDepthIn: round1(best.depthInches)
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
      "access-control-allow-methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}
function round1(x){ return Math.round(x*10)/10; }
function ymdHMS_utc(d){
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const da = String(d.getUTCDate()).padStart(2,'0');
  const H = String(d.getUTCHours()).padStart(2,'0');
  const M = String(d.getUTCMinutes()).padStart(2,'0');
  const S = String(d.getUTCSeconds()).padStart(2,'0');
  return `${y}${m}${da}${H}${M}${S}`;
}
// Parse 'YYYY-MM-DD HH:MM[:SS]' (or with / or T) as local wall-time in given tz
function parseLocalWallTime(tsRaw, timeZone = "America/Chicago") {
  const s = String(tsRaw).trim();
  // Already timezone aware? let Date parse it.
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
// Tiny CSV parser (handles quoted cells)
function parseCSV(text){
  const out=[], rowInit=()=>[], pushRow=(arr)=>{ out.push(arr); };
  let row=rowInit(), cur="", inQ=false;
  for (let i=0;i<text.length;i++){
    const ch=text[i], nx=text[i+1];
    if (inQ){
      if (ch==='"' && nx==='"'){ cur+='"'; i++; }
      else if (ch==='"'){ inQ=false; }
      else { cur+=ch; }
    } else {
      if (ch==='"'){ inQ=true; }
      else if (ch===','){ row.push(cur); cur=""; }
      else if (ch==='\n'){ row.push(cur); pushRow(row); row=rowInit(); cur=""; }
      else if (ch!=='\r'){ cur+=ch; }
    }
  }
  if (cur.length || row.length){ row.push(cur); out.push(row); }
  return out;
}
