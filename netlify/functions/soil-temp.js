// netlify/functions/soil-temp.js
// Robust IrriMAX Live reader with timezone-safe parsing + debug peek.
// Query:
//   ?name=LOGGER_NAME        (required)
//   &depth=4                 (inches; optional; default 4)
//   &tz=America/Chicago      (optional; default America/Chicago)
//   &debug=1                 (optional; show header only)
//   &peek=1                  (optional; returns 6 raw/parsed timestamps to diagnose)

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    const name = p.name;
    const depthReqIn = parseFloat(p.depth || "4");
    const tz = p.tz || "America/Chicago";
    const key = process.env.IRRIMAX_API_KEY;

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Pull last ~5 days to be safe (some uploads are sparse)
    const since = new Date(Date.now() - 5 * 24 * 3600 * 1000);
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

    if (p.debug === "1") {
      return json(200, { header });
    }

    // ---- find temp columns like T1(5), T2(15) (cm) ----
    const cols = []; // {colIdx, depthInches}
    header.forEach((h, i) => {
      let m = h.match(/^T\d+\((\d+(?:\.\d+)?)\)\s*$/i);
      if (m) {
        const cm = parseFloat(m[1]);
        cols.push({ colIdx: i, depthInches: cm / 2.54 });
        return;
      }
      m = h.match(/(?:temp|temperature)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m) {
        const cm = parseFloat(m[1]);
        cols.push({ colIdx: i, depthInches: cm / 2.54 });
      }
    });
    if (!cols.length) {
      return json(500, { error: "No depth columns detected (expected T#(cm) headers)", header });
    }

    // nearest depth in inches
    let mapped = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthInches - depthReqIn) < Math.abs(mapped.depthInches - depthReqIn)) mapped = c;
    }

    // robust timestamp parser: try local CST/CDT, then strict UTC, then native
    function parseTsRobust(tsRaw) {
      const s = String(tsRaw).trim();

      // normalize common forms: "YYYY-MM-DD HH:MM:SS" or "YYYY/MM/DD HH:MM"
      const isoLike = s.includes("T") ? s : s.replace(" ", "T");

      // 1) Treat as local America/Chicago
      const localStr = new Date(isoLike).toLocaleString("en-US", { timeZone: "America/Chicago" });
      const asLocal = new Date(localStr);
      if (!isNaN(asLocal)) return asLocal;

      // 2) Treat as UTC explicitly by appending Z (if not already)
      const asUtc = new Date(isoLike.endsWith("Z") ? isoLike : isoLike + "Z");
      if (!isNaN(asUtc)) return asUtc;

      // 3) Fallback to native parse
      const nat = new Date(s);
      if (!isNaN(nat)) return nat;

      return new Date(NaN);
    }

    // build readings
    const readings = []; // { ts: Date, temp: number }
    const dateIdx = 0; // "Date Time" typically first column
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const tsRaw = r[dateIdx];
      if (!tsRaw) continue;
      const d = parseTsRobust(tsRaw);
      if (isNaN(d)) continue;

      const v = parseFloat(r[mapped.colIdx]);
      if (Number.isFinite(v)) readings.push({ ts: d, temp: v, raw: tsRaw });
    }

    // optional peek to diagnose what we're parsing
    if (p.peek === "1") {
      const sample = readings.slice(-6).map(x => ({
        raw: x.raw,
        parsedLocal: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour:'numeric', minute:'2-digit', month:'2-digit', day:'2-digit'}).format(x.ts)
      }));
      return json(200, { header, mappedColumn: header[mapped.colIdx], depthMappedIn: round1(mapped.depthInches), sample });
    }

    if (!readings.length) {
      return json(200, { error: "No readings parsed. Try ?peek=1 to inspect timestamps.", header });
    }

    // sort & pick absolute latest (no "today" filter)
    readings.sort((a,b) => a.ts - b.ts);
    const latest = readings[readings.length - 1];

    // compute today's stats in target tz
    const todayKey = dateOnly_tz(new Date(), tz);
    const todayReadings = readings.filter(r => dateOnly_tz(r.ts, tz) === todayKey);

    let high = null, low = null, sum = 0;
    for (const r of todayReadings) {
      sum += r.temp;
      if (!high || r.temp > high.temp) high = r;
      if (!low  || r.temp < low.temp)  low  = r;
    }
    const avg = todayReadings.length ? sum / todayReadings.length : null;

    const fmtTime = (d) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);

    return json(200, {
      name,
      tz,
      units: "as-reported",
      depthRequestedIn: depthReqIn,
      depthMappedIn: round1(mapped.depthInches),
      columnHeader: header[mapped.colIdx],
      current: { value: round1(latest.temp), time: fmtTime(latest.ts) },
      high:    high ? { value: round1(high.temp), time: fmtTime(high.ts) } : null,
      low:     low  ? { value: round1(low.temp),  time: fmtTime(low.ts) }  : null,
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
function round1(x){ return Math.round(x*10)/10; }
function ymdHMS_utc(d){
  const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), da=String(d.getUTCDate()).padStart(2,'0');
  const H=String(d.getUTCHours()).padStart(2,'0'), M=String(d.getUTCMinutes()).padStart(2,'0'), S=String(d.getUTCSeconds()).padStart(2,'0');
  return `${y}${m}${da}${H}${M}${S}`;
}
function dateOnly_tz(d, tz){
  return new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}

// Minimal CSV parser
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