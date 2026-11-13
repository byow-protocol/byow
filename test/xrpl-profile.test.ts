import { describe, expect, it } from "vitest";
import { ByowError, type Manifest } from "../src/protocol.js";
import {
  CHALLENGE_RE,
  SIGN_IN_MEMO_TYPE_HEX,
  currencyLabel,
  describeTx,
  formatDrops,
  hasSignInMemo,
  isValidClassicAddress,
  parseConnectResult,
  signInTransaction,
  validateConnectParams,
  validateSignParams,
  xrpl,
} from "../src/xrpl/profile.js";

const A = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const B = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD = "524C555344000000000000000000000000000000";
const PUB = "ED" + "11".repeat(32);
const pay = (over: Record<string, unknown> = {}) => ({ TransactionType: "Payment", Destination: A, Amount: "1000000", ...over });
const sign = (tx: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ chain: "xrpl:1", tx_json: tx, ...extra });
const code = (c: string) => expect.objectContaining({ code: c });
const manifest = (transactions?: Manifest["transactions"]): Manifest => ({ name: "W", versions: ["0.2"], chains: ["xrpl:1"], methods: ["byow_info", "xrpl_signTransaction"], ...(transactions ? { transactions } : {}) });
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

describe("validateConnectParams", () => {
  it("accepts a chain, with or without a challenge", () => {
    expect(validateConnectParams({ chain: "xrpl:0" })).toEqual({ chain: "xrpl:0" });
    expect(validateConnectParams({ chain: "xrpl:1", challenge: "abcDEF_123-xyz" })).toEqual({ chain: "xrpl:1", challenge: "abcDEF_123-xyz" });
  });

  it("accepts only the challenge alphabet [A-Za-z0-9_-], 8 to 128 characters", () => {
    expect(CHALLENGE_RE.source).toBe("^[A-Za-z0-9_-]{8,128}$");
    expect(validateConnectParams({ chain: "xrpl:1", challenge: "x".repeat(8) }).challenge).toHaveLength(8);
    expect(validateConnectParams({ chain: "xrpl:1", challenge: "x".repeat(128) }).challenge).toHaveLength(128);
    for (const c of ["abc 12345", "line\nbreak1", "café-1234", "abc.12345", "abc/12345", "abc+12345", "abc=12345", "", "x".repeat(7), "x".repeat(129), 12345678, null, ["abcdefgh"]]) {
      expect(() => validateConnectParams({ chain: "xrpl:1", challenge: c }), String(c)).toThrow(code("bad_params"));
    }
  });

  it("needs an XRPL chain id in params.chain", () => {
    for (const chain of [undefined, "", "xrpl", "xrpl:", "xrpl:x", "eip155:1", "xrpl:1:2", 1, ["xrpl:1"]]) {
      expect(() => validateConnectParams({ chain }), String(chain)).toThrow(code("bad_params"));
    }
    expect(() => validateConnectParams({ chains: ["xrpl:1"] })).toThrow(ByowError); // the 0.1 shape
    expect(() => validateConnectParams(null)).toThrow(ByowError);
    expect(() => validateConnectParams([{ chain: "xrpl:1" }])).toThrow(ByowError);
  });
});

describe("validateSignParams", () => {
  it("lets the site set any field the wallet could otherwise fill, and Flags, Memos and tags: they are the site's", () => {
    for (const k of ["Account", "Fee", "Sequence", "TicketSequence", "LastLedgerSequence", "NetworkID", "Flags", "SourceTag", "DestinationTag", "AccountTxnID"]) {
      const v = k === "Account" ? A : k === "Fee" ? "12" : 1;
      expect(validateSignParams(sign(pay({ [k]: v }))).tx_json[k], k).toBe(v);
    }
    const Memos = [{ Memo: { MemoType: hex("note"), MemoData: hex("hello") } }];
    expect(validateSignParams(sign(pay({ Memos }))).tx_json.Memos).toEqual(Memos);
    expect(validateSignParams(sign(pay({ Flags: 0, Fee: "12", Sequence: 5, TicketSequence: 9, SourceTag: 2606230007, Memos }))).tx_json).toMatchObject({ Flags: 0, Fee: "12", Sequence: 5, TicketSequence: 9 });
  });

  it("is structural only: it does not pre-reject a type a wallet might support", () => {
    expect(() => validateSignParams(sign({ TransactionType: "OfferCreate" }))).not.toThrow();
    expect(() => validateSignParams(sign({ TransactionType: "NoSuchTypeEither" }))).not.toThrow();
  });

  it("refuses the signature fields, which are always the wallet's", () => {
    for (const k of ["SigningPubKey", "TxnSignature", "Signers"]) {
      expect(() => validateSignParams(sign(pay({ [k]: k === "Signers" ? [] : "AB" }))), k).toThrow(code("bad_params"));
      expect(() => validateSignParams(sign(pay({ [k]: k === "Signers" ? [] : "AB" }))), k).toThrow(new RegExp(k));
    }
  });

  it("refuses a transaction carrying a sign-in memo, in either case of hex", () => {
    const memo = (t: string) => [{ Memo: { MemoType: t, MemoData: hex("{}") } }];
    expect(() => validateSignParams(sign(pay({ Memos: memo(SIGN_IN_MEMO_TYPE_HEX) })))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay({ Memos: memo(SIGN_IN_MEMO_TYPE_HEX.toLowerCase()) })))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay({ Memos: [...memo(hex("other")), ...memo(SIGN_IN_MEMO_TYPE_HEX)] })))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay({ Memos: memo(hex("byow/sign-out")) })))).not.toThrow(); // only that type
  });

  it("names the account with params.account or tx_json.Account, and they must match", () => {
    expect(validateSignParams(sign(pay(), { account: A })).account).toBe(A);
    expect(validateSignParams(sign(pay({ Account: A }))).account).toBe(A);
    expect(validateSignParams(sign(pay({ Account: A }), { account: A })).account).toBe(A);
    expect("account" in validateSignParams(sign(pay()))).toBe(false); // nobody named one: the wallet's own
    expect(() => validateSignParams(sign(pay({ Account: A }), { account: B }))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay(), { account: "nope" }))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay({ Account: "nope" })))).toThrow(code("bad_params"));
  });

  it("submit defaults to true and must be a boolean", () => {
    expect(validateSignParams(sign(pay())).submit).toBe(true);
    expect(validateSignParams(sign(pay(), { submit: true })).submit).toBe(true);
    expect(validateSignParams(sign(pay(), { submit: false })).submit).toBe(false);
    for (const submit of ["false", 0, 1, null]) expect(() => validateSignParams(sign(pay(), { submit })), String(submit)).toThrow(code("bad_params"));
  });

  it("needs an XRPL chain and a tx_json object with a type name", () => {
    expect(() => validateSignParams({ tx_json: pay() })).toThrow(code("bad_params"));
    expect(() => validateSignParams({ chain: "eip155:1", tx_json: pay() })).toThrow(code("bad_params"));
    expect(() => validateSignParams({ chain: "xrpl:1" })).toThrow(code("bad_params"));
    expect(() => validateSignParams({ chain: "xrpl:1", tx_json: [] })).toThrow(code("bad_params"));
    expect(() => validateSignParams({ chain: "xrpl:1", tx: pay() })).toThrow(ByowError); // the 0.1 shape
    expect(() => validateSignParams(null)).toThrow(ByowError);
    expect(() => validateSignParams(sign({ TransactionType: "no spaces" }))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign({ TransactionType: "" }))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign({}))).toThrow(code("bad_params"));
  });

  it("refuses a transaction that is too deep or too large", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 12; i++) deep = [deep];
    expect(() => validateSignParams(sign(pay({ Deep: deep })))).toThrow(code("bad_params"));
    expect(() => validateSignParams(sign(pay({ Many: Array(65).fill(1) })))).toThrow(code("bad_params"));
  });

  it("the profile's validateParams routes by method", () => {
    expect(() => xrpl.validateParams("xrpl_connect", { chain: "xrpl:1" })).not.toThrow();
    expect(() => xrpl.validateParams("xrpl_connect", { chain: "xrpl:1", challenge: "short" })).toThrow(ByowError);
    expect(() => xrpl.validateParams("xrpl_signTransaction", sign(pay()))).not.toThrow();
    expect(() => xrpl.validateParams("xrpl_signTransaction", sign(pay({ TxnSignature: "AB" })))).toThrow(ByowError);
    expect(xrpl.methods).toEqual(["xrpl_connect", "xrpl_signTransaction"]);
  });
});

describe("describeTx: render it or refuse it (the reference kit's policy)", () => {
  it("renders an XRP payment with tags", () => {
    const rows = describeTx(pay({ Amount: "1500000", DestinationTag: 7, SourceTag: 2606230007 }));
    expect(rows.map((r) => r.value)).toEqual(["Send a payment", A, "1.5 XRP", "7", "2606230007"]);
  });

  it("renders an RLUSD payment with its hex currency decoded, and always shows the issuer", () => {
    const rows = describeTx(pay({ Amount: { currency: RLUSD, issuer: B, value: "12.5" } }));
    expect(rows.find((r) => r.label === "Amount")).toMatchObject({ value: "12.5 RLUSD", warn: expect.stringContaining("issuer") });
    expect(rows.find((r) => r.label === "Issuer")?.value).toBe(B);
  });

  it("accepts a Payment with Flags 0 and the site's own Account, and refuses any other Flags", () => {
    expect(() => describeTx(pay({ Flags: 0 }))).not.toThrow();
    expect(() => describeTx(pay({ Account: A }))).not.toThrow();
    for (const Flags of [1, 0x00020000 /* tfPartialPayment */, 0x00010000, 0x80000000]) {
      expect(() => describeTx(pay({ Flags })), String(Flags)).toThrow(code("unsupported_tx"));
    }
  });

  it("refuses anything it cannot explain, as unsupported_tx (the wallet's policy, not a protocol rule)", () => {
    expect(() => describeTx({ TransactionType: "OfferCreate" })).toThrow(/not a transaction/);
    expect(() => describeTx({ TransactionType: "OfferCreate" })).toThrow(code("unsupported_tx"));
    expect(() => describeTx(pay({ Paths: [] }))).toThrow(/Paths/);
    expect(() => describeTx(pay({ SendMax: "1" }))).toThrow(/SendMax/);
    expect(() => describeTx(pay({ Memos: [] }))).toThrow(/Memos/);
  });

  it("a site-set Fee, Sequence, LastLedgerSequence or NetworkID is unsupported_tx by default", () => {
    for (const k of ["Fee", "Sequence", "TicketSequence", "LastLedgerSequence", "NetworkID"]) {
      const v = k === "Fee" ? "12" : 5;
      expect(() => describeTx(pay({ [k]: v })), k).toThrow(code("unsupported_tx"));
      expect(() => describeTx(pay({ [k]: v })), k).toThrow(new RegExp(k));
    }
  });

  it("refuses zero, negative, fractional-drop and absurd amounts", () => {
    for (const Amount of ["0", "-5", "1.5", "123456789012345678", { currency: "USD", issuer: B, value: "0" }, { currency: "USD", issuer: B, value: "1".repeat(20) }]) {
      expect(() => describeTx(pay({ Amount }))).toThrow(ByowError);
    }
  });

  it("flags a token that calls itself XRP", () => {
    const rows = describeTx(pay({ Amount: { currency: "XRP", issuer: B, value: "1" } }));
    expect(rows.find((r) => r.label === "Amount")?.warn).toMatch(/not XRP/);
  });

  it("renders a TrustSet only when the request itself sets Flags 131072 (tfSetNoRipple)", () => {
    const ts = (over: Record<string, unknown> = {}) => ({ TransactionType: "TrustSet", LimitAmount: { currency: "USD", issuer: B, value: "100" }, ...over });
    const rows = describeTx(ts({ Flags: 131072 }));
    expect(rows.map((r) => r.label)).toEqual(["Action", "Token", "Issuer", "Limit", "Rippling"]);
    expect(describeTx(ts({ Flags: 131072, SourceTag: 5 })).at(-1)).toMatchObject({ label: "Source tag", value: "5" });
    // Refused, not fixed: the wallet does not add the flag.
    for (const Flags of [undefined, 0, 0x00040000 /* tfClearNoRipple */, 131072 + 0x00010000, 0x80000000, 131072 + 0x80000000]) {
      expect(() => describeTx(ts({ Flags })), String(Flags)).toThrow(code("unsupported_tx"));
    }
  });
});

describe("formatting", () => {
  it("formats drops without float error", () => {
    expect(formatDrops("1")).toBe("0.000001 XRP");
    expect(formatDrops("100000000000000000")).toBe("100,000,000,000 XRP");
  });
  it("decodes only printable hex currency codes", () => {
    expect(currencyLabel(RLUSD).text).toBe("RLUSD");
    expect(currencyLabel("00" + "FF".repeat(19)).text).toMatch(/^[0-9A-F]{40}$/);
  });
});

describe("the sign-in transaction", () => {
  const stmt = { origin: "https://site.example", chain: "xrpl:1", challenge: "nonce-123456", iat: 1731326400 };

  it("is exactly an empty AccountSet with three locks and one memo, unsigned", () => {
    const tx = signInTransaction({ address: A, publicKey: PUB }, stmt);
    expect(tx).toEqual({
      TransactionType: "AccountSet",
      Account: A,
      Sequence: 0,
      Fee: "0",
      LastLedgerSequence: 1,
      SigningPubKey: PUB,
      Memos: [{ Memo: { MemoType: "62796F772F7369676E2D696E", MemoData: expect.stringMatching(/^[0-9A-F]+$/) } }],
    });
    expect(SIGN_IN_MEMO_TYPE_HEX).toBe("62796F772F7369676E2D696E"); // "byow/sign-in"
    expect("TxnSignature" in tx || "Flags" in tx || "SourceTag" in tx).toBe(false);
  });

  it("carries the statement as UTF-8 JSON in the memo", () => {
    const tx = signInTransaction({ address: A, publicKey: PUB }, stmt) as { Memos: { Memo: { MemoData: string } }[] };
    expect(JSON.parse(Buffer.from(tx.Memos[0]!.Memo.MemoData, "hex").toString("utf8"))).toEqual(stmt);
  });

  it("hasSignInMemo spots it, in either case of hex, among other memos, and nothing else", () => {
    const tx = signInTransaction({ address: A, publicKey: PUB }, stmt);
    expect(hasSignInMemo(tx)).toBe(true);
    const m = (MemoType: string) => ({ Memo: { MemoType, MemoData: "00" } });
    expect(hasSignInMemo({ Memos: [m(SIGN_IN_MEMO_TYPE_HEX.toLowerCase())] })).toBe(true);
    expect(hasSignInMemo({ Memos: [m(hex("other")), m(SIGN_IN_MEMO_TYPE_HEX)] })).toBe(true);
    expect(hasSignInMemo({ Memos: [m(hex("other"))] })).toBe(false);
    expect(hasSignInMemo({ Memos: [] })).toBe(false);
    expect(hasSignInMemo({})).toBe(false);
    expect(hasSignInMemo({ Memos: "byow/sign-in" })).toBe(false);
    expect(hasSignInMemo({ Memos: [null, 5, "x", {}, { Memo: null }, { Memo: { MemoType: 5 } }] })).toBe(false);
  });
});

describe("xrpl.parseResult", () => {
  const hash = "A".repeat(64);
  const sig = { chain: "xrpl:1", tx_json: pay() };
  const con = { chain: "xrpl:1" };
  const pub = "ED" + "ab".repeat(32);

  it("accepts a good sign result and normalises case", () => {
    expect(xrpl.parseResult("xrpl_signTransaction", { tx_blob: "1200ab", hash: hash.toLowerCase(), submitted: false }, sig)).toEqual({ tx_blob: "1200AB", hash, submitted: false });
    expect(xrpl.parseResult("xrpl_signTransaction", { tx_blob: "1200ab", hash, submitted: true, engine_result: "tesSUCCESS" }, sig)).toEqual({ tx_blob: "1200AB", hash, submitted: true, engine_result: "tesSUCCESS" });
  });

  it("rejects malformed sign results", () => {
    const ok = { tx_blob: "1200AB", hash, submitted: true };
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, tx_blob: "zz" }, sig)).toThrow(code("invalid_response"));
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, tx_blob: "123" }, sig)).toThrow(ByowError);
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, tx_blob: undefined }, sig)).toThrow(ByowError);
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, hash: "short" }, sig)).toThrow(ByowError);
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, submitted: "yes" }, sig)).toThrow(ByowError);
    expect(() => xrpl.parseResult("xrpl_signTransaction", { tx_blob: ok.tx_blob, hash }, sig)).toThrow(ByowError); // submitted is required
    expect(() => xrpl.parseResult("xrpl_signTransaction", { ...ok, engine_result: "<script>" }, sig)).toThrow(ByowError);
    expect(() => xrpl.parseResult("xrpl_signTransaction", "nope", sig)).toThrow(ByowError);
  });

  it("accepts a good connect result, with and without a proof", () => {
    expect(xrpl.parseResult("xrpl_connect", { address: A, publicKey: pub.toLowerCase() }, con)).toEqual({ address: A, publicKey: pub.toUpperCase() });
    expect(parseConnectResult({ address: A, publicKey: pub, proof: "12ab" }, { chain: "xrpl:1", challenge: "abcdefgh" })).toEqual({ address: A, publicKey: pub.toUpperCase(), proof: "12AB" });
  });

  it("requires a proof when a challenge was sent: an answer without one is not an answer", () => {
    expect(() => parseConnectResult({ address: A, publicKey: pub }, { chain: "xrpl:1", challenge: "abcdefgh" })).toThrow(/no proof/);
    expect(() => xrpl.parseResult("xrpl_connect", { address: A, publicKey: pub }, { chain: "xrpl:1", challenge: "abcdefgh" })).toThrow(code("invalid_response"));
  });

  it("rejects a malformed address, key or proof", () => {
    expect(() => parseConnectResult({ address: "0xdeadbeef", publicKey: pub }, con)).toThrow(/XRPL address/);
    expect(() => parseConnectResult({ address: A, publicKey: "ED12" }, con)).toThrow(/publicKey/);
    expect(() => parseConnectResult({ address: A, publicKey: pub + "00" }, con)).toThrow(/publicKey/);
    expect(() => parseConnectResult({ address: A, publicKey: pub, proof: "zz" }, { chain: "xrpl:1", challenge: "abcdefgh" })).toThrow(ByowError);
    expect(() => parseConnectResult({ address: A, publicKey: pub, proof: 5 }, { chain: "xrpl:1", challenge: "abcdefgh" })).toThrow(ByowError);
    expect(() => parseConnectResult({ accounts: [{ chain: "xrpl:1", address: A }] }, con)).toThrow(ByowError); // the 0.1 shape
    expect(() => parseConnectResult(null, con)).toThrow(ByowError);
  });
});

describe("xrpl.preflight: refuse before any UI when the manifest already says no", () => {
  const params = (type: string) => sign({ TransactionType: type });

  it("throws unsupported_tx when the manifest's list lacks the type", () => {
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("OfferCreate"), manifest({ xrpl: ["Payment", "TrustSet"] }))).toThrow(code("unsupported_tx"));
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("Payment"), manifest({ xrpl: ["TrustSet"] }))).toThrow(code("unsupported_tx"));
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("Payment"), manifest({ xrpl: [] }))).toThrow(code("unsupported_tx"));
  });

  it("does nothing when the type is listed, for \"*\", when the list is absent, or for another family's list", () => {
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("Payment"), manifest({ xrpl: ["Payment"] }))).not.toThrow();
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("OfferCreate"), manifest({ xrpl: "*" }))).not.toThrow();
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("OfferCreate"), manifest())).not.toThrow(); // absent means unknown: the site finds out by asking
    expect(() => xrpl.preflight!("xrpl_signTransaction", params("OfferCreate"), manifest({ eip155: ["eth_sendTransaction"] }))).not.toThrow();
  });

  it("only concerns signing", () => {
    expect(() => xrpl.preflight!("xrpl_connect", { chain: "xrpl:1" }, manifest({ xrpl: [] }))).not.toThrow();
  });
});

describe("review findings: profile regressions", () => {
  it("validates the address checksum, not just the shape", async () => {
    expect(await isValidClassicAddress(A)).toBe(true);
    expect(await isValidClassicAddress(B)).toBe(true);
    expect(await isValidClassicAddress(A.slice(0, -1) + (A.endsWith("e") ? "d" : "e"))).toBe(false);
    expect(await isValidClassicAddress("r" + "1".repeat(25))).toBe(false);
    expect(await isValidClassicAddress("0xdeadbeef")).toBe(false);
  });

  it("flags XRP in any case and hex that decodes to XRP", () => {
    for (const code of ["xrp", "Xrp", "XRP", "5852500000000000000000000000000000000000"]) {
      expect(currencyLabel(code).warn, code).toMatch(/not XRP/);
    }
  });

  it("never puts a sentence from a hex currency code into the Amount row", () => {
    const sentence = Buffer.from("5 (fee refunded) USD").toString("hex").toUpperCase().padEnd(40, "0");
    const c = currencyLabel(sentence);
    expect(c.text).toBe(sentence); // shown as raw hex
    expect(c.warn).toMatch(/Unreadable/);
  });
});
