// netlify/functions/soil-temp.js
// IrriMAX reader with DST-safe time formatting and selectable timestamp parsing.
// Query:
//   ?name=LOGGER_NAME        (required)
//   &depth=6                 (inches; optional; default 6)
//   &tz=America/Chicago      (optional; default America/Chicago; for OUTPUT formatting)
//   &days=30                 (optional; default 30; fetch window)
//   &parse=utc|local         (optional; default "utc"; how to interpret source stamps)
//   &debug=1                 (optional; show header only)
//   &peek=1                  (optional; sample of raw/parsed times)

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    const name = p.name;
    const depthReqIn = parseFloat(p.depth || "6");
    const tz = p.tz || "America/Chicago";      // OUTPUT TZ
    const days = Math.max(1, parseInt(p.days || "30", 10));
    const parseMode = (p.parse || "utc").toLowerCase(); // 'utc' or 'local'
    const key = process.env.IRRIMAX_API_KEY;

    if (!name) return json(400, { error: "Missing ?name=LOGGER_NAME" });
    if (!key)  return json(500, { error: "Missing IRRIMAX_API_KEY env var" });

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

    // ---- find temp columns like T1(5), T2(15) cm ----
    const cols = [];
    header.forEach((h, i) => {
      let m = h.match(/^T\d+\((\d+(?:\.\d+)?)\)\s*$/i);
      if (m) { cols.push({ colIdx: i, depthInches: parseFloat(m[1]) / 2.54 }); return; }
      m = h.match(/(?:temp|temperature)[^0-9]*([0-9]+(?:\.\d+)?)\s*cm/i);
      if (m) { cols.push({ colIdx: i, depthInches: parseFloat(m[1]) / 2.54 }); }
    });
    if (!cols.length) return json(500, { error: "No depth columns detected (expected T#(cm) headers)", header });

    // nearest depth
    let mapped = cols[0];
    for (const c of cols) {
      if (Math.abs(c.depthInches - depthReqIn) < Math.abs(mapped.depthInches - depthReqIn)) mapped = c;
    }

    // --- Timestamp parsers ---
    function parseAsUTC(tsRaw) {
      const s = String(tsRaw).trim();
      if (/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
        const d = new Date(s);
        return isNaN(d) ? new Date(NaN) : d;
      }
      const m = s.replace(/\//g, "-").replace(" ", "T")
        .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        const [, yy, MM, dd, hh, mm, ss] = m;
        return new Date(Date.UTC(+yy, +MM - 1, +dd, +hh, +mm, +(ss || 0)));
      }
      const d = new Date(s + "Z");
      return isNaN(d) ? new Date(NaN) : d;
    }

    // Interpret timestamp as if it was logged in the output tz (e.g., America/Chicago) with no offset.
    function parseAsLocalTZ(tsRaw, timeZone = tz) {
      const s = String(tsRaw).trim();
      const m = s.replace(/\//g, "-").replace(" ", "T")
        .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!m) {
        // if it already has Z/offset, just use it
        if (/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
          const d = new Date(s);
          return isNaN(d) ? new Date(NaN) : d;
        }
        return new Date(NaN);
      }
      const [, yy, MM, dd, hh, mm, ss] = m.map(x => +x || 0);
      // Build a date as if those fields are in the target tz, then convert to UTC ms:
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
      });
      // Create a Date in UTC from those components by finding the offset:
      // Construct a date in UTC first:
      const pretendUTC = new Date(Date.UTC(yy, MM - 1, dd, hh, mm, ss));
      // Find what local time that UTC instant shows in the target TZ
      // If it doesn't match the intended wall-clock, adjust by the diff:
      const parts = Object.fromEntries(fmt.formatToParts(pretendUTC).map(p => [p.type, p.value]));
      const got = {
        Y: +parts.year, M: +parts.month, D: +parts.day,
        h: +parts.hour, m: +parts.minute, s: +parts.second
      };
      const delta =
        ((yy - got.Y) * 365*24*3600 +
         (MM - got.M) * 31*24*3600 +
         (dd - got.D) * 24*3600 +
         (hh - got.h) * 3600 +
         (mm - got.m) * 60 +
         (ss - got.s)) * 1000;
      return new Date(pretendUTC.getTime() - delta);
    }

    const parseTs = (parseMode === "local") ? parseAsLocalTZ : parseAsUTC;

    // build readings
    const readings = []; // { ts: Date, temp: number, raw: string }
    const dateIdx = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const tsRaw = r[dateIdx];
      if (!tsRaw) continue;
      const d = parseTs(tsRaw);
      if (isNaN(d)) continue;
      const v = parseFloat(r[mapped.colIdx]);
      if (Number.isFinite(v)) readings.push({ ts: d, temp: v, raw: tsRaw });
    }

    if (p.peek === "1") {
      const sample = readings.slice(-6).map(x => ({
        raw: x.raw,
        utcISO: x.ts.toISOString(),
        chicago: new Intl.DateTimeFormat("en-US", {
          timeZone: tz, dateStyle: "short", timeStyle: "short"
        }).format(x.ts)
      }));
      return json(200, { header, parseMode, mappedColumn: header[mapped.colIdx], depthMappedIn: round1(mapped.depthInches), sample });
    }

    if (!readings.length) return json(200, { error: "No readings parsed.", header, parseMode });

    readings.sort((a,b) => a.ts - b.ts);
    const latest = readings[readings.length - 1];

    const todayKey = dateOnly_tz(new Date(), tz);
    const todayReadings = readings.filter(r => dateOnly_tz(r.ts, tz) === todayKey);

    let high = null, low = null, sum = 0;
    for (const r of todayReadings) {
      sum += r.temp;
      if (!high || r.temp > high.temp) high = r;
      if (!low  || r.temp < low.temp)  low  = r;
    }
    const avgToday = todayReadings.length ? sum / todayReadings.length : null;

    // trends: latest minus average over 7/30 days
    const nowMs = Date.now();
    const avgOver = (daysBack) => {
      const cutoff = nowMs - daysBack * 24 * 3600 * 1000;
      const arr = readings.filter(r => r.ts.getTime() >= cutoff);
      if (!arr.length) return null;
      return arr.reduce((a,b)=>a+b.temp, 0) / arr.length;
    };
    const avg7  = avgOver(7);
    const avg30 = avgOver(30);
    const delta7  = (avg7  == null) ? null : (latest.temp - avg7);
    const delta30 = (avg30 == null) ? null : (latest.temp - avg30);

    // format times in requested TZ with DST label
    const fmtTime = (d) => new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short"
    }).format(d);

    return json(200, {
      name,
      tz,
      parseMode,
      units: "as-reported",
      depthRequestedIn: depthReqIn,
      depthMappedIn: round1(mapped.depthInches),
      columnHeader: header[mapped.colIdx],

      current: { value: round1(latest.temp), time: fmtTime(latest.ts), iso: latest.ts.toISOString() },
      high:    high ? { value: round1(high.temp), time: fmtTime(high.ts), iso: high.ts.toISOString() } : null,
      low:     low  ? { value: round1(low.temp),  time: fmtTime(low.ts),  iso: low.ts.toISOString() } : null,
      avg:     avgToday !== null ? round1(avgToday) : null,
      count:   todayReadings.length,

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
