// The reference mailbox (SPEC 8.3): four routes, status codes, expiry, refusals, and the node:http adapter.
// The core is driven with an injected clock; one test runs nodeMailbox over a real server on port 0.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BOX_CHARS, newChannelId, newKey, seal } from "../src/link.js";
import { createMailbox, nodeMailbox, type MailboxOptions } from "../src/mailbox.js";

const ID = "Xy3aBcDeFgHiJkLmNoPqRs"; // 22 chars
const BOX = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8_-_";
const body = (box: string) => JSON.stringify({ box });

function setup(o: MailboxOptions = {}) {
  const clock = { t: 1_000_000 };
  const mb = createMailbox({ now: () => clock.t, ...o });
  // An explicit undefined means "no body"; leaving the argument out means a valid one.
  const put = (id: string, ...a: [string?]) => {
    const b = a.length ? a[0] : body(BOX);
    return mb.handle({ method: "PUT", path: `/${id}/request`, ...(b === undefined ? {} : { body: b }) });
  };
  const getReq = (id: string) => mb.handle({ method: "GET", path: `/${id}/request` });
  const post = (id: string, ...a: [string?]) => {
    const b = a.length ? a[0] : body(BOX);
    return mb.handle({ method: "POST", path: `/${id}/response`, ...(b === undefined ? {} : { body: b }) });
  };
  const getRes = (id: string, wait?: number) => mb.handle({ method: "GET", path: `/${id}/response`, ...(wait === undefined ? {} : { wait }) });
  return { mb, clock, put, getReq, post, getRes };
}

describe("the four routes", () => {
  it("PUT request: 201, then 409 for the same id", async () => {
    const { put, mb } = setup();
    expect(await put(ID)).toEqual({ status: 201 });
    expect(mb.size()).toBe(1);
    expect(await put(ID)).toMatchObject({ status: 409 });
    expect(await put(ID, body("different"))).toMatchObject({ status: 409 });
    expect(mb.size()).toBe(1);
    expect((await put("B".repeat(22))).status).toBe(201);
    expect(mb.size()).toBe(2);
  });

  it("GET request: 200 {box} byte for byte, 404 for an unknown channel, repeatable", async () => {
    const { put, getReq } = setup();
    await put(ID);
    for (let i = 0; i < 3; i++) {
      const r = await getReq(ID);
      expect(r.status).toBe(200);
      expect(r.body).toBe(body(BOX));
    }
    expect((await getReq("Z".repeat(22))).status).toBe(404);
  });

  it("POST response: 204, then 409 for a second answer, 404 for an unknown channel", async () => {
    const { put, post, getRes } = setup();
    await put(ID);
    expect(await post(ID)).toEqual({ status: 204 });
    expect((await post(ID, body("another"))).status).toBe(409);
    expect((await getRes(ID)).body).toBe(body(BOX)); // the first answer stands
    expect((await post("Z".repeat(22))).status).toBe(404);
  });

  it("GET response: 204 before the answer, 200 {box} after, 404 for an unknown channel", async () => {
    const { put, post, getRes } = setup();
    await put(ID);
    expect(await getRes(ID)).toEqual({ status: 204 });
    await post(ID, body("answerBox_-09"));
    expect(await getRes(ID)).toEqual({ status: 200, body: body("answerBox_-09") });
    expect((await getRes(ID)).status).toBe(200); // collecting does not consume it
    expect((await getRes("Z".repeat(22))).status).toBe(404);
  });

  it("an answer cannot be posted before the request exists, and a request box is never served as the response", async () => {
    const { put, post, getRes } = setup();
    expect((await post(ID)).status).toBe(404);
    expect((await getRes(ID)).status).toBe(404);
    await put(ID, body("theRequestBox"));
    expect((await getRes(ID)).status).toBe(204);
  });

  it("ids of 22 to 64 characters of [A-Za-z0-9_-] are channels", async () => {
    const { put } = setup();
    expect((await put("a-b_C".repeat(5))).status).toBe(201); // 25
    expect((await put("-".repeat(22))).status).toBe(201);
    expect((await put(newChannelId())).status).toBe(201);
  });
});

describe("opaque boxes", () => {
  it("stores and returns boxes byte for byte, without a key and without caring what is inside", async () => {
    const { put, getReq, post, getRes } = setup();
    // Not a real sealed box at all: the mailbox only looks at size and alphabet.
    const odd = "_-_-AaZz09".repeat(400);
    await put(ID, body(odd));
    expect((await getReq(ID)).body).toBe(body(odd));
    await post(ID, body("0"));
    expect((await getRes(ID)).body).toBe(body("0"));
  });

  it("carries a real sealed box unchanged, which only the key's holder can open", async () => {
    const { put, getReq } = setup();
    const key = newKey();
    const box = await seal(key, "request", { jsonrpc: "2.0", id: "abc", method: "byow_info", params: {} });
    await put(ID, body(box));
    const got = JSON.parse((await getReq(ID)).body!) as { box: string };
    expect(got.box).toBe(box);
    expect(Object.keys(got)).toEqual(["box"]);
  });

  it("accepts a box of exactly the size limit", async () => {
    const { put } = setup();
    expect((await put(ID, body("A".repeat(MAX_BOX_CHARS)))).status).toBe(201);
  });
});

describe("waiting for the answer", () => {
  it("resolves as soon as the answer is posted, not after the full wait", async () => {
    const { put, post, getRes } = setup({ maxWaitMs: 2000 });
    await put(ID);
    const t0 = performance.now();
    const waiting = getRes(ID, 30); // asks for 30 s, capped at 2 s
    setTimeout(() => void post(ID, body("lateButInTime")), 20);
    const r = await waiting;
    const took = performance.now() - t0;
    expect(r).toEqual({ status: 200, body: body("lateButInTime") });
    expect(took).toBeLessThan(500);
  });

  it("returns 204 when nothing arrives, after at most maxWaitMs", async () => {
    const { put, getRes } = setup({ maxWaitMs: 60 });
    await put(ID);
    const t0 = performance.now();
    expect(await getRes(ID, 30)).toEqual({ status: 204 });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(40);
    expect(took).toBeLessThan(400);
  });

  it("answers at once when the answer is already there, and without waiting when wait is absent or zero", async () => {
    const { put, post, getRes } = setup({ maxWaitMs: 5000 });
    await put(ID);
    const t0 = performance.now();
    expect((await getRes(ID)).status).toBe(204);
    expect((await getRes(ID, 0)).status).toBe(204);
    await post(ID);
    expect((await getRes(ID, 30)).status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it("wakes every waiter on the channel", async () => {
    const { put, post, getRes } = setup({ maxWaitMs: 2000 });
    await put(ID);
    const a = getRes(ID, 30);
    const b = getRes(ID, 30);
    setTimeout(() => void post(ID), 15);
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });

  it("an unknown channel is 404 at once, even with a wait", async () => {
    const { getRes } = setup({ maxWaitMs: 5000 });
    const t0 = performance.now();
    expect((await getRes("Z".repeat(22), 30)).status).toBe(404);
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe("expiry", () => {
  it("after ttlMs the channel is gone on every route, and its id can be reused", async () => {
    const { put, getReq, post, getRes, clock, mb } = setup({ ttlMs: 60_000 });
    await put(ID);
    clock.t += 59_999;
    expect((await getReq(ID)).status).toBe(200);
    clock.t += 2;
    expect((await getReq(ID)).status).toBe(404);
    expect((await post(ID)).status).toBe(404);
    expect((await getRes(ID)).status).toBe(404);
    expect((await put(ID, body("secondLife"))).status).toBe(201);
    expect((await getReq(ID)).body).toBe(body("secondLife"));
    expect((await getRes(ID)).status).toBe(204); // the old answer state did not survive
    expect(mb.size()).toBe(1);
  });

  it("an answered channel expires too, and the answer goes with it", async () => {
    const { put, post, getRes, clock } = setup({ ttlMs: 1000 });
    await put(ID);
    await post(ID);
    expect((await getRes(ID)).status).toBe(200);
    clock.t += 1001;
    expect((await getRes(ID)).status).toBe(404);
  });

  it("the default lifetime is about ten minutes", async () => {
    const { put, getReq, clock } = setup();
    await put(ID);
    clock.t += 9 * 60_000;
    expect((await getReq(ID)).status).toBe(200);
    clock.t += 2 * 60_000;
    expect((await getReq(ID)).status).toBe(404);
  });

  it("a reused id after expiry gets a fresh answer slot", async () => {
    const { put, post, getRes, clock } = setup({ ttlMs: 1000 });
    await put(ID);
    await post(ID, body("first"));
    clock.t += 1001;
    await put(ID);
    expect((await post(ID, body("second"))).status).toBe(204);
    expect((await getRes(ID)).body).toBe(body("second"));
  });
});

describe("refusals", () => {
  it("a body that is not {\"box\": base64url} is 400, on PUT and on POST", async () => {
    const { put, post } = setup();
    const bad: Array<string | undefined> = [
      "not json",
      "",
      undefined,
      "{}",
      "null",
      "[]",
      '"just a string"',
      "42",
      JSON.stringify({ box: "" }),
      JSON.stringify({ box: 5 }),
      JSON.stringify({ box: null }),
      JSON.stringify({ box: ["abc"] }),
      JSON.stringify({ box: "has space" }),
      JSON.stringify({ box: "plus+slash/" }),
      JSON.stringify({ box: "padded==" }),
      JSON.stringify({ box: "new\nline" }),
      JSON.stringify({ box: "ünïcode" }),
      JSON.stringify({ Box: "abc" }),
      JSON.stringify({ data: "abc" }),
      body("A".repeat(MAX_BOX_CHARS + 1)),
      "x".repeat(MAX_BOX_CHARS + 1000),
    ];
    for (const b of bad) {
      expect((await put(ID, b)).status, `PUT ${String(b).slice(0, 30)}`).toBe(400);
    }
    expect((await put(ID)).status).toBe(201); // none of those created the channel
    for (const b of bad) {
      expect((await post(ID, b)).status, `POST ${String(b).slice(0, 30)}`).toBe(400);
    }
    expect((await post(ID)).status).toBe(204); // none of those used up the one answer
  });

  it("an id shorter than 22 characters, or with bad characters, is 404 on every route", async () => {
    const { mb } = setup();
    for (const id of ["A".repeat(21), "", "A", "A".repeat(21) + "!", "A".repeat(21) + ".", "A".repeat(21) + "+", "A".repeat(21) + "=", "A".repeat(10) + " " + "A".repeat(11), "../" + "A".repeat(22), "é".repeat(22)]) {
      for (const [method, tail] of [["PUT", "request"], ["GET", "request"], ["POST", "response"], ["GET", "response"]] as const) {
        const r = await mb.handle({ method, path: `/${id}/${tail}`, body: body(BOX) });
        expect(r.status, `${method} /${id}/${tail}`).toBe(404);
      }
    }
    expect(mb.size()).toBe(0);
  });

  it("any other path is 404", async () => {
    const { mb, put } = setup();
    await put(ID);
    for (const path of ["", "/", `/${ID}`, `/${ID}/`, `/${ID}/other`, `/${ID}/request/extra`, `//${ID}/request`, `/${ID}/Request`, `${ID}/request`]) {
      expect((await mb.handle({ method: "GET", path })).status, path).toBe(404);
    }
  });

  it("a wrong method on a route is 405", async () => {
    const { mb, put } = setup();
    await put(ID);
    for (const method of ["DELETE", "PATCH", "POST", "HEAD", "get", "put"]) {
      expect((await mb.handle({ method, path: `/${ID}/request`, body: body(BOX) })).status, `${method} request`).toBe(405);
    }
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
      expect((await mb.handle({ method, path: `/${ID}/response`, body: body(BOX) })).status, `${method} response`).toBe(405);
    }
  });

  it("refuses new channels beyond maxChannels with 503, and takes them again once one expires", async () => {
    const { put, getReq, clock, mb } = setup({ maxChannels: 2, ttlMs: 1000 });
    expect((await put("A".repeat(22))).status).toBe(201);
    clock.t += 600;
    expect((await put("B".repeat(22))).status).toBe(201);
    expect((await put("C".repeat(22))).status).toBe(503);
    expect(mb.size()).toBe(2);
    expect((await getReq("C".repeat(22))).status).toBe(404);
    clock.t += 500; // A has expired, B has not
    expect((await put("C".repeat(22))).status).toBe(201);
    expect(mb.size()).toBe(2);
  });
});

describe("nodeMailbox over a real http server", () => {
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    server = undefined;
  });

  async function serve(base = "/byow", maxWaitMs = 100) {
    const handled: boolean[] = [];
    const handler = nodeMailbox(createMailbox({ maxWaitMs }), base);
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const mine = handler(req, res);
      handled.push(mine);
      if (!mine) {
        res.writeHead(418, { "content-type": "text/plain" });
        res.end("not the mailbox");
      }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, handled };
  }

  it("serves PUT, GET, POST, GET with CORS, and answers a preflight", async () => {
    const { url } = await serve();
    const base = `${url}/byow/${ID}`;
    const json = { "content-type": "application/json" };

    const put = await fetch(`${base}/request`, { method: "PUT", headers: json, body: body(BOX) });
    expect(put.status).toBe(201);
    expect(put.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${base}/request`, { method: "PUT", headers: json, body: body(BOX) })).status).toBe(409);

    const got = await fetch(`${base}/request`);
    expect(got.status).toBe(200);
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
    expect(got.headers.get("content-type")).toContain("application/json");
    expect(await got.json()).toEqual({ box: BOX });

    const early = await fetch(`${base}/response`);
    expect(early.status).toBe(204);
    expect(await early.text()).toBe("");

    const posted = await fetch(`${base}/response`, { method: "POST", headers: json, body: body("theAnswer") });
    expect(posted.status).toBe(204);
    expect((await fetch(`${base}/response`, { method: "POST", headers: json, body: body("again") })).status).toBe(409);

    const answer = await fetch(`${base}/response?wait=5`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ box: "theAnswer" });

    expect((await fetch(`${url}/byow/${"Z".repeat(22)}/request`)).status).toBe(404);
    expect((await fetch(`${url}/byow/${"Q".repeat(22)}/request`, { method: "PUT", headers: json, body: "nope" })).status).toBe(400);
    expect((await fetch(`${base}/request`, { method: "DELETE" })).status).toBe(405);

    const pre = await fetch(`${base}/request`, { method: "OPTIONS", headers: { origin: "https://site.example", "access-control-request-method": "PUT", "access-control-request-headers": "content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/PUT/);
    expect(pre.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
  });

  it("a long poll over http returns when the answer lands", async () => {
    const { url } = await serve("/byow", 1500);
    const base = `${url}/byow/${ID}`;
    await fetch(`${base}/request`, { method: "PUT", body: body(BOX) });
    const t0 = performance.now();
    const waiting = fetch(`${base}/response?wait=30`);
    setTimeout(() => void fetch(`${base}/response`, { method: "POST", body: body("lateAnswer") }), 20);
    const r = await waiting;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ box: "lateAnswer" });
    expect(performance.now() - t0).toBeLessThan(700);
  });

  it("a path outside the base is not handled: it returns false and the server's own handler runs", async () => {
    const { url, handled } = await serve("/byow");
    for (const path of ["/", "/other/x", `/byowx/${ID}/request`, `/by/${ID}/request`, `/${ID}/request`]) {
      const r = await fetch(url + path);
      expect(r.status, path).toBe(418);
      expect(await r.text()).toBe("not the mailbox");
      expect(r.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    expect(handled).toEqual([false, false, false, false, false]);
    // And one inside the base is.
    expect((await fetch(`${url}/byow/${ID}/request`)).status).toBe(404);
    expect(handled.at(-1)).toBe(true);
  });

  it("honours a base given with a trailing slash, and a nested base", async () => {
    const a = await serve("/api/byow/");
    expect((await fetch(`${a.url}/api/byow/${ID}/request`, { method: "PUT", body: body(BOX) })).status).toBe(201);
    expect((await fetch(`${a.url}/api/byow/${ID}/request`)).status).toBe(200);
    expect((await fetch(`${a.url}/byow/${ID}/request`)).status).toBe(418);
  });

  it("an oversized upload is not stored", async () => {
    const { url } = await serve();
    const big = body("A".repeat(MAX_BOX_CHARS + 200));
    const r = await fetch(`${url}/byow/${ID}/request`, { method: "PUT", body: big }).then(
      (x) => x.status,
      () => "connection closed",
    );
    expect(r === 400 || r === "connection closed").toBe(true);
    expect((await fetch(`${url}/byow/${ID}/request`)).status).toBe(404);
  });

  it("keys never come into it: a mailbox given only boxes round-trips a real sealed pair", async () => {
    const { url } = await serve();
    const key = newKey();
    const box = await seal(key, "request", { jsonrpc: "2.0", id: "abc", method: "byow_info", params: {} });
    await fetch(`${url}/byow/${ID}/request`, { method: "PUT", body: body(box) });
    const back = (await (await fetch(`${url}/byow/${ID}/request`)).json()) as { box: string };
    expect(back.box).toBe(box);
  });
});
