import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const index = read("index.html");
const notFound = read("404.html");
const head = index.slice(0, index.indexOf("</head>"));
const LOGGER = "25x4gcityw";

function startStaticServer() {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(root, "404.html")).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(server, pathname) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          type: res.headers["content-type"] || "",
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
  });
}

test("page source keeps temperature math, thresholds, and fetch URLs", () => {
  assert.match(index, /const toF = c => Math\.round\(\(c \* 9\/5 \+ 32\) \* 10\) \/ 10;/);
  assert.match(index, /const deltaToF = dc => Math\.round\(\(dc \* 9\/5\) \* 10\) \/ 10;/);
  assert.match(index, /6:\s+\{\s*low:\s*24\.08,\s*high:\s*48\.35\s*\}/);
  assert.match(index, /22:\s+\{\s*low:\s*48\.39,\s*high:\s*54\.66\s*\}/);
  assert.match(index, /\/\.netlify\/functions\/soil-temp\?name=\$\{encodeURIComponent\(loggerName\)\}/);
  assert.match(index, /\/\.netlify\/functions\/soil-moisture\?name=\$\{encodeURIComponent\(loggerName\)\}&depths=6,22/);
  assert.equal(index.includes("setTimeout"), false);
  const script = index.match(/<script>([\s\S]*?)<\/script>/)[1];
  const checkPath = path.join(root, "test", ".script-syntax.js");
  fs.writeFileSync(checkPath, script);
  try {
    execFileSync(process.execPath, ["--check", checkPath], { stdio: "pipe" });
  } finally {
    fs.unlinkSync(checkPath);
  }
});

test("function files only gain a noindex header", () => {
  for (const rel of ["netlify/functions/soil-temp.js", "netlify/functions/soil-moisture.js"]) {
    const current = read(rel);
    const original = execFileSync("git", ["show", `HEAD:${rel}`], { encoding: "utf8" });
    const normalize = (s) => s
      .split("\n")
      .filter((line) => !line.includes("x-robots-tag"))
      .map((line) => line.replace(/,\s*$/, ""))
      .join("\n");
    assert.equal(normalize(current), normalize(original));
    assert.equal(current.includes('"x-robots-tag": "noindex, nofollow"'), true);
    assert.match(current, /\/ 2\.54/);
  }
});

test("metadata, robots, and 404 do not publish logger or function URLs", () => {
  const robots = read("robots.txt");
  assert.equal(robots, "User-agent: *\nDisallow: /\n");
  for (const text of [robots, notFound, head, read("netlify.toml")]) {
    assert.equal(text.includes(LOGGER), false);
    assert.equal(text.includes("irrimax"), false);
    assert.equal(text.toLowerCase().includes("sitemap"), false);
  }
  assert.equal(fs.existsSync(path.join(root, "sitemap.xml")), false);
  assert.match(head, /<title>Soil Insights – Acre Insights, Holdrege NE<\/title>/);
  assert.match(head, /name="description"/);
  assert.match(head, /name="robots" content="noindex, nofollow"/);
  assert.equal(head.includes("og:image"), false);
  assert.match(notFound, /<title>Page not found – Soil Insights<\/title>/);
  assert.match(notFound, /href="\/"/);
  assert.match(notFound, /name="robots" content="noindex, nofollow"/);
  assert.match(index, /is unavailable right now\. Reload the page to try again\./);
  assert.match(index, /unavailable\(contentEl, "Soil temperature"\)/);
  assert.match(index, /unavailable\(moistureEl, "Soil moisture"\)/);
  assert.match(index, /Current moisture \$\{curText\}/);
});

test("static server returns real 404s and asset bytes", async () => {
  const server = await startStaticServer();
  try {
    const home = await get(server, "/");
    assert.equal(home.status, 200);
    assert.match(home.body.toString("utf8"), /Soil Insights/);

    const direct = await get(server, "/index.html");
    assert.equal(direct.status, 200);

    const missing = await get(server, "/this-page-does-not-exist");
    assert.equal(missing.status, 404);
    assert.match(missing.type, /text\/html/);
    const missingHtml = missing.body.toString("utf8");
    assert.match(missingHtml, /Page not found/);
    assert.equal(missingHtml.includes(LOGGER), false);
    assert.equal(missingHtml.includes("Dryland corn stubble"), false);

    const nested = await get(server, "/field/nested/missing");
    assert.equal(nested.status, 404);
    assert.match(nested.body.toString("utf8"), /Page not found/);
    assert.equal(nested.body.toString("utf8").includes("<h1 class=\"title\">"), false);

    const assetMiss = await get(server, "/assets/missing.png");
    assert.equal(assetMiss.status, 404);

    const sitemap = await get(server, "/sitemap.xml");
    assert.equal(sitemap.status, 404);

    const robots = await get(server, "/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.type, /text\/plain/);
    assert.equal(robots.body.toString("utf8").includes(LOGGER), false);

    const svg = await get(server, "/favicon.svg");
    assert.equal(svg.status, 200);
    assert.match(svg.type, /image\/svg\+xml/);
    assert.match(svg.body.toString("utf8"), /<svg/);

    const png = await get(server, "/favicon-32.png");
    assert.equal(png.status, 200);
    assert.equal(png.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const apple = await get(server, "/apple-touch-icon.png");
    assert.equal(apple.status, 200);
    assert.equal(apple.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const ico = await get(server, "/favicon.ico");
    assert.equal(ico.status, 200);
    assert.equal(ico.body.readUInt16LE(0), 0);
    assert.equal(ico.body.readUInt16LE(2), 1);
    assert.ok(ico.body.readUInt16LE(4) >= 1);

    const fileItself = await get(server, "/404.html");
    assert.equal(fileItself.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
