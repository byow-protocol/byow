// The link grammar (SPEC 8.1, 8.2) and sealing (8.4), underneath the carriers: base64url, parse and format,
// delivery origin, and the AES-GCM box.

import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ByowError, rpcError, rpcRequest, rpcResult } from "../src/protocol.js";
import { MAX_LINK_CHARS, deliveryOrigin, formatAnswerLink, formatRequestLink, fromBase64Url, hasLink, newChannelId, newKey, open, parseLink, seal, toBase64Url, type RequestLink } from "../src/link.js";

const REQ = rpcRequest("req_0123456789abcdef", "xrpl_connect", { chain: "xrpl:1", challenge: "nonce_0123456789" });
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const b64 = (v: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(v)));
const MAILBOX = "https://site.example/byow/Xy3aBcDeFgHiJkLmNoPqRs";

/** The code a parse refusal carries. */
const refusal = (text: string): unknown => {
  try {
    parseLink(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ByowError);
    return (e as ByowError).code;
  }
  return "did not throw";
};
const asRequest = (text: string): RequestLink => {
  const l = parseLink(text);
  if (l.kind !== "request") throw new Error("expected a request link");
  return l;
};

describe("base64url", () => {
  it("round-trips arbitrary bytes, including all 256 values and every length mod 3", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64Url(toBase64Url(all))).toEqual(all);
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const t = toBase64Url(b);
      expect(t).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(t)).toEqual(b);
    }
    expect(fromBase64Url(toBase64Url(new Uint8Array(70_000).fill(0xff)))?.length).toBe(70_000); // past the 0x8000 chunk
  });

  it("uses the URL-safe alphabet and no padding (RFC 4648 section 5)", () => {
    expect(toBase64Url(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
    expect(toBase64Url(new TextEncoder().encode("fo"))).toBe("Zm8");
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(toBase64Url(new Uint8Array(0))).toBe("");
  });

  it("decodes strictly", () => {
    expect(fromBase64Url("")).toEqual(new Uint8Array(0));
    expect(fromBase64Url("Zm8")).toEqual(new TextEncoder().encode("fo"));
    for (const bad of ["+_8", "-/8", "Zm8=", "Zm8==", "Zm 8", "Zm8\n", " Zm8", "Zm\t8", "AAAAA", "A", "AB", "Zm9", "Zm9vYmF"]) {
      expect(fromBase64Url(bad), JSON.stringify(bad)).toBeNull();
    }
    // "AB" is 12 bits for 1 byte with the 4 spare bits set: a second spelling of 0x00, whose only spelling is "AA".
    expect(fromBase64Url("AA")).toEqual(Uint8Array.of(0));
  });
});

describe("request links", () => {
  it("round-trips an inline request, with and without a return URL and an expiry", () => {
    const bare = formatRequestLink({ request: REQ });
    expect(bare.startsWith("byow:v=0.2&q=")).toBe(true);
    expect(parseLink(bare)).toEqual({ kind: "request", version: "0.2", request: REQ });

    const full = formatRequestLink({ request: REQ, returnUrl: "https://site.example/return", expires: 1731327000 });
    expect(asRequest(full)).toEqual({ kind: "request", version: "0.2", request: REQ, returnUrl: "https://site.example/return", expires: 1731327000 });
  });

  it("round-trips a mailbox link: c and k, with the key's exact bytes", () => {
    const text = formatRequestLink({ mailbox: MAILBOX, key: KEY, expires: 1731327000 });
    expect(text).toContain("c=" + encodeURIComponent(MAILBOX));
    expect(text).toContain("k=" + toBase64Url(KEY));
    expect(text).not.toContain("q=");
    expect(asRequest(text)).toEqual({ kind: "request", version: "0.2", mailbox: MAILBOX, key: KEY, expires: 1731327000 });
    expect(asRequest(formatRequestLink({ mailbox: MAILBOX, key: KEY, returnUrl: "https://site.example/r" })).returnUrl).toBe("https://site.example/r");
  });

  it("carries the same link in the fragment of an https URL, query string intact", () => {
    for (const via of ["https://wallet.example/.well-known/byow", "https://site.example/checkout?cart=7&x=%23y"]) {
      const text = formatRequestLink({ request: REQ, returnUrl: "https://site.example/return" }, via);
      expect(text.startsWith(via + "#byow:v=0.2&")).toBe(true);
      expect(hasLink(text)).toBe(true);
      expect(asRequest(text).request).toEqual(REQ);
    }
    const viaMailbox = formatRequestLink({ mailbox: MAILBOX, key: KEY }, "https://wallet.example/");
    expect(asRequest(viaMailbox).key).toEqual(KEY);
  });

  it("refuses to write a request link that carries neither a request nor a mailbox with its key", () => {
    expect(() => formatRequestLink({})).toThrow(ByowError);
    expect(() => formatRequestLink({ mailbox: MAILBOX })).toThrow(ByowError);
    expect(() => formatRequestLink({ key: KEY })).toThrow(ByowError);
  });

  it("refuses to write a link that is not usable: bad mailbox, return or carrying URL, or over the limit", () => {
    expect(() => formatRequestLink({ mailbox: "http://site.example/byow/x", key: KEY })).toThrow(ByowError);
    expect(() => formatRequestLink({ request: REQ, returnUrl: "https://site.example/r#frag" })).toThrow(ByowError);
    expect(() => formatRequestLink({ request: REQ }, "https://wallet.example/#already")).toThrow(ByowError);
    expect(() => formatRequestLink({ request: REQ }, "http://wallet.example/")).toThrow(ByowError);
    const big = rpcRequest("big", "xrpl_signTransaction", { blob: "x".repeat(MAX_LINK_CHARS) });
    expect(() => formatRequestLink({ request: big })).toThrow(ByowError);
  });

  it("allows http on localhost, and only there, for c and r", () => {
    for (const host of ["localhost:8080", "127.0.0.1:3000", "[::1]:3000", "localhost"]) {
      const l = asRequest(formatRequestLink({ mailbox: `http://${host}/byow/Xy3aBcDeFgHiJkLmNoPqRs`, key: KEY, returnUrl: `http://${host}/return` }));
      expect(l.mailbox).toBe(`http://${host}/byow/Xy3aBcDeFgHiJkLmNoPqRs`.replace(/\/$/, ""));
      expect(l.returnUrl).toBe(new URL(`http://${host}/return`).href);
    }
    const k = toBase64Url(KEY);
    for (const host of ["site.example", "localhost.evil.example", "foo.localhost", "127.0.0.2", "10.0.0.1"]) {
      expect(refusal(`byow:v=0.2&c=${encodeURIComponent(`http://${host}/b/Xy3aBcDeFgHiJkLmNoPqRs`)}&k=${k}`), host).toBe("bad_request");
      expect(refusal(`byow:v=0.2&q=${b64(REQ)}&r=${encodeURIComponent(`http://${host}/r`)}`), host).toBe("bad_request");
    }
  });

  it("ignores an unknown parameter, and reads a standalone link and a trimmed one the same", () => {
    const text = formatRequestLink({ request: REQ });
    expect(parseLink(text + "&zz=whatever&x_future=1")).toEqual(parseLink(text));
    expect(parseLink(`  ${text}\n`)).toEqual(parseLink(text));
  });

  it("floors a fractional expiry", () => {
    expect(asRequest(formatRequestLink({ request: REQ, expires: 1731327000.9 })).expires).toBe(1731327000);
  });

  it("percent-decodes parameter values", () => {
    const l = asRequest(`byow:v=0.2&q=${b64(REQ)}&r=${encodeURIComponent("https://site.example/return?a=1&b=2")}`);
    expect(l.returnUrl).toBe("https://site.example/return?a=1&b=2");
  });
});

describe("parseLink refusals", () => {
  const q = b64(REQ);
  const k = toBase64Url(KEY);
  const c = encodeURIComponent(MAILBOX);

  it("refuses text with no byow: part", () => {
    for (const t of ["", "hello", "https://wallet.example/#v=0.2&q=" + q, "https://wallet.example/?byow:v=0.2&q=" + q, "byow-v=0.2&q=" + q, "BYOW:v=0.2&q=" + q, "xbyow:v=0.2&q=" + q, "byow:"]) {
      expect(refusal(t), JSON.stringify(t)).toBe("bad_request");
    }
  });

  it("refuses a missing or malformed v as bad_request, and an unsupported one as unsupported_version", () => {
    expect(refusal(`byow:q=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=&q=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=abc&q=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=9.9&q=${q}`)).toBe("unsupported_version");
    expect(refusal(`byow:v=0.1&q=${q}`)).toBe("unsupported_version");
    expect(refusal(`byow:v=0.10&q=${q}`)).toBe("unsupported_version");
    expect(refusal(`byow:v=9.9&c=${c}&k=${k}`)).toBe("unsupported_version");
    expect(refusal(`byow:v=9.9&a=${q}`)).toBe("unsupported_version");
  });

  it("needs exactly one of q, c and a", () => {
    expect(refusal(`byow:v=0.2`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&r=${encodeURIComponent("https://site.example/r")}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&c=${c}&k=${k}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&a=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&c=${c}&k=${k}&a=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&c=${c}&a=${q}&k=${k}`)).toBe("bad_request");
  });

  it("needs k with c, and k must be 32 bytes in canonical base64url", () => {
    expect(refusal(`byow:v=0.2&c=${c}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&c=${c}&k=`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&c=${c}&k=${toBase64Url(KEY.subarray(0, 16))}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&c=${c}&k=${toBase64Url(new Uint8Array(33))}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&c=${c}&k=${k}%3D`)).toBe("bad_request"); // padded
    expect(refusal(`byow:v=0.2&c=${c}&k=${"!".repeat(43)}`)).toBe("bad_request");
  });

  it("holds c and r to https (or http on localhost), no credentials, no fragment", () => {
    const bad = ["http://site.example/b/Xy3aBcDeFgHiJkLmNoPqRs", "ftp://site.example/b", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@site.example/b", "https://user@site.example/b", "https://site.example/b#frag", "not a url", "//site.example/b", "/b", ""];
    for (const u of bad) {
      expect(refusal(`byow:v=0.2&c=${encodeURIComponent(u)}&k=${k}`), "c " + u).toBe("bad_request");
      expect(refusal(`byow:v=0.2&q=${q}&r=${encodeURIComponent(u)}`), "r " + u).toBe("bad_request");
    }
  });

  // URL.hash is "" for a bare trailing "#", so a check on it alone would let `https://site.example/b#` through.
  it("refuses a c or r with an empty fragment (a bare trailing #)", () => {
    expect(refusal(`byow:v=0.2&c=${encodeURIComponent("https://site.example/b/Xy3aBcDeFgHiJkLmNoPqRs#")}&k=${k}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&r=${encodeURIComponent("https://site.example/r#")}`)).toBe("bad_request");
  });

  it("refuses a duplicated parameter, even an unknown or identical one", () => {
    expect(refusal(`byow:v=0.2&v=0.2&q=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&q=${q}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&e=1&e=2`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&r=${encodeURIComponent("https://a.example/r")}&r=${encodeURIComponent("https://b.example/r")}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&zz=1&zz=2`)).toBe("bad_request");
  });

  it("refuses a q that is not a request", () => {
    expect(refusal(`byow:v=0.2&q=${b64(rpcResult("abc", { ok: true }))}`)).toBe("bad_request"); // a response
    expect(refusal(`byow:v=0.2&q=${b64(rpcError("abc", { code: "busy", message: "x" }))}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${b64({ hello: "world" })}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${b64([1, 2])}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${b64("just a string")}`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${b64({ jsonrpc: "2.0", method: "byow_info", params: {} })}`)).toBe("bad_request"); // no id
    expect(refusal(`byow:v=0.2&q=${b64({ jsonrpc: "2.0", id: "abc", method: "x", params: [1] })}`)).toBe("bad_request"); // positional params
    expect(refusal(`byow:v=0.2&q=junk`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=%21%21%21`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}=`)).toBe("bad_request"); // padded
    expect(refusal(`byow:v=0.2&q=`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${toBase64Url(Uint8Array.of(0xff, 0xfe, 0xfd))}`)).toBe("bad_request"); // not UTF-8
  });

  it("refuses malformed percent-encoding and a parameter with no name or no =", () => {
    expect(refusal(`byow:v=0.2&q=${q}&r=%E0%A4%A`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&r=%ZZ`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&novalue`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&q=${q}&=x`)).toBe("bad_request");
    expect(refusal(`byow:v=0.2&&q=${q}`)).toBe("bad_request");
  });

  it("needs e to be unix seconds", () => {
    for (const e of ["abc", "", "-5", "1.5", "1e9", "0x10", " 12", "12 ", "1731327000000000000000", "NaN"]) {
      expect(refusal(`byow:v=0.2&q=${q}&e=${encodeURIComponent(e)}`), JSON.stringify(e)).toBe("bad_request");
    }
    expect(asRequest(`byow:v=0.2&q=${q}&e=0`).expires).toBe(0);
    expect(asRequest(`byow:v=0.2&q=${q}&e=1731327000`).expires).toBe(1731327000);
  });

  it("refuses a link longer than 64 KiB", () => {
    expect(MAX_LINK_CHARS).toBe(64 * 1024);
    expect(refusal(`byow:v=0.2&q=${q}&pad=${"x".repeat(MAX_LINK_CHARS)}`)).toBe("bad_request");
    const ok = `byow:v=0.2&q=${q}&pad=`;
    expect(parseLink(ok + "x".repeat(MAX_LINK_CHARS - ok.length)).kind).toBe("request"); // exactly at the limit
    expect(refusal(ok + "x".repeat(MAX_LINK_CHARS - ok.length + 1))).toBe("bad_request");
  });
});

describe("answer links", () => {
  const RETURN = "https://site.example/return";

  it("writes <returnUrl>#byow:v=...&a=... and reads it back as an answer with the same message", () => {
    for (const response of [rpcResult("abc123", { address: "rXXX", n: 1 }), rpcError("abc123", { code: "user_rejected", message: "The user declined." })]) {
      const text = formatAnswerLink(RETURN, response);
      expect(text.startsWith(RETURN + "#byow:v=0.2&a=")).toBe(true);
      expect(hasLink(text)).toBe(true);
      expect(parseLink(text)).toEqual({ kind: "answer", version: "0.2", message: response });
    }
  });

  it("keeps the return URL's query string before the fragment", () => {
    const text = formatAnswerLink("https://site.example/return?t=1", rpcResult("abc", 1));
    expect(text.startsWith("https://site.example/return?t=1#byow:")).toBe(true);
    expect(parseLink(text).kind).toBe("answer");
  });

  it("refuses a return URL with a fragment, one that is not https, one with credentials, and an answer too large", () => {
    expect(() => formatAnswerLink(RETURN + "#x", rpcResult("abc", 1))).toThrow(ByowError);
    expect(() => formatAnswerLink("http://site.example/return", rpcResult("abc", 1))).toThrow(ByowError);
    expect(() => formatAnswerLink("https://u:p@site.example/return", rpcResult("abc", 1))).toThrow(ByowError);
    expect(() => formatAnswerLink(RETURN, rpcResult("abc", "x".repeat(MAX_LINK_CHARS)))).toThrow(ByowError);
    expect(formatAnswerLink("http://localhost:3000/return", rpcResult("abc", 1))).toContain("#byow:");
  });

  it("an answer that does not decode is refused, and an answer's message is not interpreted here", () => {
    expect(refusal("byow:v=0.2&a=junk")).toBe("bad_request");
    expect(refusal("byow:v=0.2&a=")).toBe("bad_request");
    expect(parseLink(`byow:v=0.2&a=${b64({ anything: "goes" })}`)).toEqual({ kind: "answer", version: "0.2", message: { anything: "goes" } });
  });
});

describe("deliveryOrigin and hasLink", () => {
  const base: RequestLink = { kind: "request", version: "0.2" };

  it("the mailbox's origin wins over the return URL's", () => {
    expect(deliveryOrigin({ ...base, mailbox: "https://mail.example/byow/abc", returnUrl: "https://site.example/return" })).toBe("https://mail.example");
  });
  it("the return URL's origin when there is no mailbox, and nobody's when there is neither", () => {
    expect(deliveryOrigin({ ...base, returnUrl: "https://site.example:8443/return?x=1" })).toBe("https://site.example:8443");
    expect(deliveryOrigin({ ...base, request: REQ })).toBeNull();
    expect(deliveryOrigin(asRequest(formatRequestLink({ request: REQ })))).toBeNull();
    expect(deliveryOrigin(asRequest(formatRequestLink({ mailbox: MAILBOX, key: KEY })))).toBe("https://site.example");
  });

  it("hasLink says whether text is, or carries, a link", () => {
    expect(hasLink("byow:v=0.2&q=abc")).toBe(true);
    expect(hasLink("https://wallet.example/.well-known/byow#byow:v=0.2&q=abc")).toBe(true);
    expect(hasLink("https://wallet.example/#byow:")).toBe(true);
    expect(hasLink("")).toBe(false);
    expect(hasLink("https://wallet.example/")).toBe(false);
    expect(hasLink("https://wallet.example/byow:v=0.2")).toBe(false);
    expect(hasLink("https://wallet.example/?byow:v=0.2")).toBe(false);
    expect(hasLink("hello byow:v=0.2")).toBe(false);
    expect(hasLink("byow")).toBe(false);
  });
});

describe("sealing", () => {
  const MSG = { jsonrpc: "2.0", id: "vector", method: "byow_info", params: {} };
  const NONCE = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
  // Pinned: AES-256-GCM, key 0x00..0x1f, nonce 0xa0..0xab, AAD "byow/request", plaintext = JSON text of MSG,
  // box = base64url(nonce || ciphertext || 16-byte tag). Computed once with node:crypto, independent of src/link.ts.
  const VECTOR = "oKGio6SlpqeoqaqrnToWXiqlcM8BR73xNVTw_FyOMHSwjWAa-W1S6Q2JWSO_EzOXwEZxB33-fad-JeqXIXRkZECgewwgM3h8ngv4zfpSLPsUImuMhp4vpPu_5cI";

  it("opens what it sealed", async () => {
    const key = newKey();
    expect(await open(key, "request", await seal(key, "request", REQ))).toEqual(REQ);
    expect(await open(key, "response", await seal(key, "response", rpcResult("abc", { é: "ü", n: [1, 2] })))).toEqual(rpcResult("abc", { é: "ü", n: [1, 2] }));
  });

  it("returns undefined for the wrong direction, a different key, one flipped character, or a truncated box", async () => {
    const key = newKey();
    const box = await seal(key, "request", REQ);
    expect(await open(key, "response", box)).toBeUndefined();
    expect(await open(newKey(), "request", box)).toBeUndefined();
    const mid = Math.floor(box.length / 2);
    const flipped = box.slice(0, mid) + (box[mid] === "A" ? "B" : "A") + box.slice(mid + 1);
    expect(await open(key, "request", flipped)).toBeUndefined();
    expect(await open(key, "request", box.slice(0, -4))).toBeUndefined();
    expect(await open(key, "request", box.slice(0, 20))).toBeUndefined();
    expect(await open(key, "request", box + "AAAA")).toBeUndefined();
    expect(await open(key, "request", "")).toBeUndefined();
    expect(await open(key, "request", box)).toEqual(REQ); // the original was never touched
  });

  it("flipping any single character of the box breaks it", async () => {
    const key = newKey();
    const box = await seal(key, "request", { jsonrpc: "2.0", id: "abc", method: "x", params: {} });
    for (let i = 0; i < box.length; i++) {
      const other = box[i] === "A" ? "B" : "A";
      expect(await open(key, "request", box.slice(0, i) + other + box.slice(i + 1)), `char ${i}`).toBeUndefined();
    }
  });

  it("returns undefined for a box that is not a string, is not base64url, or is too large", async () => {
    const key = newKey();
    for (const bad of [undefined, null, 5, {}, ["a"], "not base64url!", "AA==", "a+b/c", "x".repeat(600 * 1024)]) {
      expect(await open(key, "request", bad)).toBeUndefined();
    }
  });

  it("returns undefined, not an exception, for a key that is not 32 bytes", async () => {
    const box = await seal(KEY, "request", REQ);
    expect(await open(KEY.subarray(0, 16), "request", box)).toBeUndefined();
    expect(await open(new Uint8Array(0), "request", box)).toBeUndefined();
  });

  it("two seals of one message differ (random nonce) and both open", async () => {
    const key = newKey();
    const [a, b] = [await seal(key, "request", REQ), await seal(key, "request", REQ)];
    expect(a).not.toBe(b);
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16)); // the nonce is the first 12 bytes
    expect(await open(key, "request", a)).toEqual(await open(key, "request", b));
  });

  it("a fixed nonce gives a deterministic box, matching the pinned vector and an independent AES-GCM", async () => {
    const box = await seal(KEY, "request", MSG, NONCE);
    expect(box).toBe(VECTOR);
    expect(await seal(KEY, "request", MSG, NONCE)).toBe(VECTOR);

    // Layout: nonce || ciphertext || tag, AAD "byow/request".
    const bytes = fromBase64Url(VECTOR)!;
    expect(bytes.subarray(0, 12)).toEqual(NONCE);
    const c = createCipheriv("aes-256-gcm", KEY, NONCE);
    c.setAAD(Buffer.from("byow/request"));
    const expected = Buffer.concat([c.update(JSON.stringify(MSG)), c.final(), c.getAuthTag()]);
    expect(Buffer.from(bytes.subarray(12))).toEqual(expected);

    expect(await open(KEY, "request", VECTOR)).toEqual(MSG);
    expect(await open(KEY, "response", VECTOR)).toBeUndefined();
    // The same message sealed as a response differs only by the direction it is bound to.
    expect(await seal(KEY, "response", MSG, NONCE)).not.toBe(VECTOR);
  });

  it("rejects a key that is not 32 bytes, and a nonce that is not 12", async () => {
    await expect(seal(new Uint8Array(16), "request", REQ)).rejects.toBeInstanceOf(ByowError);
    await expect(seal(new Uint8Array(33), "request", REQ)).rejects.toBeInstanceOf(ByowError);
    await expect(seal(new Uint8Array(0), "request", REQ)).rejects.toBeInstanceOf(ByowError);
    await expect(seal(KEY, "request", REQ, new Uint8Array(8))).rejects.toBeInstanceOf(ByowError);
  });

  it("newChannelId is 22 URL-safe characters and never repeats; newKey is 32 random bytes", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newChannelId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
    const k1 = newKey();
    expect(k1).toBeInstanceOf(Uint8Array);
    expect(k1.length).toBe(32);
    expect(newKey()).not.toEqual(k1);
  });
});
