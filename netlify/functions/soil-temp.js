// netlify/functions/soil-temp.js
// IrriMAX Live reader with timezone-safe parsing, today stats, and 7/30-day trends.
// Query:
//   ?name=LOGGER_NAME        (required)
//   &depth=6                 (inches; optional; default 6)
//   &tz=America/Chicago      (optional; default America/Chicago)
//   &days=30                 (optional; default 30; how far back to fetch)
//   &debug=1                 (optional; show header only)
//   &peek=1                  (optional; returns sample parsed timestamps)

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    const name = p.name;
    const depthReqIn = parseFloat(p.depth || "6");           // default view: 6"
    const tz = p.tz || "America/Chicago";
    const days = Math.max(1, parseInt(p.days || "30", 10));  // pull enough for 30-day trend
    const key = process.env.IRRIMAX_API_KEY;

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

    // Pull last N days
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
    if (p.debug === "1") return json(200, { header });

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

    // --- UTC-first timestamp parser ---
    function parseTsUTC(tsRaw) {
      const s = String(tsRaw).trim();
      if (/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
        const d = new Date(s);
        return isNaN(d) ? new Date(NaN) : d;
      }
      const m = s
        .replace(/\//g, "-")
        .replace(" ", "T")
        .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        const [, yy, MM, dd, hh, mm, ss] = m.map(x => x && x.trim());
        const d = new Date(Date.UTC(
          Number(yy),
          Number(MM) - 1,
          Number(dd),
          Number(hh),
          Number(mm),
          Number(ss || "0")
        ));
        return isNaN(d) ? new Date(NaN) : d;
      }
      const d = new Date(s + "Z");
      return isNaN(d) ? new Date(NaN) : d;
    }

    // build readings
    const readings = []; // { ts: Date, temp: number, raw: string }
    const dateIdx = 0; // "Date Time" typically first column
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const tsRaw = r[dateIdx];
      if (!tsRaw) continue;
      const d = parseTsUTC(tsRaw);
      if (isNaN(d)) continue;

      const v = parseFloat(r[mapped.colIdx]);
      if (Number.isFinite(v)) readings.push({ ts: d, temp: v, raw: tsRaw });
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
    const avgToday = todayReadings.length ? sum / todayReadings.length : null;

    // windowed averages for trends (rolling windows from "now")
    const nowMs = Date.now();
    const ms7  = 7 * 24 * 3600 * 1000;
    const ms30 = 30 * 24 * 3600 * 1000;

    const avgOver = (msBack) => {
      const cutoff = nowMs - msBack;
      const arr = readings.filter(r => r.ts.getTime() >= cutoff);
      if (!arr.length) return null;
      const s = arr.reduce((a,b) => a + b.temp, 0);
      return s / arr.length;
    };

    const avg7  = avgOver(ms7);
    const avg30 = avgOver(ms30);

    const delta7  = (avg7  == null) ? null : (latest.temp - avg7);
    const delta30 = (avg30 == null) ? null : (latest.temp - avg30);

    const fmtTime = (d) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);

    return json(200, {
      name,
      tz,
      units: "as-reported",               // temperatures are returned in API's native units (usually °C)
      depthRequestedIn: depthReqIn,
      depthMappedIn: round1(mapped.depthInches),
      columnHeader: header[mapped.colIdx],
      current: { value: round1(latest.temp), time: fmtTime(latest.ts) },
      high:    high ? { value: round1(high.temp), time: fmtTime(high.ts) } : null,
      low:     low  ? { value: round1(low.temp),  time: fmtTime(low.ts) }  : null,
      avg:     avgToday !== null ? round1(avgToday) : null,
      count:   todayReadings.length,

      // New trend payloads (in as-reported units)
      trend7d:  { avg: avg7  == null ? null : round1(avg7),  delta: delta7  == null ? null : round1(delta7) },
      trend30d: { avg: avg30 == null ? null : round1(avg30), delta: delta30 == null ? null : round1(delta30) }
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
