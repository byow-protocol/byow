// Tiny static server for the example wallet. Usage: node static-server.mjs <dir> <port>
// The headers are the point: this is what a wallet page should send.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [dir, port] = [path.resolve(process.argv[2]), Number(process.argv[3])];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file)] ?? "application/octet-stream",
      // The wallet window must stay reachable by the site that opened it. same-origin here would sever
      // window.opener and every site would see an infinite spinner.
      "cross-origin-opener-policy": "unsafe-none",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' wss: https:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://localhost:${port}`));
