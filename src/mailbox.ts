// A reference mailbox: the meeting point for a link whose request and answer travel between two devices.
// It is four routes and a map. It holds sealed boxes it cannot read or forge, for a few minutes each.
//
//   PUT  {base}/{id}/request     the site stores the sealed request      201, or 409 if the id is taken
//   GET  {base}/{id}/request     the wallet fetches it                   200 {box}, or 404
//   POST {base}/{id}/response    the wallet stores the sealed answer     204, 404, or 409 if already answered
//   GET  {base}/{id}/response    the site collects it (?wait=seconds)    200 {box}, 204 not yet, or 404
//
// A site hosts this on its own origin, or names anyone else's: the link carries the mailbox's URL, so no relay
// is shared and nobody sits in the middle of every wallet. Hosted on the site's own origin (even as a rewrite
// to someone else's server), the wallet shows the site's origin as the place its answer goes.
// Zero dependencies. The core is plain functions; nodeMailbox adapts it to node:http.

import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BOX_CHARS } from "./link.js";

export interface MailboxOptions {
  /** How long a channel lives after its request is stored. Default 10 minutes. */
  ttlMs?: number;
  /** Refuse new channels beyond this many. Default 10,000. */
  maxChannels?: number;
  /** Longest a collector may wait for an answer in one call. Default 25 seconds. */
  maxWaitMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface MailboxRequest {
  method: string;
  /** The path after the mailbox's base, e.g. "/Xy3.../request". */
  path: string;
  body?: string;
  /** Seconds to wait for an answer (GET response only). */
  wait?: number;
}
export interface MailboxResponse {
  status: number;
  /** JSON text, when there is a body. */
  body?: string;
}

interface Channel {
  request: string;
  response?: string;
  expires: number;
  waiters: Array<() => void>;
}

const PATH_RE = /^\/([A-Za-z0-9_-]{22,64})\/(request|response)$/;

export interface Mailbox {
  handle(req: MailboxRequest): Promise<MailboxResponse>;
  /** Channels currently held. */
  size(): number;
}

export function createMailbox(o: MailboxOptions = {}): Mailbox {
  const ttl = o.ttlMs ?? 10 * 60_000;
  const maxChannels = o.maxChannels ?? 10_000;
  const maxWait = o.maxWaitMs ?? 25_000;
  const now = o.now ?? Date.now;
  const channels = new Map<string, Channel>();

  const sweep = () => {
    const t = now();
    for (const [id, ch] of channels) {
      if (ch.expires <= t) {
        channels.delete(id);
        ch.waiters.splice(0).forEach((w) => w());
      }
    }
  };
  const live = (id: string): Channel | undefined => {
    const ch = channels.get(id);
    if (ch && ch.expires <= now()) {
      channels.delete(id);
      return undefined;
    }
    return ch;
  };
  // The body is `{"box":"..."}` and nothing else. The box is opaque here: only its size and alphabet are checked.
  const readBox = (body: string | undefined): string | null => {
    if (typeof body !== "string" || body.length > MAX_BOX_CHARS + 32) return null;
    try {
      const v = JSON.parse(body) as { box?: unknown };
      return typeof v?.box === "string" && v.box.length > 0 && v.box.length <= MAX_BOX_CHARS && /^[A-Za-z0-9_-]+$/.test(v.box) ? v.box : null;
    } catch {
      return null;
    }
  };
  const boxBody = (box: string): MailboxResponse => ({ status: 200, body: JSON.stringify({ box }) });

  return {
    size: () => channels.size,
    async handle(req) {
      const m = PATH_RE.exec(req.path);
      if (!m) return { status: 404 };
      const [, id, what] = m as unknown as [string, string, "request" | "response"];

      if (what === "request") {
        if (req.method === "GET") {
          const ch = live(id);
          return ch ? boxBody(ch.request) : { status: 404 };
        }
        if (req.method !== "PUT") return { status: 405 };
        const box = readBox(req.body);
        if (!box) return { status: 400 };
        sweep();
        if (channels.has(id)) return { status: 409 };
        if (channels.size >= maxChannels) return { status: 503 };
        channels.set(id, { request: box, expires: now() + ttl, waiters: [] });
        return { status: 201 };
      }

      const ch = live(id);
      if (!ch) return { status: 404 };
      if (req.method === "POST") {
        const box = readBox(req.body);
        if (!box) return { status: 400 };
        if (ch.response !== undefined) return { status: 409 }; // one answer per link
        ch.response = box;
        ch.waiters.splice(0).forEach((w) => w());
        return { status: 204 };
      }
      if (req.method !== "GET") return { status: 405 };
      if (ch.response === undefined && req.wait && req.wait > 0) {
        const ms = Math.min(req.wait * 1000, maxWait, Math.max(0, ch.expires - now()));
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, ms);
          function done() {
            clearTimeout(t);
            const i = ch!.waiters.indexOf(done);
            if (i >= 0) ch!.waiters.splice(i, 1);
            resolve();
          }
          ch.waiters.push(done);
        });
      }
      return ch.response !== undefined ? boxBody(ch.response) : { status: 204 };
    },
  };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
  "cache-control": "no-store",
};

/**
 * Serve a mailbox from a node:http server under `base` (e.g. "/byow"). Returns true if the request was the
 * mailbox's, so it drops into an existing handler: `if (mailbox(req, res)) return;`.
 */
export function nodeMailbox(mailbox: Mailbox = createMailbox(), base = "/byow"): (req: IncomingMessage, res: ServerResponse) => boolean {
  const prefix = base.replace(/\/$/, "");
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://mailbox.invalid");
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return false;
    const send = (r: MailboxResponse) => {
      res.writeHead(r.status, { ...CORS, ...(r.body ? { "content-type": "application/json" } : {}) });
      res.end(r.body);
    };
    if (req.method === "OPTIONS") {
      send({ status: 204 });
      return true;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BOX_CHARS + 64) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const wait = Number(url.searchParams.get("wait"));
      void mailbox
        .handle({
          method: req.method ?? "GET",
          path: url.pathname.slice(prefix.length),
          body: Buffer.concat(chunks).toString("utf8"),
          ...(Number.isFinite(wait) && wait > 0 ? { wait } : {}),
        })
        .then(send, () => send({ status: 500 }));
    });
    return true;
  };
}
