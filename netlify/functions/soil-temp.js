const fetch = require("node-fetch");
const Papa = require("papaparse");

exports.handler = async (event) => {
  try {
    const { name, tz = "America/Chicago", depthRequestedIn = 4 } = event.queryStringParameters;

    if (!name) {
      return json(400, { error: "Missing ?name=loggerID" });
    }

    const APIKEY = process.env.IRRIMAX_API_KEY;
    if (!APIKEY) {
      return json(500, { error: "No API key set" });
    }

    // IrriMAX CSV endpoint
    const url = `https://www.irrimaxlive.com/api/?cmd=getreadings&key=${APIKEY}&name=${name}`;

    const res = await fetch(url);
    if (!res.ok) {
      return json(500, { error: `Failed IrriMAX fetch: ${res.status}` });
    }

    const text = await res.text();
    const parsed = Papa.parse(text, { header: true });
    const rows = parsed.data.filter((r) => r["Date Time"]);

    // Which column to use (temperature near requested depth)
    const headers = parsed.meta.fields;
    const tCols = headers.filter((h) => h.startsWith("T"));
    // e.g., ["T1(5)", "T2(15)", "T3(25)"]
    let mapped = { colIdx: null, depthInches: null };

    for (let col of tCols) {
      const match = col.match(/\((\d+)\)/);
      if (match) {
        const depth = parseInt(match[1], 10);
        if (!mapped.colIdx || Math.abs(depth - depthRequestedIn) < Math.abs(mapped.depthInches - depthRequestedIn)) {
          mapped.colIdx = headers.indexOf(col);
          mapped.depthInches = depth;
          mapped.colName = col;
        }
      }
    }

    if (!mapped.colIdx) {
      return json(400, { error: "No depth columns in CSV header" });
    }

    // Helper: parse timestamps as CST/CDT
    function parseAsChicago(tsRaw) {
      const localString = new Date(tsRaw).toLocaleString("en-US", { timeZone: "America/Chicago" });
      return new Date(localString);
    }

    // Collect readings
    const readings = [];
    for (let row of rows) {
      const tsRaw = row["Date Time"];
      if (!tsRaw) continue;
      const d = parseAsChicago(tsRaw);
      if (isNaN(d)) continue;

      const v = parseFloat(Object.values(row)[mapped.colIdx]);
      if (Number.isFinite(v)) {
        readings.push({ ts: d, temp: v });
      }
    }

    if (!readings.length) {
      return json(200, { error: "No readings available" });
    }

    // Sort by timestamp
    readings.sort((a, b) => a.ts - b.ts);
    const latest = readings[readings.length - 1];

    // Group for today's high/low/avg
    const today = new Date().toLocaleDateString("en-US", { timeZone: tz });
    const todayReadings = readings.filter(
      (r) => r.ts.toLocaleDateString("en-US", { timeZone: tz }) === today
    );

    let high = null, low = null, sum = 0;
    for (let r of todayReadings) {
      if (high === null || r.temp > high.temp) high = r;
      if (low === null || r.temp < low.temp) low = r;
      sum += r.temp;
    }
    const avg = todayReadings.length ? sum / todayReadings.length : null;

    const fmtTime = (d) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }).format(d);

    return json(200, {
      name,
      tz,
      units: "as-reported",
      depthRequestedIn,
      depthMappedIn: mapped.depthInches,
      columnHeader: mapped.colName,
      current: latest ? { value: round1(latest.temp), time: fmtTime(latest.ts) } : null,
      high: high ? { value: round1(high.temp), time: fmtTime(high.ts) } : null,
      low: low ? { value: round1(low.temp), time: fmtTime(low.ts) } : null,
      avg: avg ? round1(avg) : null,
      count: todayReadings.length,
    });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Exception: " + err.message });
  }
};

function round1(x) {
  return Math.round(x * 10) / 10;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}