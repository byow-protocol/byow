import { Wallet, hashes } from "xrpl";
import { decode, encode } from "ripple-binary-codec";
import { describe, expect, it, vi } from "vitest";
import { ByowError } from "../src/protocol.js";
import { createWalletCore, createWalletServer } from "../src/wallet/index.js";
import { describeTx, signInTransaction, type Row } from "../src/xrpl/profile.js";
import { seedSigner } from "../src/xrpl/signer.js";
import { xrplHandlers, type XrplNetwork, type XrplReview } from "../src/xrpl/wallet.js";
import { checkSignedPayment, checkSignedTx, keyMayActFor, keyMayActForAccount, verifySignIn, xrplVerified } from "../src/xrpl/verify.js";

// Public test seeds only: the XRPL docs' ed25519 example and the genesis secp256k1 seed.
const ED = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");
const SECP = Wallet.fromSeed("snoPBrXtMeMyMHUVTgbuqAfg1SUTb");
const ED_SEED = "sEdTM1uX8pu2do5XvTnutH6HsouMaM2";

const ORIGIN = "https://site.example";
const CHAIN = "xrpl:1";
const NONCE = "nonce-123456";
const NOW = 1731326400_000;
const RLUSD = "524C555344000000000000000000000000000000";
const platform = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const issuer = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
// Wire integers (SPEC 3).
const E = { bad_params: -32602, internal: -32603, user_rejected: 4001, wrong_account: 4101, unsupported_tx: 4301 };
const hashOf = (blob: string) => hashes.hashSignedTx(blob);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const memoOf = (type: string, data: string) => ({ Memo: { MemoType: hex(type), MemoData: hex(data) } });

// ---------------------------------------------------------------------------------------------
// Sign-in

const want = (over: Record<string, unknown> = {}) => ({ origin: ORIGIN, chain: CHAIN, challenge: NONCE, now: NOW, ...over });

/** A sign-in transaction as a wallet would mint it, then edited by `over` (undefined deletes) and signed by `w`. */
function signIn(w: Wallet, over: Record<string, unknown> = {}, statement: Record<string, unknown> = {}): string {
  const tx: Record<string, unknown> = { ...signInTransaction({ address: w.classicAddress, publicKey: w.publicKey }, { origin: ORIGIN, chain: CHAIN, challenge: NONCE, iat: NOW / 1000, ...statement }), ...over };
  for (const k of Object.keys(over)) if (over[k] === undefined) delete tx[k];
  return w.sign(tx as never).tx_blob;
}

describe.each([
  ["ed25519", ED],
  ["secp256k1", SECP],
])("verifySignIn (%s key)", (_name, w) => {
  const ok = () => signIn(w);

  it("accepts a real proof, and says whose key signed", () => {
    const r = verifySignIn(ok(), want());
    expect(r).toEqual({ ok: true, address: w.classicAddress, publicKey: w.publicKey.toUpperCase(), masterKey: true, iat: NOW / 1000 });
  });

  it("is the transaction that can never apply", () => {
    const tx = decode(ok()) as Record<string, unknown>;
    expect(tx).toMatchObject({ TransactionType: "AccountSet", Sequence: 0, Fee: "0", LastLedgerSequence: 1 });
  });

  it("refuses another origin (including the same host on another port), chain or challenge", () => {
    expect(verifySignIn(ok(), want({ origin: "https://other.example" }))).toMatchObject({ ok: false, reason: expect.stringContaining("origin") });
    expect(verifySignIn(ok(), want({ origin: "https://site.example:8443" })).ok).toBe(false);
    expect(verifySignIn(ok(), want({ origin: "http://site.example" })).ok).toBe(false);
    expect(verifySignIn(ok(), want({ chain: "xrpl:0" }))).toMatchObject({ ok: false, reason: expect.stringContaining("chain") });
    expect(verifySignIn(ok(), want({ challenge: "nonce-999999" }))).toMatchObject({ ok: false, reason: expect.stringContaining("challenge") });
  });

  it("accepts any of a site's own origins when it lists them, and still nothing else", () => {
    expect(verifySignIn(ok(), want({ origin: ["https://www.site.example", ORIGIN] })).ok).toBe(true);
    expect(verifySignIn(ok(), want({ origin: ["https://www.site.example"] }))).toMatchObject({ ok: false, reason: expect.stringContaining("origin") });
    expect(verifySignIn(ok(), want({ origin: [] })).ok).toBe(false);
    // A statement whose origin is not a string never matches, even a list that would stringify to it.
    expect(verifySignIn(signIn(w, {}, { origin: [ORIGIN] }), want({ origin: [ORIGIN] })).ok).toBe(false);
  });

  it("refuses a proof that is too old, and one from the future", () => {
    expect(verifySignIn(signIn(w, {}, { iat: NOW / 1000 - 599 }), want()).ok).toBe(true);
    expect(verifySignIn(signIn(w, {}, { iat: NOW / 1000 - 601 }), want())).toMatchObject({ ok: false, reason: expect.stringContaining("old") });
    expect(verifySignIn(signIn(w, {}, { iat: NOW / 1000 + 3600 }), want())).toMatchObject({ ok: false, reason: expect.stringContaining("future") });
    // The limit is the verifier's to set.
    expect(verifySignIn(signIn(w, {}, { iat: NOW / 1000 - 3000 }), want({ maxAgeSeconds: 3600 })).ok).toBe(true);
    expect(verifySignIn(signIn(w, {}, { iat: NOW / 1000 - 61 }), want({ maxAgeSeconds: 60 })).ok).toBe(false);
  });

  it("refuses a statement with no usable time", () => {
    const withData = (data: string) => signIn(w, { Memos: [{ Memo: { MemoType: hex("byow/sign-in"), MemoData: hex(data) } }] });
    const good = { origin: ORIGIN, chain: CHAIN, challenge: NONCE };
    expect(verifySignIn(withData(JSON.stringify(good)), want()).ok).toBe(false);
    expect(verifySignIn(withData(JSON.stringify({ ...good, iat: "1731326400" })), want()).ok).toBe(false);
    expect(verifySignIn(withData(JSON.stringify({ ...good, iat: 1.5 })), want()).ok).toBe(false);
    expect(verifySignIn(withData(JSON.stringify({ ...good, iat: NOW / 1000 })), want()).ok).toBe(true); // control: the same, with a time
  });

  it("refuses a statement that is not a JSON object", () => {
    const withData = (data: string) => signIn(w, { Memos: [{ Memo: { MemoType: hex("byow/sign-in"), MemoData: hex(data) } }] });
    for (const data of ["not json", "[]", "null", "42", '"str"']) expect(verifySignIn(withData(data), want()).ok, data).toBe(false);
    expect(verifySignIn(signIn(w, { Memos: [{ Memo: { MemoType: hex("byow/sign-in"), MemoData: "FF" } }] }), want()).ok).toBe(false); // invalid UTF-8
  });

  it("refuses an extra field: it might be a transaction that does something", () => {
    for (const extra of [{ SourceTag: 1 }, { Domain: hex("a.example") }, { DestinationTag: 5 }, { Flags: 1 }, { Flags: 0x00020000 }, { NetworkID: 1 }, { AccountTxnID: "AA".repeat(32) }]) {
      expect(verifySignIn(signIn(w, extra), want()).ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("allows Flags to be absent, 0 or 0x80000000", () => {
    expect(verifySignIn(signIn(w, { Flags: 0 }), want()).ok).toBe(true);
    expect(verifySignIn(signIn(w, { Flags: 0x80000000 }), want()).ok).toBe(true);
  });

  it("refuses a missing lock: Sequence, Fee or LastLedgerSequence changed or absent", () => {
    for (const lock of [{ Sequence: 1 }, { Sequence: 7 }, { Fee: "12" }, { Fee: "1" }, { LastLedgerSequence: 100 }, { LastLedgerSequence: 2 }, { Sequence: undefined }, { Fee: undefined }, { LastLedgerSequence: undefined }]) {
      expect(verifySignIn(signIn(w, lock), want()).ok, JSON.stringify(lock)).toBe(false);
    }
    expect(verifySignIn(signIn(w, { Sequence: 1, Fee: "12", LastLedgerSequence: 100 }), want())).toMatchObject({ ok: false, reason: expect.stringContaining("locked") });
  });

  it("refuses a transaction that is not an AccountSet", () => {
    expect(verifySignIn(signIn(w, { TransactionType: "SetRegularKey" }), want()).ok).toBe(false);
  });

  it("refuses two memos, no memo, a different memo type, and a memo with extra fields", () => {
    const own = (signInTransaction({ address: w.classicAddress, publicKey: w.publicKey }, { origin: ORIGIN, chain: CHAIN, challenge: NONCE, iat: NOW / 1000 }) as { Memos: unknown[] }).Memos;
    expect(verifySignIn(signIn(w, { Memos: [...own, ...own] }), want())).toMatchObject({ ok: false, reason: expect.stringContaining("one memo") });
    expect(verifySignIn(signIn(w, { Memos: [...own, memoOf("note", "hi")] }), want()).ok).toBe(false);
    expect(verifySignIn(signIn(w, { Memos: undefined }), want()).ok).toBe(false);
    expect(verifySignIn(signIn(w, { Memos: [] }), want()).ok).toBe(false);
    const stmt = JSON.stringify({ origin: ORIGIN, chain: CHAIN, challenge: NONCE, iat: NOW / 1000 });
    expect(verifySignIn(signIn(w, { Memos: [memoOf("byow/sign-out", stmt)] }), want())).toMatchObject({ ok: false, reason: expect.stringContaining("memo") });
    expect(verifySignIn(signIn(w, { Memos: [memoOf("byow/sign-in", stmt)] }), want()).ok).toBe(true); // control
    expect(verifySignIn(signIn(w, { Memos: [{ Memo: { ...memoOf("byow/sign-in", stmt).Memo, MemoFormat: hex("text/plain") } }] }), want()).ok).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const tx = decode(ok()) as Record<string, string>;
    const sig = tx.TxnSignature!;
    const flipped = sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11);
    expect(verifySignIn(encode({ ...tx, TxnSignature: flipped }), want())).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(verifySignIn(encode({ ...tx, TxnSignature: sig.slice(2) }), want()).ok).toBe(false);
  });

  it("refuses a statement edited after signing, even if the edit is what the verifier expects", () => {
    const tx = decode(ok()) as { Memos: { Memo: { MemoData: string } }[] };
    const edited = { ...tx, Memos: [{ Memo: { ...tx.Memos[0]!.Memo, MemoData: hex(JSON.stringify({ origin: "https://evil.example", chain: CHAIN, challenge: NONCE, iat: NOW / 1000 })) } }] };
    expect(verifySignIn(encode(edited), want({ origin: "https://evil.example" }))).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
  });

  it("refuses a swapped key or account", () => {
    const tx = decode(ok()) as Record<string, string>;
    const stranger = w === ED ? SECP : ED;
    expect(verifySignIn(encode({ ...tx, SigningPubKey: stranger.publicKey }), want()).ok).toBe(false);
    // Another account's name on a signature that still verifies is a claim for the ledger to refuse, not this check (keyMayActFor).
    const named = verifySignIn(signIn(w, { Account: stranger.classicAddress }), want());
    expect(named).toMatchObject({ ok: true, address: stranger.classicAddress, masterKey: false });
  });

  it("refuses a blob that is not in canonical form, so the hash is the one the ledger uses", () => {
    const blob = ok();
    // Sequence (24 00000000) and LastLedgerSequence (20 1B 00000001): same content, swapped order.
    const a = "2400000000";
    const b = "201B00000001";
    const i = blob.indexOf(a + b);
    expect(i).toBeGreaterThan(0);
    const swapped = blob.slice(0, i) + b + a + blob.slice(i + a.length + b.length);
    expect(verifySignIn(swapped, want())).toEqual({ ok: false, reason: "proof not in canonical form" });
  });

  it("refuses things that are not blobs, and never throws", () => {
    for (const junk of ["", "zz", "12", "12ab3", ok().slice(0, -2), ok() + "00", "not a blob", 5, null, undefined, {}]) {
      expect(() => verifySignIn(junk as never, want()), String(junk)).not.toThrow();
      expect(verifySignIn(junk as never, want()).ok, String(junk)).toBe(false);
    }
  });

  it("refuses an ordinary signed payment", () => {
    const pay = w.sign({ TransactionType: "Payment", Account: w.classicAddress, Destination: platform, Amount: "1", Sequence: 1, Fee: "12", LastLedgerSequence: 9 } as never).tx_blob;
    expect(verifySignIn(pay, want()).ok).toBe(false);
  });
});

describe("verifySignIn: masterKey and the regular key", () => {
  it("masterKey is true for the account's own key, false for another's", () => {
    expect(verifySignIn(signIn(ED), want())).toMatchObject({ ok: true, masterKey: true });
    expect(verifySignIn(signIn(ED, { Account: SECP.classicAddress }), want())).toMatchObject({ ok: true, masterKey: false });
  });
});

describe("keyMayActFor", () => {
  it("accepts the account's master key", () => {
    expect(keyMayActFor({ Account: ED.classicAddress }, ED.publicKey)).toBe(true);
    expect(keyMayActFor({ Account: SECP.classicAddress, Flags: 0 }, SECP.publicKey)).toBe(true);
    expect(keyMayActFor({ Account: SECP.classicAddress, Flags: 0x00010000 /* lsfPasswordSpent */ }, SECP.publicKey)).toBe(true);
    expect(keyMayActFor({ Account: ED.classicAddress }, ED.publicKey.toLowerCase())).toBe(true);
  });

  it("refuses the master key once the master is disabled (lsfDisableMaster, 0x00100000)", () => {
    expect(keyMayActFor({ Account: ED.classicAddress, Flags: 0x00100000 }, ED.publicKey)).toBe(false);
    expect(keyMayActFor({ Account: ED.classicAddress, Flags: 0x00100000 | 0x00800000 }, ED.publicKey)).toBe(false);
  });

  it("accepts the account's regular key, even with the master disabled", () => {
    expect(keyMayActFor({ Account: SECP.classicAddress, RegularKey: ED.classicAddress }, ED.publicKey)).toBe(true);
    expect(keyMayActFor({ Account: SECP.classicAddress, RegularKey: ED.classicAddress, Flags: 0x00100000 }, ED.publicKey)).toBe(true);
  });

  it("refuses an unrelated key, and a key that is not a key", () => {
    expect(keyMayActFor({ Account: SECP.classicAddress }, ED.publicKey)).toBe(false);
    expect(keyMayActFor({ Account: SECP.classicAddress, RegularKey: platform }, ED.publicKey)).toBe(false);
    expect(keyMayActFor({ Account: SECP.classicAddress, RegularKey: platform, Flags: 0 }, SECP.publicKey)).toBe(true); // master still fine
    expect(keyMayActFor({ Account: ED.classicAddress }, "")).toBe(false);
    expect(keyMayActFor({ Account: ED.classicAddress }, "not hex")).toBe(false);
    expect(keyMayActFor({ Account: ED.classicAddress }, "ED12")).toBe(false);
  });
});

describe("keyMayActForAccount", () => {
  it("lets only the master key sign in for an account the ledger has never seen", () => {
    expect(keyMayActForAccount(ED.classicAddress, ED.publicKey, null)).toBe(true);
    expect(keyMayActForAccount(SECP.classicAddress, SECP.publicKey, null)).toBe(true);
    expect(keyMayActForAccount(SECP.classicAddress, ED.publicKey, null)).toBe(false);
    expect(keyMayActForAccount(ED.classicAddress, "not hex", null)).toBe(false);
  });

  it("defers to keyMayActFor for an account that exists", () => {
    expect(keyMayActForAccount(ED.classicAddress, ED.publicKey, { Account: ED.classicAddress })).toBe(true);
    expect(keyMayActForAccount(ED.classicAddress, ED.publicKey, { Account: ED.classicAddress, Flags: 0x00100000 })).toBe(false);
    expect(keyMayActForAccount(SECP.classicAddress, ED.publicKey, { Account: SECP.classicAddress, RegularKey: ED.classicAddress })).toBe(true);
  });

  it("refuses an AccountRoot for a different account than the one signing in", () => {
    // The root of the account whose regular key this is, handed in for another address by mistake.
    expect(keyMayActForAccount(ED.classicAddress, ED.publicKey, { Account: SECP.classicAddress, RegularKey: ED.classicAddress })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// A signed transaction against what was asked

describe("checkSignedTx", () => {
  const requested = { TransactionType: "Payment", Destination: platform, Amount: "1000000", DestinationTag: 42 };
  const filled = { ...requested, Account: ED.classicAddress, Sequence: 7, Fee: "12", LastLedgerSequence: 5000 };
  const signed = (tx: Record<string, unknown>, w: Wallet = ED) => w.sign(tx as never);
  const blob = (over: Record<string, unknown> = {}) => signed({ ...filled, ...over }).tx_blob;
  const drop = (k: string) => {
    const t: Record<string, unknown> = { ...filled };
    delete t[k];
    return signed(t).tx_blob;
  };

  it("accepts a transaction where the wallet filled only Account, Sequence, Fee and LastLedgerSequence", () => {
    const s = signed(filled);
    const r = checkSignedTx(requested, s.tx_blob);
    expect(r).toMatchObject({ ok: true, hash: s.hash, lastLedgerSequence: 5000 });
    expect(r.ok && r.tx).toMatchObject(filled);
  });

  it("returns the same hash xrpl.js computes", () => {
    const s = signed(filled);
    expect(checkSignedTx(requested, s.tx_blob)).toMatchObject({ ok: true, hash: hashes.hashSignedTx(s.tx_blob) });
    expect((checkSignedTx(requested, s.tx_blob) as { hash: string }).hash).toBe(s.hash);
    const s2 = signed(filled, SECP); // another key, another blob, another hash
    expect(s2.hash).not.toBe(s.hash);
  });

  it("accepts a field the site set itself, signed as given: Fee, Sequence, LastLedgerSequence, SourceTag, Memos", () => {
    const set = { Fee: "20", Sequence: 3, LastLedgerSequence: 9999, SourceTag: 2606230007, Memos: [memoOf("note", "hello")] };
    const req = { ...requested, ...set };
    expect(checkSignedTx(req, signed({ ...req, Account: ED.classicAddress }).tx_blob).ok).toBe(true);
    // ...and refuses when the wallet changed one of them.
    for (const [k, v] of [["Fee", "21"], ["Sequence", 4], ["LastLedgerSequence", 10000], ["SourceTag", 1], ["Memos", [memoOf("note", "other")]]] as const) {
      expect(checkSignedTx(req, signed({ ...req, Account: ED.classicAddress, [k]: v }).tx_blob), k).toMatchObject({ ok: false, reason: expect.stringContaining(k) });
    }
  });

  it("refuses when the wallet changed a field the site sent", () => {
    expect(checkSignedTx(requested, blob({ Amount: "2000000" }))).toMatchObject({ ok: false, reason: "the wallet changed Amount" });
    expect(checkSignedTx(requested, blob({ Destination: issuer }))).toMatchObject({ ok: false, reason: "the wallet changed Destination" });
    expect(checkSignedTx(requested, blob({ DestinationTag: 43 }))).toMatchObject({ ok: false, reason: "the wallet changed DestinationTag" });
    expect(checkSignedTx(requested, blob({ Amount: { currency: "USD", issuer, value: "1" } })).ok).toBe(false);
    expect(checkSignedTx(requested, blob({ TransactionType: "TrustSet", Destination: undefined, Amount: undefined, LimitAmount: { currency: "USD", issuer, value: "1" } })).ok).toBe(false);
  });

  it("refuses when the wallet dropped a field the site sent", () => {
    expect(checkSignedTx(requested, drop("DestinationTag"))).toMatchObject({ ok: false, reason: "the wallet dropped DestinationTag" });
    expect(checkSignedTx({ ...requested, SourceTag: 5 }, blob())).toMatchObject({ ok: false, reason: "the wallet dropped SourceTag" });
    expect(checkSignedTx({ ...requested, Memos: [memoOf("a", "b")] }, blob())).toMatchObject({ ok: false });
  });

  it("refuses when the wallet added SourceTag or Memos, or anything else outside the fill list", () => {
    expect(checkSignedTx(requested, blob({ SourceTag: 2606230007 }))).toMatchObject({ ok: false, reason: "the wallet added SourceTag" });
    expect(checkSignedTx(requested, blob({ Memos: [memoOf("byow", "hi")] }))).toMatchObject({ ok: false, reason: "the wallet added Memos" });
    expect(checkSignedTx(requested, blob({ InvoiceID: "AA".repeat(32) })).ok).toBe(false);
    expect(checkSignedTx(requested, blob({ SendMax: "5000000" })).ok).toBe(false);
    expect(checkSignedTx(requested, blob({ Paths: [[{ account: issuer }]] })).ok).toBe(false);
    expect(checkSignedTx(requested, blob({ AccountTxnID: "AA".repeat(32) })).ok).toBe(false);
  });

  it("allows the wallet to fill NetworkID when the site left it out", () => {
    expect(checkSignedTx(requested, blob({ NetworkID: 1 })).ok).toBe(true);
  });

  it("refuses when the wallet changed Flags (a partial-payment flag the site never asked for)", () => {
    expect(checkSignedTx(requested, blob({ Flags: 0x00020000 }))).toMatchObject({ ok: false, reason: "the wallet changed Flags" });
    expect(checkSignedTx({ ...requested, Flags: 0 }, blob({ Flags: 0x00020000 })).ok).toBe(false);
    expect(checkSignedTx({ ...requested, Flags: 0x00020000 }, blob({ Flags: 0x00020000 })).ok).toBe(true); // the site asked for it
    expect(checkSignedTx({ ...requested, Flags: 0x00020000 }, blob()).ok).toBe(false); // the site asked, the wallet dropped it
  });

  it("treats Flags absent, 0 and 0x80000000 as the same", () => {
    for (const asked of [undefined, 0, 0x80000000, 0x80000000 + 0]) {
      const req = asked === undefined ? requested : { ...requested, Flags: asked };
      for (const signedFlags of [undefined, 0, 0x80000000]) {
        expect(checkSignedTx(req, blob(signedFlags === undefined ? {} : { Flags: signedFlags })).ok, `asked ${asked} signed ${signedFlags}`).toBe(true);
      }
    }
    expect(checkSignedTx({ ...requested, Flags: 0x80000000 + 0x00020000 }, blob({ Flags: 0x00020000 })).ok).toBe(true); // only the canonical bit differs
  });

  it("refuses a transaction with no LastLedgerSequence", () => {
    expect(checkSignedTx({ ...requested }, drop("LastLedgerSequence"))).toMatchObject({ ok: false, reason: "no LastLedgerSequence" });
  });

  it("checks opts.account against the signed Account", () => {
    expect(checkSignedTx(requested, blob(), { account: ED.classicAddress }).ok).toBe(true);
    expect(checkSignedTx(requested, blob(), { account: SECP.classicAddress })).toMatchObject({ ok: false, reason: "signed for a different account" });
    expect(checkSignedTx({ ...requested, Account: ED.classicAddress }, blob({ Account: SECP.classicAddress }), {}).ok).toBe(false); // the site named the account
  });

  it("accepts a key that does not derive the account: whether it may act for it is the ledger's call", () => {
    const s = signed({ ...filled, Account: SECP.classicAddress }, ED);
    expect(checkSignedTx(requested, s.tx_blob, { account: SECP.classicAddress }).ok).toBe(true);
  });

  it("refuses a tampered signature, a non-canonical blob, and things that are not blobs", () => {
    const s = blob();
    const tx = decode(s) as Record<string, string>;
    const sig = tx.TxnSignature!;
    expect(checkSignedTx(requested, encode({ ...tx, TxnSignature: sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11) }))).toMatchObject({ ok: false, reason: "signature does not verify" });
    expect(checkSignedTx(requested, encode({ ...tx, Amount: "2000000" })).ok).toBe(false); // edited after signing
    const a = "2400000007";
    const b = "2E0000002A";
    const i = s.indexOf(a + b);
    expect(i).toBeGreaterThan(0);
    expect(checkSignedTx(requested, s.slice(0, i) + b + a + s.slice(i + 20))).toEqual({ ok: false, reason: "tx_blob not in canonical form" });
    for (const junk of ["", "zz", "12", s.slice(0, -2), 5, null]) {
      expect(() => checkSignedTx(requested, junk as never), String(junk)).not.toThrow();
      expect(checkSignedTx(requested, junk as never).ok, String(junk)).toBe(false);
    }
  });

  it("compares in serialized form: the same value spelled another way is the same, and nothing else is", () => {
    const iou = (value: string, currency = RLUSD) => ({ ...requested, Amount: { currency, issuer, value } });
    const sIou = signed({ ...filled, Amount: { currency: RLUSD, issuer, value: "10.5" } }).tx_blob;
    expect(checkSignedTx(iou("10.50"), sIou).ok).toBe(true);
    expect(checkSignedTx(iou("10.6"), sIou).ok).toBe(false);
  });
});

describe("checkSignedPayment", () => {
  const pay = { TransactionType: "Payment", Account: ED.classicAddress, Destination: platform, Amount: "1000000", DestinationTag: 42, Sequence: 7, Fee: "12", LastLedgerSequence: 5000 };
  const blob = (over: Record<string, unknown> = {}, w: Wallet = ED) => {
    const t: Record<string, unknown> = { ...pay, ...over };
    for (const k of Object.keys(over)) if (over[k] === undefined) delete t[k];
    return w.sign(t as never).tx_blob;
  };
  const base = { account: ED.classicAddress, destination: platform, amount: "1000000", destinationTag: 42 };

  it("accepts the invoice, with the hash xrpl.js computes", () => {
    const s = ED.sign(pay as never);
    expect(checkSignedPayment(s.tx_blob, { ...base, maxFeeDrops: 1000n })).toMatchObject({ ok: true, hash: s.hash, lastLedgerSequence: 5000 });
  });

  it("accepts a payment signed by a key that does not derive the account, as long as Account matches: the ledger is what refuses it", () => {
    const b = blob({ Account: SECP.classicAddress }, ED);
    expect(checkSignedPayment(b, { ...base, account: SECP.classicAddress }).ok).toBe(true);
    expect(checkSignedPayment(b, base)).toMatchObject({ ok: false, reason: "Account is not the logged-in account" });
  });

  it("rejects a blob that pays something other than the invoice", () => {
    const b = blob();
    expect(checkSignedPayment(b, { ...base, destination: issuer })).toMatchObject({ ok: false, reason: "wrong Destination" });
    expect(checkSignedPayment(b, { ...base, amount: "2000000" })).toMatchObject({ ok: false, reason: "wrong Amount" });
    expect(checkSignedPayment(b, { ...base, destinationTag: 43 })).toMatchObject({ ok: false, reason: "wrong DestinationTag" });
    expect(checkSignedPayment(b, { ...base, sourceTag: 2606230007 })).toMatchObject({ ok: false, reason: "wrong SourceTag" });
    expect(checkSignedPayment(b, { ...base, account: issuer })).toMatchObject({ ok: false });
    expect(checkSignedPayment(blob({ DestinationTag: undefined }), base)).toMatchObject({ ok: false, reason: "wrong DestinationTag" }); // an untagged blob does not satisfy a tagged invoice
  });

  it("rejects a payment that is not exactly the invoice: Paths, SendMax, DeliverMin, tfPartialPayment, not a Payment", () => {
    expect(checkSignedPayment(blob({ SendMax: "5000000" }), base).ok).toBe(false);
    expect(checkSignedPayment(blob({ DeliverMin: "1", Flags: 0x00020000 }), base)).toMatchObject({ ok: false, reason: expect.stringContaining("DeliverMin") });
    expect(checkSignedPayment(blob({ Paths: [[{ account: issuer }]] }), base).ok).toBe(false);
    expect(checkSignedPayment(blob({ Flags: 0x00020000 }), base)).toMatchObject({ ok: false, reason: "tfPartialPayment is set" });
    expect(checkSignedPayment(blob({ Flags: 0x80000000 + 0x00020000 }), base).ok).toBe(false);
    expect(checkSignedPayment(blob({ Flags: 0x80000000 }), base).ok).toBe(true);
    expect(checkSignedPayment(blob({ TransactionType: "TrustSet", LimitAmount: { currency: "USD", issuer, value: "1" }, Destination: undefined, Amount: undefined, DestinationTag: undefined }), base)).toMatchObject({ ok: false, reason: "not a Payment" });
  });

  it("rejects a tampered blob", () => {
    const b = blob();
    const flipped = b.slice(0, 40) + (b[40] === "A" ? "B" : "A") + b.slice(41);
    expect(checkSignedPayment(flipped, base).ok).toBe(false);
  });

  it("requires a LastLedgerSequence, and a usable Fee under the cap", () => {
    expect(checkSignedPayment(blob({ LastLedgerSequence: undefined }), base)).toMatchObject({ ok: false, reason: "no LastLedgerSequence" });
    expect(checkSignedPayment(blob(), { ...base, maxFeeDrops: 11n })).toMatchObject({ ok: false, reason: "fee too high" });
    expect(checkSignedPayment(blob(), { ...base, maxFeeDrops: 12n }).ok).toBe(true);
  });

  it("compares IOU amounts numerically and hex currency codes case-insensitively; 3-character codes are not", () => {
    const amount = { currency: RLUSD, issuer, value: "10.50" };
    const b = blob({ Amount: amount });
    expect(checkSignedPayment(b, { ...base, amount: { ...amount, value: "10.5" } }).ok).toBe(true);
    expect(checkSignedPayment(b, { ...base, amount: { ...amount, currency: RLUSD.toLowerCase() } }).ok).toBe(true);
    expect(checkSignedPayment(b, { ...base, amount: { ...amount, value: "10.6" } })).toMatchObject({ ok: false, reason: "wrong Amount" });
    expect(checkSignedPayment(b, { ...base, amount: { ...amount, issuer: platform } }).ok).toBe(false);
    const usd = blob({ Amount: { currency: "USD", issuer, value: "5" } });
    expect(checkSignedPayment(usd, { ...base, amount: { currency: "USD", issuer, value: "5" } }).ok).toBe(true);
    expect(checkSignedPayment(usd, { ...base, amount: { currency: "usd", issuer, value: "5" } }).ok).toBe(false);
    expect(checkSignedPayment(usd, base).ok).toBe(false); // an IOU is not the drops that were invoiced
  });

  it("rejects a non-canonical encoding: the hash would not be the one the ledger uses", () => {
    const b = blob();
    // Swap Sequence (0x24) and DestinationTag (0x2E): same content, non-canonical order.
    const a = "2400000007";
    const c = "2E0000002A";
    const i = b.indexOf(a + c);
    expect(i).toBeGreaterThan(0);
    const swapped = b.slice(0, i) + c + a + b.slice(i + 20);
    // The reason matters: the swapped blob still decodes and its signature still verifies (same content), so only
    // the canonical-form guard stops it. A different reason would mean this test proves nothing.
    expect(checkSignedPayment(swapped, base)).toEqual({ ok: false, reason: "tx_blob not in canonical form" });
  });
});

// ---------------------------------------------------------------------------------------------
// The checking profile

describe("xrplVerified", () => {
  const profile = xrplVerified({ origin: ORIGIN });
  const connectParams = { chain: CHAIN, challenge: NONCE };
  const requested = { TransactionType: "Payment", Destination: platform, Amount: "1000000", DestinationTag: 42 };
  const signParams = { chain: CHAIN, tx_json: requested, submit: true };
  const filled = { ...requested, Account: ED.classicAddress, Sequence: 7, Fee: "12", LastLedgerSequence: 5000 };
  const good = ED.sign(filled as never);
  const goodResult = { tx_blob: good.tx_blob, hash: good.hash, submitted: false };
  const connectResult = (w: Wallet = ED, proof = signIn(w, {}, { iat: Math.floor(Date.now() / 1000) })) => ({ address: w.classicAddress, publicKey: w.publicKey, proof });
  const invalid = { code: "invalid_response" };

  it("keeps the xrpl profile's family, methods and validation", () => {
    expect(profile.family).toBe("xrpl");
    expect(profile.methods).toEqual(["xrpl_connect", "xrpl_signTransaction"]);
    expect(() => profile.validateParams("xrpl_signTransaction", { chain: CHAIN, tx_json: { ...requested, TxnSignature: "AB" } })).toThrow(ByowError);
  });

  it("passes a good connect result, and a good sign result", () => {
    expect(profile.parseResult("xrpl_connect", connectResult(), connectParams)).toMatchObject({ address: ED.classicAddress });
    expect(profile.parseResult("xrpl_connect", connectResult(SECP), connectParams)).toMatchObject({ address: SECP.classicAddress });
    expect(profile.parseResult("xrpl_signTransaction", goodResult, signParams)).toMatchObject({ tx_blob: good.tx_blob.toUpperCase(), hash: good.hash, submitted: false });
    expect(profile.parseResult("xrpl_signTransaction", { ...goodResult, submitted: true, engine_result: "tesSUCCESS" }, signParams)).toMatchObject({ submitted: true, engine_result: "tesSUCCESS" });
  });

  it("passes a connect result with no challenge and no proof: nothing was claimed", () => {
    expect(profile.parseResult("xrpl_connect", { address: ED.classicAddress, publicKey: ED.publicKey }, { chain: CHAIN })).toMatchObject({ address: ED.classicAddress });
  });

  it("throws invalid_response for a proof for another origin, chain, or challenge", () => {
    const params = { chain: CHAIN, challenge: NONCE };
    expect(() => xrplVerified({ origin: "https://other.example" }).parseResult("xrpl_connect", connectResult(), params)).toThrow(expect.objectContaining(invalid));
    expect(() => profile.parseResult("xrpl_connect", connectResult(), { chain: "xrpl:0", challenge: NONCE })).toThrow(expect.objectContaining(invalid));
    expect(() => profile.parseResult("xrpl_connect", connectResult(), { chain: CHAIN, challenge: "nonce-999999" })).toThrow(expect.objectContaining(invalid));
  });

  it("throws invalid_response for a proof that is too old, unless the integrator widened the limit", () => {
    const old = connectResult(ED, signIn(ED, {}, { iat: Math.floor(Date.now() / 1000) - 3000 }));
    expect(() => profile.parseResult("xrpl_connect", old, connectParams)).toThrow(expect.objectContaining(invalid));
    expect(() => xrplVerified({ origin: ORIGIN, maxAgeSeconds: 7200 }).parseResult("xrpl_connect", old, connectParams)).not.toThrow();
  });

  it("throws invalid_response when the proof is for a different account than the one returned", () => {
    const r = connectResult(ED);
    expect(() => profile.parseResult("xrpl_connect", { ...r, address: SECP.classicAddress }, connectParams)).toThrow(expect.objectContaining(invalid));
    expect(() => profile.parseResult("xrpl_connect", { ...r, publicKey: SECP.publicKey }, connectParams)).toThrow(expect.objectContaining(invalid));
  });

  it("throws invalid_response for a proof that is not a proof, and for a challenge answered with none", () => {
    expect(() => profile.parseResult("xrpl_connect", connectResult(ED, good.tx_blob), connectParams)).toThrow(expect.objectContaining(invalid)); // an ordinary signed transaction
    expect(() => profile.parseResult("xrpl_connect", { address: ED.classicAddress, publicKey: ED.publicKey }, connectParams)).toThrow(expect.objectContaining(invalid));
  });

  it("throws invalid_response for a blob that is not what was asked", () => {
    for (const over of [{ Amount: "2000000" }, { Destination: issuer }, { DestinationTag: 43 }, { SourceTag: 2606230007 }, { Flags: 0x00020000 }]) {
      const s = ED.sign({ ...filled, ...over } as never);
      expect(() => profile.parseResult("xrpl_signTransaction", { tx_blob: s.tx_blob, hash: s.hash, submitted: false }, signParams), JSON.stringify(over)).toThrow(expect.objectContaining(invalid));
    }
    const dropped = { ...filled } as Record<string, unknown>;
    delete dropped.DestinationTag;
    const s = ED.sign(dropped as never);
    expect(() => profile.parseResult("xrpl_signTransaction", { tx_blob: s.tx_blob, hash: s.hash, submitted: false }, signParams)).toThrow(expect.objectContaining(invalid));
  });

  it("throws invalid_response for a wrong hash", () => {
    expect(() => profile.parseResult("xrpl_signTransaction", { ...goodResult, hash: "AB".repeat(32) }, signParams)).toThrow(expect.objectContaining(invalid));
    expect(() => profile.parseResult("xrpl_signTransaction", { ...goodResult, hash: good.hash.slice(0, 62) + "00" }, signParams)).toThrow(/hash/);
  });

  it("throws invalid_response for a tampered or non-canonical blob", () => {
    const tx = decode(good.tx_blob) as Record<string, string>;
    const sig = tx.TxnSignature!;
    const bad = encode({ ...tx, TxnSignature: sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11) });
    expect(() => profile.parseResult("xrpl_signTransaction", { tx_blob: bad, hash: hashOf(bad), submitted: false }, signParams)).toThrow(expect.objectContaining(invalid));
  });

  it("when the site named the account, a result signed for a different one is refused (account, or tx_json.Account)", () => {
    const sp = { ...signParams, account: SECP.classicAddress };
    expect(() => profile.parseResult("xrpl_signTransaction", goodResult, sp)).toThrow(expect.objectContaining(invalid));
    expect(profile.parseResult("xrpl_signTransaction", goodResult, { ...signParams, account: ED.classicAddress })).toMatchObject({ hash: good.hash });
    expect(() => profile.parseResult("xrpl_signTransaction", goodResult, { ...signParams, tx_json: { ...requested, Account: SECP.classicAddress } })).toThrow(expect.objectContaining(invalid));
  });

  it("still applies the plain shape checks first", () => {
    expect(() => profile.parseResult("xrpl_signTransaction", { ...goodResult, submitted: "yes" }, signParams)).toThrow(expect.objectContaining(invalid));
    expect(() => profile.parseResult("xrpl_connect", "nope", connectParams)).toThrow(expect.objectContaining(invalid));
  });
});

// ---------------------------------------------------------------------------------------------
// The real wallet kit, end to end over JSON-RPC, then checked the way a site or its server would

interface RigOptions {
  approve?: boolean;
  fee?: string;
  submit?: XrplNetwork["submit"];
  fill?: () => Promise<any>;
  describe?: (tx: Record<string, unknown>) => Row[] | undefined;
  maxFeeDrops?: bigint;
}

// Drives the real kit with a fake window, an auto-approving review and a fake network.
async function rig(opts: RigOptions = {}) {
  const signer = seedSigner(ED_SEED, [CHAIN]);
  const fill = vi.fn(opts.fill ?? (async () => ({ Fee: opts.fee ?? "12", Sequence: 7, LastLedgerSequence: 5000, ledgerIndex: 4900 })));
  const network: XrplNetwork = { fill, submit: opts.submit };
  let reviews = 0; // how many times the user was shown anything
  const review: XrplReview = {
    connect: async () => (reviews++, opts.approve ?? true),
    sign: async () => (reviews++, opts.approve ?? true),
  };
  const handlers = xrplHandlers({ signer, network, review, ...(opts.describe ? { describe: opts.describe } : {}), ...(opts.maxFeeDrops ? { maxFeeDrops: opts.maxFeeDrops } : {}) });
  const sent: any[] = [];
  const opener = { postMessage: (m: unknown) => void sent.push(m) } as unknown as Window;
  const win = Object.assign(new EventTarget(), { opener, close() {} });
  createWalletServer({ info: { name: "T", chains: [CHAIN] }, ...handlers, win: win as any }).start();
  let n = 0;
  const call = async (method: string, params: unknown) => {
    const id = `r${++n}`;
    win.dispatchEvent(Object.assign(new Event("message"), { data: { jsonrpc: "2.0", id, method, params }, origin: ORIGIN, source: opener }));
    // Handlers are async (WebCrypto address checks, network); wait for the answer rather than a fixed tick.
    for (let i = 0; i < 200 && !sent.find((m) => m.id === id); i++) await new Promise((r) => setTimeout(r, 5));
    return sent.find((m) => m.id === id);
  };
  return { call, reviews: () => reviews, fill, address: ED.classicAddress, sent };
}

describe("sign-in through the real kit", () => {
  it("round-trips and verifies server-side, with the origin the wallet saw", async () => {
    const w = await rig();
    const r = await w.call("xrpl_connect", { chain: CHAIN, challenge: NONCE });
    expect(r.error).toBeUndefined();
    const { address, publicKey, proof } = r.result;
    expect(address).toBe(w.address);
    const v = verifySignIn(proof, { origin: ORIGIN, chain: CHAIN, challenge: NONCE });
    expect(v).toMatchObject({ ok: true, address: w.address, publicKey: publicKey.toUpperCase(), masterKey: true });
    expect(keyMayActFor({ Account: address }, publicKey)).toBe(true);
    expect(w.reviews()).toBe(1);
  });

  it("fails for another site's origin, chain or challenge", async () => {
    const w = await rig();
    const { proof } = (await w.call("xrpl_connect", { chain: CHAIN, challenge: NONCE })).result;
    expect(verifySignIn(proof, { origin: "https://other.example", chain: CHAIN, challenge: NONCE }).ok).toBe(false);
    expect(verifySignIn(proof, { origin: ORIGIN, chain: "xrpl:0", challenge: NONCE }).ok).toBe(false);
    expect(verifySignIn(proof, { origin: ORIGIN, chain: CHAIN, challenge: "nonce-999999" }).ok).toBe(false);
  });

  it("is injective: a ':' in the challenge cannot collide with a port (cross-origin replay)", async () => {
    const w = await rig();
    const { proof } = (await w.call("xrpl_connect", { chain: CHAIN, challenge: "8443-abcdefgh" })).result;
    expect(verifySignIn(proof, { origin: ORIGIN, chain: CHAIN, challenge: "8443-abcdefgh" }).ok).toBe(true);
    expect(verifySignIn(proof, { origin: "https://site.example:8443", chain: CHAIN, challenge: "abcdefgh" }).ok).toBe(false);
    // The statement is JSON, so the fields are separate keys: nothing a challenge holds can be read as part of the origin.
    const a = signIn(ED, {}, { origin: "https://host.example", challenge: "8443-abcdefgh", iat: NOW / 1000 });
    expect(verifySignIn(a, { origin: "https://host.example:8443", chain: CHAIN, challenge: "abcdefgh", now: NOW }).ok).toBe(false);
  });

  it("without a challenge shares an address and key and signs nothing", async () => {
    const w = await rig();
    const r = await w.call("xrpl_connect", { chain: CHAIN });
    expect(r.result).toEqual({ address: w.address, publicKey: ED.publicKey });
  });

  it("an answer with a challenge always carries a proof, and one the checking profile accepts", async () => {
    const w = await rig();
    const r = await w.call("xrpl_connect", { chain: CHAIN, challenge: NONCE });
    expect(() => xrplVerified({ origin: ORIGIN }).parseResult("xrpl_connect", r.result, { chain: CHAIN, challenge: NONCE })).not.toThrow();
  });

  it("refuses a challenge outside the alphabet, and an unsupported chain, before the user sees anything", async () => {
    const w = await rig();
    expect((await w.call("xrpl_connect", { chain: CHAIN, challenge: "has space 123" })).error.code).toBe(E.bad_params);
    expect((await w.call("xrpl_connect", { chain: CHAIN, challenge: "short" })).error.code).toBe(E.bad_params);
    expect((await w.call("xrpl_connect", { chain: "xrpl:0" })).error.code).toBe(4300);
    expect(w.reviews()).toBe(0);
  });

  it("a declined connect is user_rejected and reveals nothing", async () => {
    const w = await rig({ approve: false });
    const r = await w.call("xrpl_connect", { chain: CHAIN, challenge: NONCE });
    expect(r.error.code).toBe(E.user_rejected);
    expect(JSON.stringify(r)).not.toContain(w.address);
  });

  it("refuses to sign a sign-in transaction through xrpl_signTransaction: a site cannot ask for a statement naming another origin", async () => {
    const w = await rig();
    const tx = signInTransaction({ address: w.address, publicKey: ED.publicKey }, { origin: "https://victim.example", chain: CHAIN, challenge: NONCE, iat: Math.floor(Date.now() / 1000) });
    const { SigningPubKey: _drop, ...forged } = tx;
    expect((await w.call("xrpl_signTransaction", { chain: CHAIN, tx_json: forged })).error.code).toBe(E.bad_params);
    // Nor smuggled onto a transaction the wallet would otherwise sign.
    const memo = (forged as { Memos: unknown[] }).Memos;
    const r = await w.call("xrpl_signTransaction", { chain: CHAIN, tx_json: { TransactionType: "Payment", Destination: platform, Amount: "1000000", Memos: memo } });
    expect(r.error.code).toBe(E.bad_params);
    expect(w.reviews()).toBe(0);
  });
});

describe("sign-in on a carrier with no browser-stamped origin", () => {
  const core = (now = () => NOW) => {
    const reviews: unknown[] = [];
    const review: XrplReview = { connect: async (v) => (reviews.push(v), true), sign: async () => true };
    const network: XrplNetwork = { fill: async () => ({ Fee: "12", Sequence: 7, LastLedgerSequence: 5000, ledgerIndex: 4900 }) };
    const h = xrplHandlers({ signer: seedSigner(ED_SEED, [CHAIN]), network, review, now });
    return { reviews, core: createWalletCore({ info: { name: "T", chains: [CHAIN] }, ...h }) };
  };
  const ask = (c: ReturnType<typeof core>["core"], params: object, asker: object) =>
    c.handle({ jsonrpc: "2.0", id: "a", method: "xrpl_connect", params }, { carrier: "link", ...asker } as never);

  it("refuses a challenge when nobody can be said to be asking: there is nothing to bind the proof to", async () => {
    const c = core();
    const out = await ask(c.core, { chain: CHAIN, challenge: NONCE }, { origin: null, originProof: "none" });
    expect(out.response).toMatchObject({ error: { code: E.bad_params } });
    expect(c.reviews).toHaveLength(0); // before any UI
    expect((await ask(c.core, { chain: CHAIN }, { origin: null, originProof: "none" })).response).toMatchObject({ result: { address: ED.classicAddress } }); // no proof asked, none needed
  });

  it("writes into the proof the origin the carrier gave it, and the time from its own clock", async () => {
    const c = core(() => NOW);
    const out = await ask(c.core, { chain: CHAIN, challenge: NONCE }, { origin: "https://site.example", originProof: "delivery" });
    expect(c.reviews[0]).toMatchObject({ origin: "https://site.example", originProof: "delivery", challenge: NONCE });
    const { proof } = (out.response as { result: { proof: string } }).result;
    expect(verifySignIn(proof, want())).toMatchObject({ ok: true, iat: NOW / 1000 });
    expect(verifySignIn(proof, want({ origin: "https://other.example" })).ok).toBe(false);
  });
});

describe("signing through the kit, then checking the blob", () => {
  const tx = (over: Record<string, unknown> = {}) => ({ TransactionType: "Payment", Destination: platform, Amount: "1000000", DestinationTag: 42, ...over });
  const params = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ chain: CHAIN, tx_json: tx(over), ...extra });

  it("signs a payment that checkSignedTx and checkSignedPayment accept, and the checking profile passes", async () => {
    const w = await rig();
    const p = params();
    const r = await w.call("xrpl_signTransaction", p);
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ submitted: false, hash: hashOf(r.result.tx_blob) });
    expect(checkSignedTx(p.tx_json, r.result.tx_blob, { account: w.address })).toMatchObject({ ok: true, hash: r.result.hash });
    expect(checkSignedPayment(r.result.tx_blob, { account: w.address, destination: platform, amount: "1000000", destinationTag: 42, maxFeeDrops: 1000n })).toMatchObject({ ok: true, hash: r.result.hash });
    expect(() => xrplVerified({ origin: ORIGIN }).parseResult("xrpl_signTransaction", r.result, p)).not.toThrow();
  });

  it("fills only what is absent: Account, Sequence, Fee, LastLedgerSequence. No tag, no memo, no flags of its own", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", params({ DestinationTag: undefined }));
    const t = decode(r.result.tx_blob) as Record<string, unknown>;
    expect(Object.keys(t).filter((k) => !["Flags"].includes(k)).sort()).toEqual(
      ["Account", "Amount", "Destination", "Fee", "LastLedgerSequence", "Sequence", "SigningPubKey", "TransactionType", "TxnSignature"].sort(),
    );
    expect(t).toMatchObject({ Account: w.address, Sequence: 7, Fee: "12", LastLedgerSequence: 5000, Destination: platform, Amount: "1000000" });
    expect([undefined, 0, 0x80000000]).toContain(t.Flags);
    expect(t.SourceTag).toBeUndefined();
    expect(t.Memos).toBeUndefined();
  });

  it("keeps a SourceTag the site set, and never adds one", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", params({ SourceTag: 2606230007 }));
    expect(decode(r.result.tx_blob)).toMatchObject({ SourceTag: 2606230007 });
  });

  it("signs a site-set Fee, Sequence, LastLedgerSequence, Flags and Memos as given, and asks the network for nothing it was given", async () => {
    // The default policy refuses these; a wallet that can explain them (its own policy) signs them unchanged.
    const w = await rig({ describe: (t) => describeTx({ TransactionType: t.TransactionType, Destination: t.Destination, Amount: t.Amount, DestinationTag: t.DestinationTag }) });
    const p = params({ Fee: "20", Sequence: 3, LastLedgerSequence: 9999, Flags: 0, Memos: [memoOf("note", "hello")] });
    const r = await w.call("xrpl_signTransaction", p);
    expect(r.error).toBeUndefined();
    expect(decode(r.result.tx_blob)).toMatchObject({ Fee: "20", Sequence: 3, LastLedgerSequence: 9999, Flags: 0, Memos: [memoOf("note", "hello")], Account: w.address });
    expect(w.fill).not.toHaveBeenCalled();
    expect(checkSignedTx(p.tx_json, r.result.tx_blob).ok).toBe(true);
  });

  it("does not fill a Sequence when the site chose a TicketSequence", async () => {
    const w = await rig({ describe: () => [{ label: "x", value: "y" }] });
    const r = await w.call("xrpl_signTransaction", params({ Sequence: 0, TicketSequence: 12 }));
    expect(decode(r.result.tx_blob)).toMatchObject({ Sequence: 0, TicketSequence: 12, Fee: "12" });
  });

  it("refuses a site-set fee above its ceiling, whoever chose it", async () => {
    const w = await rig({ describe: () => [{ label: "x", value: "y" }] });
    const r = await w.call("xrpl_signTransaction", params({ Fee: "1000000" }));
    expect(r.error.code).toBe(E.unsupported_tx);
    expect(w.reviews()).toBe(0);
  });

  it("by default the kit's policy refuses a site-set Fee, Sequence or Flags before approval (unsupported_tx, not a protocol rule)", async () => {
    const w = await rig();
    for (const over of [{ Fee: "12" }, { Sequence: 1 }, { LastLedgerSequence: 9999 }, { Flags: 1 }, { Memos: [memoOf("a", "b")] }]) {
      expect((await w.call("xrpl_signTransaction", params(over))).error.code, JSON.stringify(over)).toBe(E.unsupported_tx);
    }
    expect((await w.call("xrpl_signTransaction", { chain: CHAIN, tx_json: { TransactionType: "OfferCreate" } })).error.code).toBe(E.unsupported_tx);
    expect((await w.call("xrpl_signTransaction", { chain: CHAIN, tx_json: { TransactionType: "TrustSet", LimitAmount: { currency: "USD", issuer, value: "1" } } })).error.code).toBe(E.unsupported_tx); // no tfSetNoRipple
    expect(w.reviews()).toBe(0); // the user was never shown any of them
    expect((await w.call("xrpl_signTransaction", params({ Flags: 0 }))).error).toBeUndefined(); // Flags 0 is fine; and refusals did not spend the document
  });

  it("refuses the signature fields as bad_params before approval", async () => {
    const w = await rig();
    for (const k of ["SigningPubKey", "TxnSignature", "Signers"]) {
      expect((await w.call("xrpl_signTransaction", params({ [k]: k === "Signers" ? [] : "AB" }))).error.code, k).toBe(E.bad_params);
    }
    expect(w.reviews()).toBe(0);
  });

  it("refuses params.account and tx_json.Account that disagree, before approval", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", params({ Account: w.address }, { account: issuer }));
    expect(r.error.code).toBe(E.bad_params);
    expect(w.reviews()).toBe(0);
  });

  it("signs a TrustSet when the request itself carries tfSetNoRipple", async () => {
    const w = await rig();
    const p = { chain: CHAIN, tx_json: { TransactionType: "TrustSet", LimitAmount: { currency: RLUSD, issuer, value: "100" }, Flags: 131072 } };
    const r = await w.call("xrpl_signTransaction", p);
    expect(r.error).toBeUndefined();
    expect(decode(r.result.tx_blob)).toMatchObject({ Flags: 131072 });
    expect(checkSignedTx(p.tx_json, r.result.tx_blob).ok).toBe(true);
  });

  it("signs an RLUSD payment (hex currency) and compares amounts numerically", async () => {
    const w = await rig();
    const amount = { currency: RLUSD, issuer, value: "10.50" };
    const r = await w.call("xrpl_signTransaction", params({ Amount: amount }));
    expect(checkSignedPayment(r.result.tx_blob, { account: w.address, destination: platform, amount: { ...amount, value: "10.5" } }).ok).toBe(true);
    expect(checkSignedPayment(r.result.tx_blob, { account: w.address, destination: platform, amount: { ...amount, value: "10.6" } })).toMatchObject({ ok: false, reason: "wrong Amount" });
  });

  it("rejects a blob that pays something other than the invoice", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", params());
    const base = { account: w.address, destination: platform, amount: "1000000", destinationTag: 42 };
    expect(checkSignedPayment(r.result.tx_blob, { ...base, destination: issuer })).toMatchObject({ ok: false, reason: "wrong Destination" });
    expect(checkSignedPayment(r.result.tx_blob, { ...base, amount: "2000000" })).toMatchObject({ ok: false });
    expect(checkSignedPayment(r.result.tx_blob, { ...base, destinationTag: 43 })).toMatchObject({ ok: false, reason: "wrong DestinationTag" });
    expect(checkSignedPayment(r.result.tx_blob, { ...base, account: issuer })).toMatchObject({ ok: false });
  });

  it("rejects a tampered blob", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", params());
    const blob: string = r.result.tx_blob;
    const flipped = blob.slice(0, 40) + (blob[40] === "A" ? "B" : "A") + blob.slice(41);
    expect(checkSignedPayment(flipped, { account: w.address, destination: platform, amount: "1000000" }).ok).toBe(false);
    expect(checkSignedTx(tx(), flipped).ok).toBe(false);
  });

  it("refuses to sign when the user declines, and when the network asks an absurd fee", async () => {
    expect((await (await rig({ approve: false })).call("xrpl_signTransaction", params())).error.code).toBe(E.user_rejected);
    const w = await rig({ fee: "99999999" });
    const r = await w.call("xrpl_signTransaction", params());
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(E.unsupported_tx); // SPEC 5.4
    expect(w.reviews()).toBe(0);
  });

  it("a wallet widened to a higher ceiling signs the fee below it", async () => {
    const w = await rig({ fee: "200000", maxFeeDrops: 300_000n });
    expect((await w.call("xrpl_signTransaction", params())).result).toMatchObject({ submitted: false });
  });
});

describe("submit", () => {
  const p = (extra: Record<string, unknown> = {}) => ({ chain: CHAIN, tx_json: { TransactionType: "Payment", Destination: platform, Amount: "1000000" }, ...extra });

  it("submits by default and returns the signed blob with the network's first answer", async () => {
    const submit = vi.fn(async (_c: string, _b: string) => ({ accepted: true, engineResult: "tesSUCCESS" }));
    const w = await rig({ submit });
    const r = await w.call("xrpl_signTransaction", p());
    expect(r.result).toMatchObject({ submitted: true, engine_result: "tesSUCCESS", hash: hashOf(r.result.tx_blob) });
    expect(submit).toHaveBeenCalledWith(CHAIN, r.result.tx_blob);
  });

  it("a tec result is still an answer, not an error: only the validated ledger says whether it landed", async () => {
    const w = await rig({ submit: async () => ({ accepted: true, engineResult: "tecUNFUNDED_PAYMENT" }) });
    const r = await w.call("xrpl_signTransaction", p());
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ submitted: true, engine_result: "tecUNFUNDED_PAYMENT" });
    expect(r.result.tx_blob).toMatch(/^[0-9A-F]+$/);
  });

  it("a network that did not accept it says submitted: false, and the blob still comes back", async () => {
    const w = await rig({ submit: async () => ({ accepted: false, engineResult: "tefPAST_SEQ" }) });
    expect((await w.call("xrpl_signTransaction", p())).result).toMatchObject({ submitted: false, engine_result: "tefPAST_SEQ" });
  });

  it("submit: false does not touch the network's submit", async () => {
    const submit = vi.fn(async () => ({ accepted: true }));
    const w = await rig({ submit });
    const r = await w.call("xrpl_signTransaction", p({ submit: false }));
    expect(r.result).toMatchObject({ submitted: false });
    expect(r.result.engine_result).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a wallet that cannot submit answers submitted: false and the site submits", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", p());
    expect(r.result).toMatchObject({ submitted: false });
    expect(r.result.tx_blob).toBeDefined();
  });

  it("a submit that throws is not an error: the blob comes back unsubmitted, and nothing of the exception leaks", async () => {
    const w = await rig({ submit: async () => { throw new Error("socket closed after broadcast at /Users/shane/x"); } });
    const r = await w.call("xrpl_signTransaction", p());
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ submitted: false });
    expect(JSON.stringify(r)).not.toMatch(/socket|shane/);
  });

  it("the hash is the one computed from the blob, whatever the adapter says; a junk engine_result is dropped", async () => {
    const w = await rig({ submit: async () => ({ accepted: true, engineResult: "<script>", hash: "AB".repeat(32) } as never) });
    const r = await w.call("xrpl_signTransaction", p());
    expect(r.result.hash).toBe(hashOf(r.result.tx_blob));
    expect(r.result.hash).not.toBe("AB".repeat(32));
    expect(r.result.engine_result).toBeUndefined();
    expect(r.result.submitted).toBe(true);
  });
});

describe("a buggy network adapter", () => {
  it("cannot rewrite the destination or amount by returning extra fields", async () => {
    const w = await rig({ fill: async () => ({ Fee: "12", Sequence: 7, LastLedgerSequence: 5000, ledgerIndex: 4900, Destination: issuer, Amount: "999999999", SourceTag: 1, Memos: [memoOf("a", "b")] }) });
    const r = await w.call("xrpl_signTransaction", { chain: CHAIN, tx_json: { TransactionType: "Payment", Destination: platform, Amount: "1000000" } });
    const t = decode(r.result.tx_blob);
    expect(t).toMatchObject({ Destination: platform, Amount: "1000000" });
    expect(t.SourceTag).toBeUndefined();
    expect(t.Memos).toBeUndefined();
  });
});

describe("review findings: regression tests", () => {
  const pay = (over: Record<string, unknown> = {}) => ({ chain: CHAIN, tx_json: { TransactionType: "Payment", Destination: platform, Amount: "1000000", ...over } });

  it("does not reveal the wallet's address before the user approves, and refuses a mismatch only afterwards", async () => {
    const w = await rig();
    // Site names a different (valid) account. The user is shown the request first; the refusal carries no address.
    const r = await w.call("xrpl_signTransaction", { ...pay(), account: issuer });
    expect(w.reviews()).toBe(1);
    expect(r.error.code).toBe(E.wrong_account);
    expect(JSON.stringify(r)).not.toContain(w.address);
    expect(r.error.data).toBeUndefined();
  });

  it("the same when the site names the account in tx_json.Account", async () => {
    const w = await rig();
    const r = await w.call("xrpl_signTransaction", pay({ Account: issuer }));
    expect(w.reviews()).toBe(1);
    expect(r.error.code).toBe(E.wrong_account);
    expect(JSON.stringify(r)).not.toContain(w.address);
  });

  it("a declined mismatched request reveals nothing at all", async () => {
    const w = await rig({ approve: false });
    const r = await w.call("xrpl_signTransaction", { ...pay(), account: issuer });
    expect(r.error.code).toBe(E.user_rejected);
  });

  it("naming the wallet's own account is fine", async () => {
    const w = await rig();
    expect((await w.call("xrpl_signTransaction", { ...pay(), account: w.address })).result).toMatchObject({ submitted: false });
  });

  it("does not leak whether the account is funded: a network failure is a generic internal error", async () => {
    const w = await rig({ fill: async () => { throw new ByowError("internal", "This account is not activated on that network (it holds no XRP)."); } });
    const r = await w.call("xrpl_signTransaction", pay());
    expect(r.error).toMatchObject({ code: E.internal });
    expect(JSON.stringify(r)).not.toMatch(/activated|funded|XRP/);
    expect(w.reviews()).toBe(0);
  });

  it("refuses a hostile RPC's fee, an expiry far in the future, and a non-uint32 sequence", async () => {
    const big = await rig({ fee: "1000000" }); // 1 XRP > the default 0.1 XRP ceiling
    const refused = await big.call("xrpl_signTransaction", pay());
    expect(refused.error).toBeDefined();
    expect(big.reviews()).toBe(0);
    const lls = async (v: number) => (await rig({ fill: async () => ({ Fee: "12", Sequence: 7, LastLedgerSequence: v, ledgerIndex: 4900 }) })).call("xrpl_signTransaction", pay());
    expect((await lls(4294967295)).error.code).toBe(E.internal); // never expires
    expect((await lls(4900)).error.code).toBe(E.internal); // already expired
    expect((await lls(4900 + 1001)).error.code).toBe(E.internal); // beyond the window
    expect((await lls(4900 + 1000)).error).toBeUndefined();
    const seq = (v: number) => rig({ fill: async () => ({ Fee: "12", Sequence: v, LastLedgerSequence: 5000, ledgerIndex: 4900 }) }).then((w) => w.call("xrpl_signTransaction", pay()));
    expect((await seq(2 ** 32)).error.code).toBe(E.internal);
    expect((await seq(0)).error.code).toBe(E.internal);
  });

  it("refuses an address with a bad checksum before the user sees anything, instead of failing at signing", async () => {
    const w = await rig();
    const bad = platform.slice(0, -1) + (platform.endsWith("e") ? "d" : "e");
    const r = await w.call("xrpl_signTransaction", pay({ Destination: bad }));
    expect(r.error.code).toBe(E.bad_params);
    expect(w.reviews()).toBe(0);
    // ... and the document is not spent, because nothing was shown.
    expect((await w.call("xrpl_signTransaction", pay())).error).toBeUndefined();
    // The same for the account the site names.
    const w2 = await rig();
    expect((await w2.call("xrpl_signTransaction", { ...pay(), account: bad })).error.code).toBe(E.bad_params);
    expect(w2.reviews()).toBe(0);
  });

  it("refuses to be spent twice: after a signed transaction the document answers busy", async () => {
    const w = await rig();
    expect((await w.call("xrpl_signTransaction", pay())).error).toBeUndefined();
    expect((await w.call("xrpl_signTransaction", pay())).error.code).toBe(4400);
    expect(w.reviews()).toBe(1);
  });
});
