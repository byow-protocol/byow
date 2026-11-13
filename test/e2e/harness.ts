// Shared e2e plumbing: free ports, child servers, and the two hostile pages (a redirector and a "wallet"
// that tries to hijack the site's tab).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

export function buildExamples(): void {
  execFileSync(process.execPath, [path.join(root, "scripts/build-examples.mjs")], { stdio: "inherit" });
}

const children: ChildProcess[] = [];
export async function spawnServer(args: string[], url: string): Promise<void> {
  const c = spawn(process.execPath, args, { cwd: root, stdio: "ignore" });
  children.push(c);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${args.join(" ")}`);
}
export const killServers = () => children.splice(0).forEach((c) => c.kill());

export function listen(handler: http.RequestListener): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

/** A URL that 302s to another origin: a wallet that "moved". */
export const redirector = (to: string) => listen((_req, res) => void res.writeHead(302, { location: to }).end());

/**
 * A hostile "wallet". It is not a BYOW wallet at all: it just tries to navigate the window that opened it,
 * both directly and via opener.top, to a phishing page on its own origin.
 */
export const hijacker = () =>
  listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url?.startsWith("/phish")) return void res.end("<title>PHISH</title>phish");
    res.end(`<!doctype html><title>evil</title><script>
      const phish = location.origin + "/phish";
      try { opener.location = phish; } catch (e) {}
      setTimeout(() => { try { opener.top.location = phish; } catch (e) {} }, 200);
    </script>`);
  });
