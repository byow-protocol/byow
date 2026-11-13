// The XRPL profile: what BYOW means for the chains xrpl:<network id> (0 mainnet, 1 testnet, 2 devnet).
// Shared by site and wallet. Zero dependencies; address checks here are shape-only apart from
// isValidClassicAddress (the verifier in verify.ts does the rest with a real codec).
//
// Two methods. xrpl_connect shares an address, optionally with proof that the wallet controls it.
// xrpl_signTransaction signs a transaction. The protocol's rule for it is short: the wallet fills what is
// absent, never alters what the site supplied, and may refuse anything. What a wallet refuses is its own
// policy (describeTx below is the reference kit's), never a rule of this profile.

import { ByowError, isPlainObject, type Manifest, type Profile } from "../protocol.js";

export const XRPL_FAMILY = "xrpl";
export const XRPL_CHAINS: Record<string, string> = { "xrpl:0": "XRPL Mainnet", "xrpl:1": "XRPL Testnet", "xrpl:2": "XRPL Devnet" };

export const XRPL_CONNECT = "xrpl_connect";
export const XRPL_SIGN = "xrpl_signTransaction";

const XRPL_CHAIN_RE = /^xrpl:\d{1,10}$/;
export const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;
const UINT32_MAX = 4294967295;

const toHex = (s: string): string => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

// ---------------------------------------------------------------------------------------------
// Sign-in: a transaction that can never apply.
//
// Proof that a wallet controls an account is a signed, empty AccountSet with three independent locks:
// Sequence 0 (always in the past), Fee "0" (below any minimum) and LastLedgerSequence 1 (expired since the
// second ledger). Each alone is refused by the network; if a wallet rewrote all three, what is left changes
// nothing. A memo carries who asked, on which chain, the site's nonce and the time.
//
// Why a transaction and not a signed message: signing a transaction is the one thing every XRPL wallet can
// do, hardware wallets included, and the same verifier covers regular keys and multi-signed accounts.

export const SIGN_IN_MEMO_TYPE = "byow/sign-in";
export const SIGN_IN_MEMO_TYPE_HEX = toHex(SIGN_IN_MEMO_TYPE);

/** A site's nonce: URL-safe characters only, so no wallet has to render anything careful. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface SignInStatement {
  /** The origin the WALLET saw asking. A site never supplies this. */
  origin: string;
  chain: string;
  challenge: string;
  /** Unix seconds, by the wallet's clock. */
  iat: number;
}

/** The unsigned sign-in transaction a wallet signs. Never submitted, and it could not apply if it were. */
export function signInTransaction(account: { address: string; publicKey: string }, s: SignInStatement): Record<string, unknown> {
  const statement = JSON.stringify({ origin: s.origin, chain: s.chain, challenge: s.challenge, iat: s.iat });
  return {
    TransactionType: "AccountSet",
    Account: account.address,
    Sequence: 0,
    Fee: "0",
    LastLedgerSequence: 1,
    SigningPubKey: account.publicKey,
    Memos: [{ Memo: { MemoType: SIGN_IN_MEMO_TYPE_HEX, MemoData: toHex(statement) } }],
  };
}

/** True if any memo is a sign-in statement. Such a transaction is minted by xrpl_connect and by nothing else. */
export function hasSignInMemo(tx: Record<string, unknown>): boolean {
  if (!Array.isArray(tx.Memos)) return false;
  return tx.Memos.some((m) => isPlainObject(m) && isPlainObject(m.Memo) && typeof m.Memo.MemoType === "string" && m.Memo.MemoType.toUpperCase() === SIGN_IN_MEMO_TYPE_HEX);
}

// ---------------------------------------------------------------------------------------------
// Who sets which field

/**
 * The only fields a wallet may add to a transaction, and only when the site left them out. Everything else
 * (SourceTag, Memos, Flags, DestinationTag, ...) is the site's: absent stays absent.
 */
export const WALLET_FILLS: readonly string[] = ["Account", "Sequence", "Fee", "LastLedgerSequence", "NetworkID", "SigningPubKey", "TxnSignature"];

/** Always the wallet's. A request that sets one is asking to sign something already signed. */
export const SIGNATURE_FIELDS: readonly string[] = ["SigningPubKey", "TxnSignature", "Signers"];

const B58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"; // the XRPL alphabet

/**
 * Full classic-address validation including the checksum, without a codec dependency. Shape alone is not
 * enough for a wallet: an address with a bad checksum passes a shape check, gets shown to the user, is approved,
 * and then cannot be signed.
 */
export async function isValidClassicAddress(addr: string): Promise<boolean> {
  if (!ADDRESS_RE.test(addr)) return false;
  let n = 0n;
  for (const ch of addr) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = new Uint8Array(25); // 0x00 type, 20-byte account id, 4-byte checksum
  for (let i = 24; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n || bytes[0] !== 0) return false;
  const d1 = await crypto.subtle.digest("SHA-256", bytes.subarray(0, 21));
  const d2 = new Uint8Array(await crypto.subtle.digest("SHA-256", d1));
  return bytes[21] === d2[0] && bytes[22] === d2[1] && bytes[23] === d2[2] && bytes[24] === d2[3];
}

/** Every address a transaction names, for checksum validation before the user is shown anything. */
export function txAddresses(tx: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["Account", "Destination"]) if (typeof tx[k] === "string") out.push(tx[k] as string);
  for (const k of ["Amount", "LimitAmount"]) {
    const a = tx[k];
    if (isPlainObject(a) && typeof a.issuer === "string") out.push(a.issuer);
  }
  return out;
}

export type IssuedAmount = { currency: string; issuer: string; value: string };
export type Amount = string | IssuedAmount;

// ---------------------------------------------------------------------------------------------
// Params. Structural checks only: safe to run on the site before a wallet is involved, and run again by the wallet.

export interface ConnectParams {
  chain: string;
  /** Ask for proof of control over the address, bound to this nonce and to the asking origin. */
  challenge?: string;
}
export interface ConnectResult {
  address: string;
  publicKey: string;
  /** A signed sign-in transaction (hex). Present when a challenge was sent. Verify it; until then the address is a claim. */
  proof?: string;
}

export interface SignParams {
  chain: string;
  tx_json: Record<string, unknown>;
  /** Sign as this account. May also be given as tx_json.Account; if both, they must match. */
  account?: string;
  /** Ask the wallet to submit after signing. Default true. Either way the signed transaction comes back. */
  submit: boolean;
}
export interface SignResult {
  /** The signed transaction, always. Submitting it again is harmless: the same blob is the same transaction. */
  tx_blob: string;
  hash: string;
  /** Whether the wallet handed it to the network. Not whether it succeeded: only the validated ledger says that. */
  submitted: boolean;
  /** The network's first answer, if the wallet submitted. Advice, not a result. */
  engine_result?: string;
}

const badParams = (why: string): never => {
  throw new ByowError("bad_params", why);
};

const xrplChain = (chain: unknown): string => {
  if (typeof chain !== "string" || !XRPL_CHAIN_RE.test(chain)) badParams("params.chain must be an XRPL chain id such as xrpl:0");
  return chain as string;
};

export function validateConnectParams(params: unknown): ConnectParams {
  if (!isPlainObject(params)) return badParams("params must be an object { chain, challenge? }");
  const chain = xrplChain(params.chain);
  const { challenge } = params;
  if (challenge !== undefined && (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge))) {
    badParams("params.challenge must be 8-128 characters from A-Z a-z 0-9 _ -");
  }
  return { chain, ...(challenge === undefined ? {} : { challenge: challenge as string }) };
}

function depthOk(v: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => depthOk(x, depth + 1));
  if (isPlainObject(v)) return Object.keys(v).length <= 64 && Object.values(v).every((x) => depthOk(x, depth + 1));
  return true;
}

/**
 * Which transaction TYPES and fields a wallet will sign is the wallet's business, so nothing here refuses on
 * meaning. A site may set any field of the transaction except the signature itself.
 */
export function validateSignParams(params: unknown): SignParams {
  if (!isPlainObject(params)) return badParams("params must be an object { chain, tx_json, account?, submit? }");
  const chain = xrplChain(params.chain);
  const { tx_json: tx, account, submit } = params;
  if (!isPlainObject(tx)) return badParams("params.tx_json must be an object");
  if (typeof tx.TransactionType !== "string" || !/^[A-Za-z]{1,40}$/.test(tx.TransactionType)) badParams("tx_json.TransactionType must be a transaction type name");
  if (!depthOk(tx)) badParams("tx_json is too deep or too large");
  for (const k of SIGNATURE_FIELDS) if (k in tx) badParams(`tx_json.${k} belongs to the signature; remove it from the request`);
  if (hasSignInMemo(tx)) badParams("a sign-in transaction comes from xrpl_connect and cannot be requested here");
  if (account !== undefined && (typeof account !== "string" || !ADDRESS_RE.test(account))) badParams("params.account must be an XRPL address");
  if (tx.Account !== undefined && (typeof tx.Account !== "string" || !ADDRESS_RE.test(tx.Account))) badParams("tx_json.Account must be an XRPL address");
  if (account !== undefined && tx.Account !== undefined && account !== tx.Account) badParams("params.account and tx_json.Account name different accounts");
  if (submit !== undefined && typeof submit !== "boolean") badParams("params.submit must be true or false");
  const signAs = (account ?? tx.Account) as string | undefined;
  return { chain, tx_json: tx, ...(signAs === undefined ? {} : { account: signAs }), submit: submit !== false };
}

// ---------------------------------------------------------------------------------------------
// The reference kit's signing policy: "render it or refuse it". A wallet's own choice, not a protocol rule.

export interface Row {
  label: string;
  value: string;
  warn?: string;
}

/** The transaction types describeTx renders. A wallet with its own renderer declares its own list. */
export const DEFAULT_TRANSACTIONS: readonly string[] = ["Payment", "TrustSet"];

const TF_SET_NO_RIPPLE = 0x00020000;

const unsupported = (why: string): never => {
  throw new ByowError("unsupported_tx", why);
};
const uint32 = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > UINT32_MAX) unsupported(`${name} must be a 32-bit unsigned integer`);
  return v as number;
};
const addr = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) unsupported(`${name} must be an XRPL address`);
  return v as string;
};

export function formatDrops(drops: string): string {
  const d = BigInt(drops);
  const whole = d / 1_000_000n;
  const frac = (d % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""} XRP`;
}

/**
 * 3-char codes pass through; 40-hex codes are shown as text only when every byte is a letter or digit, so a
 * wallet author cannot put a sentence into the Amount row. "XRP" in any case, or hex that decodes to it, is
 * flagged: no token is XRP.
 */
export function currencyLabel(code: string): { text: string; warn?: string } {
  const notXrp = "A token called XRP is not XRP";
  if (/^[A-Za-z0-9?!@#$%^&*<>(){}\[\]|]{3}$/.test(code)) {
    return code.toUpperCase() === "XRP" ? { text: code, warn: notXrp } : { text: code };
  }
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    const bytes = code.match(/../g)!.map((h) => parseInt(h, 16));
    while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
    const text = String.fromCharCode(...bytes);
    if (/^[A-Za-z0-9]{1,20}$/.test(text)) {
      return { text, warn: text.toUpperCase() === "XRP" ? notXrp : "Non-standard currency code. Check the issuer." };
    }
    return { text: code.toUpperCase(), warn: "Unreadable currency code. Check the issuer." };
  }
  return unsupported("unrecognised currency code");
}

function issued(v: unknown, name: string): IssuedAmount {
  if (!isPlainObject(v) || typeof v.currency !== "string" || typeof v.value !== "string") return unsupported(`${name} must be {currency, issuer, value}`);
  const issuer = addr(v.issuer, `${name}.issuer`);
  if (!/^(0|[1-9]\d{0,16})(\.\d{1,16})?$/.test(v.value) || v.value.replace(".", "").replace(/^0+/, "").length > 16 || Number(v.value) <= 0) {
    unsupported(`${name}.value must be a positive decimal with at most 16 digits`);
  }
  for (const k of Object.keys(v)) if (!["currency", "issuer", "value"].includes(k)) unsupported(`${name}.${k} is not allowed`);
  return { currency: v.currency, issuer, value: v.value };
}

function amountRows(label: string, a: unknown): Row[] {
  if (typeof a === "string") {
    if (!/^[1-9]\d{0,16}$/.test(a)) unsupported(`${label} must be a positive integer string of drops`);
    return [{ label, value: formatDrops(a) }];
  }
  const i = issued(a, label);
  const c = currencyLabel(i.currency);
  return [
    { label, value: `${i.value} ${c.text}`, ...(c.warn ? { warn: c.warn } : {}) },
    { label: "Issuer", value: i.issuer },
  ];
}

function onlyKeys(tx: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(tx)) if (!allowed.includes(k)) unsupported(`${String(tx.TransactionType)} field ${k} is not something this wallet can show you`);
}

/**
 * The default review whitelist: Payment and TrustSet, and no field that changes their meaning (no
 * SendMax/Paths/DeliverMin and no flags, so no partial or cross-currency payments; no fee or sequence chosen by
 * the site). If a field's meaning can't be rendered, the wallet refuses to sign rather than showing an Approve
 * button over a blob. A wallet never edits a request into something it likes better: it signs what was sent, or
 * says why not.
 */
export function describeTx(tx: Record<string, unknown>): Row[] {
  switch (tx.TransactionType) {
    case "Payment": {
      onlyKeys(tx, ["TransactionType", "Account", "Destination", "Amount", "DestinationTag", "SourceTag", "InvoiceID", "Flags"]);
      if (tx.Flags !== undefined && tx.Flags !== 0) unsupported("This wallet signs a Payment only with no flags set (no partial payments)");
      const rows: Row[] = [{ label: "Action", value: "Send a payment" }, { label: "To", value: addr(tx.Destination, "Destination") }];
      rows.push(...amountRows("Amount", tx.Amount));
      if (tx.DestinationTag !== undefined) rows.push({ label: "Destination tag", value: String(uint32(tx.DestinationTag, "DestinationTag")) });
      if (tx.SourceTag !== undefined) rows.push({ label: "Source tag", value: String(uint32(tx.SourceTag, "SourceTag")) });
      if (tx.InvoiceID !== undefined) {
        if (typeof tx.InvoiceID !== "string" || !/^[0-9A-Fa-f]{64}$/.test(tx.InvoiceID)) unsupported("InvoiceID must be 32 bytes of hex");
        rows.push({ label: "Invoice", value: (tx.InvoiceID as string).toUpperCase() });
      }
      return rows;
    }
    case "TrustSet": {
      onlyKeys(tx, ["TransactionType", "Account", "LimitAmount", "SourceTag", "Flags"]);
      // Without tfSetNoRipple a trust line lets balances ripple through the holder's account. This wallet will not
      // add the flag for the site (it never changes a request), so it asks the site to send it.
      if (tx.Flags !== TF_SET_NO_RIPPLE) unsupported("This wallet signs a TrustSet only when the request sets Flags to 131072 (tfSetNoRipple)");
      const l = issued(tx.LimitAmount, "LimitAmount");
      const c = currencyLabel(l.currency);
      const rows: Row[] = [
        { label: "Action", value: "Allow a token (trust line)" },
        { label: "Token", value: c.text, ...(c.warn ? { warn: c.warn } : {}) },
        { label: "Issuer", value: l.issuer },
        { label: "Limit", value: l.value },
        { label: "Rippling", value: "Off for this trust line" },
      ];
      if (tx.SourceTag !== undefined) rows.push({ label: "Source tag", value: String(uint32(tx.SourceTag, "SourceTag")) });
      return rows;
    }
    default:
      return unsupported(`${String(tx.TransactionType)} is not a transaction this wallet can show you`);
  }
}

// ---------------------------------------------------------------------------------------------
// Site-side result parsing. Shape only: what the result MEANS is checked by verify.ts against the signature.

const bad = (why: string): never => {
  throw new ByowError("invalid_response", `wallet result invalid: ${why}`);
};

const hexField = (v: unknown, name: string, max: number): string => {
  if (typeof v !== "string" || v.length < 2 || v.length > max || v.length % 2 !== 0 || !HEX_RE.test(v)) bad(`${name} is not hex`);
  return (v as string).toUpperCase();
};

export function parseConnectResult(result: unknown, asked: Record<string, unknown>): ConnectResult {
  if (!isPlainObject(result)) return bad("result is not an object");
  const { address, publicKey, proof } = result;
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) bad("address is not an XRPL address");
  if (typeof publicKey !== "string" || !/^[0-9A-Fa-f]{66}$/.test(publicKey)) bad("publicKey is not a 33-byte key");
  // A wallet that was asked to prove control and answers without proof has not answered the question.
  if (asked.challenge !== undefined && proof === undefined) bad("a challenge was sent but no proof came back");
  return {
    address: address as string,
    publicKey: (publicKey as string).toUpperCase(),
    ...(proof === undefined ? {} : { proof: hexField(proof, "proof", 8192) }),
  };
}

export function parseSignResult(result: unknown): SignResult {
  if (!isPlainObject(result)) return bad("result is not an object");
  const { hash, submitted, engine_result: er } = result;
  if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) bad("hash is not 32 bytes of hex");
  if (typeof submitted !== "boolean") bad("submitted must be true or false");
  if (er !== undefined && (typeof er !== "string" || !/^[a-z]{3}[A-Za-z_]{0,40}$/.test(er))) bad("engine_result malformed");
  return {
    tx_blob: hexField(result.tx_blob, "tx_blob", 200_000),
    hash: (hash as string).toUpperCase(),
    submitted: submitted as boolean,
    ...(er === undefined ? {} : { engine_result: er as string }),
  };
}

export const xrpl: Profile = {
  family: XRPL_FAMILY,
  methods: [XRPL_CONNECT, XRPL_SIGN],

  validateParams(method: string, params: Record<string, unknown>): void {
    if (method === XRPL_CONNECT) validateConnectParams(params);
    else validateSignParams(params);
  },

  preflight(method: string, params: Record<string, unknown>, manifest: Manifest): void {
    if (method !== XRPL_SIGN) return;
    const signs = manifest.transactions?.[XRPL_FAMILY];
    const type = isPlainObject(params.tx_json) ? params.tx_json.TransactionType : undefined;
    if (Array.isArray(signs) && typeof type === "string" && !signs.includes(type)) {
      throw new ByowError("unsupported_tx", `This wallet does not sign ${type} transactions.`, { wallet: signs });
    }
  },

  parseResult(method: string, result: unknown, params: Record<string, unknown>): unknown {
    return method === XRPL_CONNECT ? parseConnectResult(result, params) : parseSignResult(result);
  },
};
