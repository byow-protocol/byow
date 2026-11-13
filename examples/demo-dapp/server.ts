// A site that has never heard of any wallet. This is ALL the server-side work BYOW asks of a webmaster:
// issue a nonce, verify a proof, verify a signed blob against your own invoice. Nothing wallet-specific.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "xrpl";
import { checkSignedPayment, verifySignIn } from "../../src/xrpl/verify.js";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5173);
// The origin YOU serve. Never read it from the request: that is the whole point of origin binding.
const ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const CHAIN = "xrpl:1"; // the chain this site serves; the proof must name it
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const platform = process.env.PLATFORM_ADDRESS ?? Wallet.generate().classicAddress;
const tokenIssuer = process.env.TOKEN_ISSUER ?? Wallet.generate().classicAddress;
const RLUSD = "524C555344000000000000000000000000000000";
const SOURCE_TAG = 12345; // demo only; a real site uses its own registered tag

const challenges = new Map<string, number>(); // nonce -> expiry
const sessions = new Map<string, { address: string }>();
type Invoice = { id: string; owner: string; label: string; tx: Record<string, unknown>; paid: boolean; hash?: string };
const invoices = new Map<string, Invoice>();

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const readJson = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > 256 * 1024) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch (e) { reject(e); }
    });
  });
const session = (req: http.IncomingMessage) => {
  const sid = /(?:^|; )sid=([a-f0-9]{32})/.exec(req.headers.cookie ?? "")?.[1];
  return sid ? sessions.get(sid) : undefined;
};

const headers = {
  // Required of integrators: same-origin would sever window.opener from every wallet popup.
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", ORIGIN);

      if (req.method === "POST" && url.pathname === "/api/challenge") {
        const nonce = crypto.randomBytes(16).toString("base64url"); // 128 bits, [A-Za-z0-9_-]
        challenges.set(nonce, Date.now() + 5 * 60_000);
        return json(res, 200, { challenge: nonce });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const { proof, challenge } = (await readJson(req)) as { proof: string; challenge: string };
        const expiry = challenges.get(challenge);
        challenges.delete(challenge); // single use, even on failure
        if (!expiry || expiry < Date.now()) return json(res, 401, { error: "unknown or expired challenge" });
        const check = verifySignIn(String(proof), { origin: ORIGIN, chain: CHAIN, challenge });
        if (!check.ok) return json(res, 401, { error: check.reason });
        // A site guarding anything of value now looks the account up on a validated ledger and requires
        // keyMayActFor(accountRoot, check.publicKey). This demo has no ledger to ask.
        const sid = crypto.randomBytes(16).toString("hex");
        sessions.set(sid, { address: check.address });
        return json(res, 200, { address: check.address }, { "set-cookie": `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` });
      }

      if (url.pathname.startsWith("/api/")) {
        const me = session(req);
        if (!me) return json(res, 401, { error: "not logged in" });

        if (req.method === "POST" && url.pathname === "/api/invoices") {
          const mk = (label: string, Amount: unknown): Invoice => {
            const id = crypto.randomBytes(6).toString("hex");
            const tx = { TransactionType: "Payment", Destination: platform, Amount, DestinationTag: crypto.randomInt(1, 2 ** 31), SourceTag: SOURCE_TAG };
            const inv = { id, owner: me.address, label, tx, paid: false };
            invoices.set(id, inv);
            return inv;
          };
          const out = [mk("1 XRP", "1000000"), mk("5 RLUSD", { currency: RLUSD, issuer: tokenIssuer, value: "5" })];
          return json(res, 200, out.map(({ id, label, tx }) => ({ id, label, tx })));
        }

        if (req.method === "POST" && url.pathname === "/api/pay") {
          const { invoiceId, tx_blob } = await readJson(req);
          const inv = invoices.get(invoiceId);
          if (!inv || inv.owner !== me.address || inv.paid) return json(res, 404, { error: "no such open invoice" });
          const t = inv.tx as { Destination: string; Amount: any; DestinationTag: number; SourceTag: number };
          const check = checkSignedPayment(String(tx_blob), {
            account: me.address,
            destination: t.Destination,
            amount: t.Amount,
            destinationTag: t.DestinationTag,
            sourceTag: t.SourceTag,
            maxFeeDrops: 10_000n,
          });
          if (!check.ok) return json(res, 400, { error: check.reason });
          inv.paid = true;
          inv.hash = check.hash;
          // A real site now submits tx_blob itself and treats ONLY the validated ledger as truth.
          return json(res, 200, { ok: true, hash: check.hash, submitted: false });
        }
        return json(res, 404, { error: "not found" });
      }

      // Explicit allowlist: this directory also holds the server's own source.
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/dist/app.js": ["dist/app.js", "text/javascript"],
        "/return": ["return.html", "text/html; charset=utf-8"],
        "/dist/return.js": ["dist/return.js", "text/javascript"],
      };
      const hit = files[url.pathname];
      if (!hit) return void res.writeHead(404, headers).end("not found");
      res.writeHead(200, { ...headers, "content-type": hit[1] });
      fs.createReadStream(path.resolve(root, hit[0])).pipe(res);
    } catch {
      json(res, 400, { error: "bad request" });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`demo site on ${ORIGIN} (platform ${platform})`));
