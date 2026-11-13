// Verification. This is what lets a webmaster accept strangers' wallets without reading a line of crypto:
// a wallet's claims are only ever believed after they check out here. Runs on a server, or in the page when
// the site already ships xrpl.js. Optional peer dependency: `xrpl`.

// Everything comes through `xrpl` itself, the one peer dependency: its sub-packages are not ours to import, and a
// strict installer (pnpm, Yarn PnP) does not hoist them.
import { decode, deriveAddress, encode, hashes, verifySignature } from "xrpl";
import { ByowError, type Profile } from "../protocol.js";
import { SIGN_IN_MEMO_TYPE_HEX, WALLET_FILLS, XRPL_CONNECT, XRPL_SIGN, xrpl, type ConnectResult, type SignResult } from "./profile.js";

const TF_FULLY_CANONICAL_SIG = 0x80000000;
const LSF_DISABLE_MASTER = 0x00100000;

type Tx = Record<string, unknown>;

// xrpl's encode is typed for known transactions; ours are untrusted and checked field by field, so it takes any object.
const encodeTx = (tx: Tx): string => encode(tx as unknown as Parameters<typeof encode>[0]);

/** Decode a blob and insist it is the canonical serialization, so the hash we compute is the one the ledger uses. */
function decodeCanonical(blob: string): Tx | string {
  if (typeof blob !== "string" || blob.length > 400_000 || !/^[0-9A-Fa-f]+$/.test(blob) || blob.length % 2 !== 0) return "not hex";
  try {
    const tx = decode(blob) as Tx;
    // A blob with the same fields in another order decodes and verifies but hashes differently.
    return encodeTx(tx) === blob.toUpperCase() ? tx : "not in canonical form";
  } catch {
    return "does not decode";
  }
}

const sameKeys = (o: object, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

// ---------------------------------------------------------------------------------------------
// Sign-in

export type SignInCheck =
  | {
      ok: true;
      address: string;
      publicKey: string;
      /**
       * True when the signing key is the account's own master key. That is not yet proof of control: a master
       * key can be disabled, and an account may sign with a regular key instead (then this is false). A site
       * guarding anything of value finishes the check on the ledger with `keyMayActFor`.
       */
      masterKey: boolean;
      /** When the wallet says it signed, unix seconds. */
      iat: number;
    }
  | { ok: false; reason: string };

export interface SignInExpectation {
  /**
   * The origin YOU serve (or, for a link through a mailbox on another host, that mailbox's origin). Never read it
   * from the request. A site served on several origins (an apex and its www) lists them all: a proof for any of
   * its own origins is a proof for this site.
   */
  origin: string | readonly string[];
  chain: string;
  /** The nonce YOU issued. Single use: delete it before you call this. */
  challenge: string;
  /** Unix ms. Default Date.now(). */
  now?: number;
  /** How old a proof may be. Default 600 seconds. */
  maxAgeSeconds?: number;
}

/**
 * Is this a sign-in proof for THIS site and THIS nonce? It must be exactly the transaction that can never
 * apply (an empty AccountSet with Sequence 0, Fee "0" and LastLedgerSequence 1), carry the statement, and
 * verify against the key it names.
 */
export function verifySignIn(proof: string, want: SignInExpectation): SignInCheck {
  const no = (reason: string): SignInCheck => ({ ok: false, reason });
  const tx = decodeCanonical(proof);
  if (typeof tx === "string") return no(`proof ${tx}`);

  // The template, exactly. Anything more or less is not a sign-in: it might be a transaction that does something.
  const keys = ["TransactionType", "Account", "Sequence", "Fee", "LastLedgerSequence", "SigningPubKey", "TxnSignature", "Memos"];
  const flags = tx.Flags;
  if (flags !== undefined && flags !== 0 && flags !== TF_FULLY_CANONICAL_SIG) return no("unexpected Flags");
  if (!sameKeys(tx, flags === undefined ? keys : [...keys, "Flags"])) return no("not the sign-in transaction (unexpected fields)");
  if (tx.TransactionType !== "AccountSet" || tx.Sequence !== 0 || tx.Fee !== "0" || tx.LastLedgerSequence !== 1) return no("not the sign-in transaction (it is not locked)");
  if (typeof tx.Account !== "string" || typeof tx.SigningPubKey !== "string" || !tx.SigningPubKey) return no("no signing key");

  const memos = tx.Memos;
  if (!Array.isArray(memos) || memos.length !== 1) return no("expected exactly one memo");
  const memo = (memos[0] as { Memo?: Tx })?.Memo;
  if (!memo || !sameKeys(memo, ["MemoType", "MemoData"]) || memo.MemoType !== SIGN_IN_MEMO_TYPE_HEX || typeof memo.MemoData !== "string") return no("not a sign-in memo");
  let s: Tx;
  try {
    const bytes = Uint8Array.from((memo.MemoData.match(/../g) ?? []).map((h) => parseInt(h, 16)));
    s = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Tx;
  } catch {
    return no("statement does not parse");
  }
  if (typeof s !== "object" || s === null || Array.isArray(s)) return no("statement is not an object");
  const origins: readonly string[] = typeof want.origin === "string" ? [want.origin] : want.origin;
  if (typeof s.origin !== "string" || !origins.includes(s.origin)) return no("signed for a different origin");
  if (s.chain !== want.chain) return no("signed for a different chain");
  if (s.challenge !== want.challenge) return no("signed for a different challenge");
  const iat = s.iat;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat)) return no("statement has no time");
  const nowS = Math.floor((want.now ?? Date.now()) / 1000);
  if (iat > nowS + 120) return no("signed in the future");
  if (nowS - iat > (want.maxAgeSeconds ?? 600)) return no("proof is too old");

  try {
    if (!verifySignature(proof)) return no("signature does not verify");
    return { ok: true, address: tx.Account, publicKey: tx.SigningPubKey.toUpperCase(), masterKey: deriveAddress(tx.SigningPubKey) === tx.Account, iat };
  } catch {
    return no("signature check failed");
  }
}

/**
 * The ledger half of a sign-in check: may this key act for this account right now? Pass the account's
 * AccountRoot (`account_info` → `account_data`) from a validated ledger.
 */
export function keyMayActFor(accountRoot: { Account: string; Flags?: number; RegularKey?: string }, publicKey: string): boolean {
  let signer: string;
  try {
    signer = deriveAddress(publicKey);
  } catch {
    return false;
  }
  if (signer === accountRoot.Account) return (Number(accountRoot.Flags ?? 0) & LSF_DISABLE_MASTER) === 0;
  return typeof accountRoot.RegularKey === "string" && signer === accountRoot.RegularKey;
}

/**
 * The same question for a sign-in, including an account the ledger has never seen. Pass the address the proof
 * named, its key, and the account's AccountRoot from a validated ledger, or `null` when the ledger answered that
 * the account does not exist (`actNotFound`). An account that does not exist has no regular key and no disabled
 * master, so only its master key can speak for it: a brand-new wallet signs in before it is funded. Never pass
 * `null` because a lookup failed or timed out; that is not an answer.
 */
export function keyMayActForAccount(address: string, publicKey: string, accountRoot: { Account: string; Flags?: number; RegularKey?: string } | null): boolean {
  if (accountRoot === null) {
    try {
      return deriveAddress(publicKey) === address;
    } catch {
      return false;
    }
  }
  return accountRoot.Account === address && keyMayActFor(accountRoot, publicKey);
}

// ---------------------------------------------------------------------------------------------
// Signed transactions

export type TxCheck = { ok: true; hash: string; tx: Tx; lastLedgerSequence: number } | { ok: false; reason: string };

const flagBits = (v: unknown): number => ((Number(v ?? 0) >>> 0) & ~TF_FULLY_CANONICAL_SIG) >>> 0;

/**
 * Did the wallet sign what the site asked for? Every field the site sent must be in the signed transaction
 * unchanged, nothing may be added beyond what a wallet fills (WALLET_FILLS), and the signature must verify.
 * Whether the signing key may act for the account is the ledger's call: a transaction signed with the wrong
 * key simply fails there.
 */
export function checkSignedTx(requested: Tx, txBlob: string, opts: { account?: string } = {}): TxCheck {
  const no = (reason: string): TxCheck => ({ ok: false, reason });
  const tx = decodeCanonical(txBlob);
  if (typeof tx === "string") return no(`tx_blob ${tx}`);
  if ("Signers" in tx) return no("multi-signed transactions are not supported by this check");
  try {
    if (!verifySignature(txBlob)) return no("signature does not verify");
  } catch {
    return no("signature check failed");
  }
  if (opts.account !== undefined && tx.Account !== opts.account) return no("signed for a different account");

  // Flags: absent means 0, and the canonical-signature bit means nothing since 2020. Everything else must match.
  if (flagBits(tx.Flags) !== flagBits(requested.Flags)) return no("the wallet changed Flags");
  for (const k of Object.keys(tx)) {
    if (k === "Flags" || k in requested) continue;
    if (!WALLET_FILLS.includes(k)) return no(`the wallet added ${k}`);
  }
  const merged: Tx = { ...tx };
  for (const [k, v] of Object.entries(requested)) {
    if (k === "Flags") continue;
    if (!(k in tx)) return no(`the wallet dropped ${k}`);
    merged[k] = v;
  }
  try {
    // Compared in serialized form, so an amount of "1.0" and one of "1" are the same value, and nothing else is.
    if (encodeTx(merged) !== txBlob.toUpperCase()) {
      const changed = Object.keys(requested).find((k) => k !== "Flags" && JSON.stringify(requested[k]) !== JSON.stringify(tx[k]));
      return no(`the wallet changed ${changed ?? "a field"}`);
    }
  } catch {
    return no("the requested transaction does not encode");
  }
  if (typeof tx.LastLedgerSequence !== "number") return no("no LastLedgerSequence");
  return { ok: true, hash: hashes.hashSignedTx(txBlob), tx, lastLedgerSequence: tx.LastLedgerSequence };
}

export interface PaymentExpectation {
  /** The account the user logged in with. The payment must come from it. */
  account: string;
  destination: string;
  /** Drops as a string, or an issued amount. */
  amount: string | { currency: string; issuer: string; value: string };
  destinationTag?: number;
  sourceTag?: number;
  maxFeeDrops?: bigint;
}

const normCur = (c: string) => (/^[0-9A-Fa-f]{40}$/.test(c) ? c.toUpperCase() : c); // hex codes are case-insensitive; 3-char codes are not
const norm = (v: string) => (v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v).replace(/^0+(?=\d)/, "");

/**
 * Before you count a blob a wallet handed you as payment: is it a validly signed payment from the logged-in
 * account for exactly what you invoiced? A wallet that lies about what it signed fails here, not in production.
 * Use this when the invoice lives on your server; `checkSignedTx` when you still hold the request you sent.
 */
export function checkSignedPayment(txBlob: string, want: PaymentExpectation): TxCheck {
  const no = (reason: string): TxCheck => ({ ok: false, reason });
  const tx = decodeCanonical(txBlob);
  if (typeof tx === "string") return no(`tx_blob ${tx}`);
  try {
    if (!verifySignature(txBlob)) return no("signature does not verify");
  } catch {
    return no("signature check failed");
  }
  if (tx.TransactionType !== "Payment") return no("not a Payment");
  if (tx.Account !== want.account) return no("Account is not the logged-in account");
  if (tx.Destination !== want.destination) return no("wrong Destination");
  if (want.destinationTag !== undefined && tx.DestinationTag !== want.destinationTag) return no("wrong DestinationTag");
  if (want.sourceTag !== undefined && tx.SourceTag !== want.sourceTag) return no("wrong SourceTag");
  for (const k of ["Paths", "SendMax", "DeliverMin"]) if (k in tx) return no(`${k} is present (partial or cross-currency payment)`);
  if (flagBits(tx.Flags) & 0x00020000) return no("tfPartialPayment is set");
  const amt = tx.Amount;
  if (typeof want.amount === "string") {
    if (amt !== want.amount) return no("wrong Amount");
  } else {
    const a = amt as { currency?: string; issuer?: string; value?: string };
    if (typeof amt !== "object" || !a || normCur(String(a.currency)) !== normCur(want.amount.currency) || a.issuer !== want.amount.issuer || norm(String(a.value)) !== norm(want.amount.value)) {
      return no("wrong Amount");
    }
  }
  if (typeof tx.LastLedgerSequence !== "number") return no("no LastLedgerSequence");
  if (want.maxFeeDrops !== undefined) {
    if (typeof tx.Fee !== "string" || !/^\d{1,17}$/.test(tx.Fee)) return no("no usable Fee");
    if (BigInt(tx.Fee) > want.maxFeeDrops) return no("fee too high");
  }
  return { ok: true, hash: hashes.hashSignedTx(txBlob), tx, lastLedgerSequence: tx.LastLedgerSequence };
}

// ---------------------------------------------------------------------------------------------
// The checking profile: the XRPL profile, plus these checks run on every answer in the page.

/**
 * Register this instead of `xrpl` and the SDK verifies each answer before your code sees it: a signed
 * transaction must be the one that was asked for, and a sign-in proof must be for this origin and this nonce.
 * `origin` is the origin proofs must name: this page's, unless requests travel through a mailbox on another host.
 * A server that grants a session still verifies the proof itself; a page's word is not evidence to a server.
 */
export function xrplVerified(opts: { origin?: string | readonly string[]; maxAgeSeconds?: number } = {}): Profile {
  const fail = (why: string): never => {
    throw new ByowError("invalid_response", `wallet answer failed verification: ${why}`);
  };
  return {
    ...xrpl,
    parseResult(method, result, params) {
      if (method === XRPL_CONNECT) {
        const r = xrpl.parseResult(method, result, params) as ConnectResult;
        // A proof nobody asked for is bound to no nonce of ours: drop it rather than hand on something unverified.
        if (params.challenge === undefined || r.proof === undefined) return { address: r.address, publicKey: r.publicKey };
        const check = verifySignIn(r.proof, {
          origin: opts.origin ?? location.origin,
          chain: String(params.chain),
          challenge: String(params.challenge),
          ...(opts.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: opts.maxAgeSeconds }),
        });
        if (!check.ok) return fail(check.reason);
        if (check.address !== r.address || check.publicKey !== r.publicKey) return fail("the proof is for a different account than the one returned");
        return r;
      }
      if (method === XRPL_SIGN) {
        const r = xrpl.parseResult(method, result, params) as SignResult;
        const account = typeof params.account === "string" ? params.account : undefined;
        const check = checkSignedTx(params.tx_json as Tx, r.tx_blob, account === undefined ? {} : { account });
        if (!check.ok) return fail(check.reason);
        if (check.hash !== r.hash) return fail("the hash returned is not the hash of the signed transaction");
        return r;
      }
      return xrpl.parseResult(method, result, params);
    },
  };
}
