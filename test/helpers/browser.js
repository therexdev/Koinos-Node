"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
async function startSignerServer() {
  const root = path.resolve(__dirname, "../../ui");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = url.pathname === "/producer-signer/koinos.min.js"
      ? path.join(path.dirname(require.resolve("koilib/package.json")), "dist/koinos.min.js")
      : path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && !file.endsWith(path.join("koilib", "dist", "koinos.min.js"))) { res.writeHead(403); res.end(); return; }
    try {
      res.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "text/plain");
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: "http://127.0.0.1:" + server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { startSignerServer };
