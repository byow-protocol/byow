// The wallet core: one message in, at most one message out. Every carrier (window, page, link) is a thin
// wrapper that decides who is asking and how the answer travels; everything a wallet must get right
// regardless of carrier lives here, once:
//   - malformed messages, unknown methods and unsupported chains are refused BEFORE any UI
//   - one request that shows UI at a time; the rest get `busy`
//   - handler exceptions never leak their message to the site
// Zero dependencies. Runs anywhere: a page, an extension's background, a phone app's script engine, Node.

import {
  CORE_INFO,
  SUPPORTED_VERSIONS,
  isChainId,
  parseManifest,
  parseMessage,
  rpcError,
  rpcResult,
  toWireError,
  type Manifest,
  type RpcResponse,
  type WireErrorCode,
} from "../protocol.js";

export type CarrierKind = "window" | "page" | "link";

/**
 * How the wallet knows who is asking.
 * browser   the browser stamped the origin on the message (window, page). A page cannot forge it.
 * delivery  it is the origin the answer will be delivered to (link). Whoever made the link chose it, so it says
 *           where the answer goes and not which page the user is looking at.
 * none      nothing vouches for anyone: a link with no return path.
 */
export type OriginProof = "browser" | "delivery" | "none";

export interface HandlerContext {
  /** Who is asking. Show it verbatim and large on every approval; when null, say the site is unknown. */
  origin: string | null;
  originProof: OriginProof;
  carrier: CarrierKind;
  /** `params.chain`, already checked against the manifest. */
  chain?: string;
  /** Aborted if the wallet is being closed or navigated away. */
  signal: AbortSignal;
}
export type Handler = (params: Record<string, unknown>, ctx: HandlerContext) => unknown | Promise<unknown>;

export interface WalletInfoInput {
  name: string;
  icon?: string;
  description?: string;
  /** CAIP-2 chains this wallet can act on. */
  chains: string[];
}

export interface WalletCoreOptions {
  info: WalletInfoInput;
  /** method name -> handler. byow_info is built in. Handlers do the UI and the signing. */
  handlers: Record<string, Handler>;
  /** Per chain family, the transaction types this wallet signs. A profile's handler set supplies it. */
  transactions?: Record<string, "*" | string[]>;
  /** Wallet-side policy: return false to refuse a site outright. Default: any site may ask (the user still approves). */
  allowSite?: (origin: string | null) => boolean;
}

/** What a carrier tells the core about one incoming message. */
export interface Asker {
  origin: string | null;
  originProof: OriginProof;
  carrier: CarrierKind;
  signal?: AbortSignal;
  /** The carrier's context is used up (a popup document that already answered): refuse UI requests with `busy`. */
  spent?: boolean;
  /** Called when a request is about to reach a handler, i.e. the user may be about to see something. */
  onPending?: (method: string) => void;
}

export interface Outcome {
  /** What to send back. null: say nothing (not a request, or one with no usable id). */
  response: RpcResponse | null;
  /** A handler ran to an end the site cannot simply retry: success, the user's refusal, or a crash. */
  spent: boolean;
  /** The error code, if the answer is an error. */
  code?: WireErrorCode;
  method?: string;
}

export interface WalletCore {
  readonly manifest: Manifest;
  /** Never throws. */
  handle(message: unknown, asker: Asker): Promise<Outcome>;
}

// A refusal that does not use anything up: the site asked for something the wallet will not do, and may ask
// again. Anything else (the user said no, a crash) is final for a one-shot context.
const RETRYABLE: readonly WireErrorCode[] = ["site_not_allowed", "bad_request", "bad_params", "unsupported_method", "unsupported_chain", "unsupported_tx", "wrong_account", "expired", "busy"];

const NEVER = new AbortController().signal;
const SILENT: Outcome = { response: null, spent: false };

export function createWalletCore(options: WalletCoreOptions): WalletCore {
  const handlers = options.handlers;
  // Parse our own manifest through the same strict parser a site will use: a wallet author finds
  // out in development, not from a stranger's console, that their manifest is invalid.
  const manifest = parseManifest({
    ...options.info,
    methods: [...new Set([CORE_INFO, ...Object.keys(handlers)])],
    versions: [...SUPPORTED_VERSIONS],
    ...(options.transactions ? { transactions: options.transactions } : {}),
  });
  let uiBusy = false;

  return {
    manifest,
    async handle(message, asker) {
      const msg = parseMessage(message); // never throws, and what it returns is our own copy
      if (msg.kind === "ignore" || msg.kind === "ready" || msg.kind === "response") return SILENT;
      if (msg.kind === "malformed") {
        return msg.id ? { response: rpcError(msg.id, { code: "bad_request", message: msg.why }), spent: false, code: "bad_request" } : SILENT;
      }
      const { req } = msg;
      const refuse = (code: WireErrorCode, text: string, data?: unknown): Outcome => ({ response: rpcError(req.id, { code, message: text, data }), spent: false, code, method: req.method });

      // Fail closed: a policy that throws has not said yes.
      let allowed = true;
      try {
        allowed = !options.allowSite || options.allowSite(asker.origin) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) return refuse("site_not_allowed", "This wallet does not accept requests from this site.");
      if (req.method === CORE_INFO) return { response: rpcResult(req.id, manifest), spent: false, method: req.method };

      const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
      if (!handler) return refuse("unsupported_method", `${req.method} is not implemented by this wallet.`);
      const chain = req.params.chain;
      if (chain !== undefined) {
        if (!isChainId(chain)) return refuse("bad_params", "params.chain must be a CAIP-2 chain id");
        if (!manifest.chains.includes(chain)) return refuse("unsupported_chain", `${chain} is not supported by this wallet.`, { supported: manifest.chains });
      }
      if (uiBusy || asker.spent) return refuse("busy", "This wallet is already handling a request.");

      uiBusy = true;
      try {
        try {
          asker.onPending?.(req.method);
        } catch {
          /* a status callback must not be able to wedge the wallet */
        }
        const result = await handler(req.params, {
          origin: asker.origin,
          originProof: asker.originProof,
          carrier: asker.carrier,
          ...(typeof chain === "string" ? { chain } : {}),
          signal: asker.signal ?? NEVER,
        });
        return { response: rpcResult(req.id, result), spent: true, method: req.method };
      } catch (e) {
        const err = toWireError(e);
        return { response: rpcError(req.id, err), spent: !RETRYABLE.includes(err.code), code: err.code, method: req.method };
      } finally {
        uiBusy = false;
      }
    },
  };
}
