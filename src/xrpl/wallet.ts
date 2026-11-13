// XRPL handlers for the wallet kit: xrpl_connect and xrpl_signTransaction.
// A wallet author supplies three things: a signer (where keys live), a network (numbers to fill in, and
// optionally submission), and a review (the screen the user approves on). Everything between those is done
// here, once. Zero dependencies: the signer and network are interfaces; see signer.ts for xrpl.js-backed ones.
//
// The network adapter is treated as untrusted (it talks to a server somebody else runs): it may only supply
// a few numbers, those are bounds-checked, and nothing it returns is passed on to the site as fact.

import { ByowError } from "../protocol.js";
import type { Handler, OriginProof } from "../wallet/core.js";
import {
  DEFAULT_TRANSACTIONS,
  XRPL_CONNECT,
  XRPL_FAMILY,
  XRPL_SIGN,
  describeTx,
  formatDrops,
  isValidClassicAddress,
  signInTransaction,
  txAddresses,
  validateConnectParams,
  validateSignParams,
  type ConnectResult,
  type Row,
  type SignResult,
} from "./profile.js";

export interface XrplSigner {
  /** CAIP-2 chains this signer will act on, e.g. ["xrpl:1"]. */
  chains: string[];
  getAccount(): Promise<{ address: string; publicKey: string }>;
  /**
   * Sign a complete transaction exactly as given. This is the only thing a signer does: a sign-in proof is a
   * transaction too, so a hardware wallet or anything else that can only sign transactions is a full signer.
   */
  signTx(tx: Record<string, unknown>): Promise<{ tx_blob: string; hash: string }>;
}

/** The only things a network adapter may supply. It never sees or rewrites the site's fields. */
export interface FillFields {
  Fee: string;
  Sequence: number;
  LastLedgerSequence: number;
  /** The ledger the numbers above were read at. The kit bounds LastLedgerSequence against it. */
  ledgerIndex: number;
  NetworkID?: number;
}
export interface XrplNetwork {
  fill(chain: string, address: string): Promise<FillFields>;
  /**
   * Hand a signed transaction to the network and return its first answer, without waiting for validation.
   * `accepted` is whether a server took it for relay. Leave this out and the wallet only signs: the site submits.
   */
  submit?(chain: string, txBlob: string): Promise<{ accepted: boolean; engineResult?: string }>;
}

/** Who is asking, as the review screen must show it. Display `origin` verbatim and large; when null, say the site is unknown. */
export interface Asking {
  origin: string | null;
  /** "delivery" means the origin is only where the answer is sent (a link), not a page the browser vouched for. Say so. */
  originProof: OriginProof;
}

export interface XrplReview {
  /** Show who is asking and which address will be shared. Resolve true on approve. */
  connect(v: Asking & { chain: string; address: string; challenge?: string }): Promise<boolean>;
  /**
   * Show the decoded transaction. Resolve true on approve.
   * `askedAccount` is the account the site wants signed for. If it differs from `address` the request will be
   * refused (`wrong_account`) after approval, so the screen SHOULD say so now rather than let the user approve something that fails.
   */
  sign(v: Asking & { chain: string; address: string; askedAccount?: string; rows: Row[]; fee: string; submit: boolean }): Promise<boolean>;
}

export interface XrplWalletOptions {
  signer: XrplSigner;
  network: XrplNetwork;
  review: XrplReview;
  /**
   * This wallet's signing policy, widened. Return rows for a transaction you can fully explain; undefined falls
   * back to the default whitelist (Payment and TrustSet). Throw unsupported_tx to refuse.
   */
  describe?: (tx: Record<string, unknown>) => Row[] | undefined;
  /** The transaction types this wallet signs, for its manifest. Default: the default whitelist's. Set it when `describe` renders more. */
  transactions?: "*" | string[];
  /** Refuse to sign above this fee, whoever chose it. Default 100,000 drops (0.1 XRP, ~8,000x the base fee). */
  maxFeeDrops?: bigint;
  /** Refuse a LastLedgerSequence further than this many ledgers past the ledger the adapter read. Default 1000 (~1 hour). */
  maxLedgerWindow?: number;
  /** Injected for tests. */
  now?: () => number;
}

const UINT32_MAX = 4294967295;

/** The XRPL half of a wallet. Spread it into createWalletServer or createWalletCore: `{ info, ...xrplHandlers(o) }`. */
export function xrplHandlers(o: XrplWalletOptions): { handlers: Record<string, Handler>; transactions: Record<string, "*" | string[]> } {
  const maxFee = o.maxFeeDrops ?? 100_000n;
  const maxWindow = o.maxLedgerWindow ?? 1000;
  const now = o.now ?? Date.now;
  const declined = () => new ByowError("user_rejected", "The user declined.");
  const unprepared = () => new ByowError("internal", "The wallet could not prepare the transaction.");
  const ok32 = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= UINT32_MAX;

  const connect: Handler = async (params, ctx): Promise<ConnectResult> => {
    const p = validateConnectParams(params);
    if (!o.signer.chains.includes(p.chain)) throw new ByowError("unsupported_chain", `${p.chain} is not supported by this wallet.`, { supported: o.signer.chains });
    // A proof is bound to whoever asked. With nobody identifiable asking, there is nothing to bind it to.
    if (p.challenge !== undefined && ctx.origin === null) throw new ByowError("bad_params", "A sign-in proof needs an origin to be bound to, and this request has none.");
    const { address, publicKey } = await o.signer.getAccount();
    if (!(await o.review.connect({ origin: ctx.origin, originProof: ctx.originProof, chain: p.chain, address, ...(p.challenge === undefined ? {} : { challenge: p.challenge }) }))) throw declined();
    if (p.challenge === undefined) return { address, publicKey };
    // The wallet writes the origin it saw into the proof. The site never supplies it, so a proof cannot be
    // harvested by one site for use at another.
    const tx = signInTransaction({ address, publicKey }, { origin: ctx.origin!, chain: p.chain, challenge: p.challenge, iat: Math.floor(now() / 1000) });
    const { tx_blob } = await o.signer.signTx(tx);
    return { address, publicKey, proof: tx_blob };
  };

  const sign: Handler = async (params, ctx): Promise<SignResult> => {
    const p = validateSignParams(params);
    if (!o.signer.chains.includes(p.chain)) throw new ByowError("unsupported_chain", `${p.chain} is not supported by this wallet.`, { supported: o.signer.chains });
    const tx = p.tx_json;

    // Everything before the user approves must reveal nothing about this wallet to the site: not its address
    // (so the account check is AFTER approval), not whether it is funded (so network failures are generic).
    const rows = o.describe?.(tx) ?? describeTx(tx);
    for (const a of [...txAddresses(tx), ...(p.account ? [p.account] : [])]) {
      if (!(await isValidClassicAddress(a))) throw new ByowError("bad_params", `${a.slice(0, 40)} is not a valid XRPL address (bad checksum)`);
    }

    // Fill what the site left out, and only that. A field the site set is signed as sent or not at all.
    const acct = await o.signer.getAccount();
    const full: Record<string, unknown> = { ...tx };
    if (full.Account === undefined) full.Account = acct.address;
    const needsSequence = full.Sequence === undefined && full.TicketSequence === undefined;
    if (needsSequence || full.Fee === undefined || full.LastLedgerSequence === undefined) {
      let fill: FillFields;
      try {
        fill = await o.network.fill(p.chain, acct.address);
      } catch {
        throw unprepared();
      }
      if (typeof fill.Fee !== "string" || !/^\d{1,12}$/.test(fill.Fee)) throw unprepared();
      if (!ok32(fill.Sequence) || !ok32(fill.LastLedgerSequence) || !ok32(fill.ledgerIndex)) throw unprepared();
      if (fill.LastLedgerSequence <= fill.ledgerIndex || fill.LastLedgerSequence - fill.ledgerIndex > maxWindow) throw unprepared();
      // Copy the fields by name. Spreading `fill` would let a buggy adapter rewrite Destination or Amount.
      if (needsSequence) full.Sequence = fill.Sequence;
      if (full.Fee === undefined) full.Fee = fill.Fee;
      if (full.LastLedgerSequence === undefined) full.LastLedgerSequence = fill.LastLedgerSequence;
      if (full.NetworkID === undefined && fill.NetworkID !== undefined) {
        if (!ok32(fill.NetworkID)) throw unprepared();
        full.NetworkID = fill.NetworkID;
      }
    }
    if (typeof full.Fee !== "string" || !/^\d{1,12}$/.test(full.Fee) || BigInt(full.Fee) > maxFee) {
      throw new ByowError("unsupported_tx", "The fee is above what this wallet will sign.");
    }

    const willSubmit = p.submit && !!o.network.submit;
    const approved = await o.review.sign({
      origin: ctx.origin,
      originProof: ctx.originProof,
      chain: p.chain,
      address: acct.address,
      ...(p.account ? { askedAccount: p.account } : {}),
      rows,
      fee: formatDrops(full.Fee),
      submit: willSubmit,
    });
    if (!approved) throw declined();
    if (p.account && p.account !== acct.address) throw new ByowError("wrong_account", "The wallet's account is not the one the site asked for.");

    const signed = await o.signer.signTx(full);
    const result: SignResult = { tx_blob: signed.tx_blob, hash: signed.hash, submitted: false };
    if (!willSubmit) return result;
    // The signed transaction goes back to the site whatever happens next: the same blob is the same transaction,
    // so the site can submit it again, and only the validated ledger says whether it landed.
    try {
      const r = await o.network.submit!(p.chain, signed.tx_blob);
      result.submitted = r.accepted === true;
      if (typeof r.engineResult === "string" && /^[a-z]{3}[A-Za-z_]{0,40}$/.test(r.engineResult)) result.engine_result = r.engineResult;
    } catch {
      /* submitted stays false: the site has the blob */
    }
    return result;
  };

  return {
    handlers: { [XRPL_CONNECT]: connect, [XRPL_SIGN]: sign },
    transactions: { [XRPL_FAMILY]: o.transactions ?? [...DEFAULT_TRANSACTIONS] },
  };
}
