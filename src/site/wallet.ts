// The site SDK's core: one wallet handle, whatever carried the conversation. A site integrates this once;
// any wallet that speaks the protocol then works, with no per-wallet code and nothing to approve or register.
//
// Everything a wallet says is untrusted input. This file's job is to make sure that is true in code: nothing
// goes out that a registered profile has not validated, and nothing comes back without being parsed by one.

import { ByowError, chainFamily, isChainId, isPlainObject, type Manifest, type Profile } from "../protocol.js";
import { windowCarrier, type Isolation, type WindowOptions } from "./window.js";

export type CarrierKind = "window" | "page" | "link";

export interface WalletInfo {
  /** How the wallet was reached. Sign-in over "link" can be relayed by a phishing page; "window" and "page" cannot. */
  carrier: CarrierKind;
  /** The origin the browser stamped on the wallet's messages: its identity. null when the carrier has none (page, link). */
  origin: string | null;
  /** What the wallet CLAIMS about itself. Render it as a claim, never above the origin. null when it could not be asked (link). */
  manifest: Manifest | null;
  /** Window carrier only: how well the wallet window is kept away from the site's own tab. */
  isolation?: Isolation;
}

export interface CallSpec {
  method: string;
  params: Record<string, unknown>;
  /** Throws to stop before the user is shown anything. Carriers that can read the manifest first must call it. */
  check(manifest: Manifest): void;
}

/** One way of handing a request to a wallet. `call` MUST do any window.open synchronously: it runs inside a click. */
export interface Carrier {
  readonly kind: CarrierKind;
  call(spec: CallSpec): Promise<{ result: unknown; info: WalletInfo }>;
}

export interface ByowOptions extends WindowOptions {
  /** Profiles that know how to validate a chain family's params and results. */
  profiles?: Profile[];
}

const isCarrier = (x: unknown): x is Carrier => isPlainObject(x) && typeof x.call === "function" && typeof x.kind === "string";

export class ByowWallet {
  readonly carrier: Carrier;
  /** Info from the most recent successful call. */
  lastInfo: WalletInfo | null = null;
  private readonly profiles: Profile[];

  /**
   * `wallet` is a wallet URL (opened in a popup: the window carrier) or any other carrier.
   * Safe to construct inside the click handler.
   */
  constructor(wallet: string | URL | Carrier, options: ByowOptions = {}) {
    this.profiles = options.profiles ?? [];
    this.carrier = isCarrier(wallet) ? wallet : windowCarrier(wallet, options);
  }

  /**
   * Send a method defined by a registered profile (e.g. xrpl_connect, xrpl_signTransaction).
   * Needs a user gesture on the window carrier, and does no awaiting before the window opens.
   */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let profile: Profile;
    try {
      const found = this.profiles.find((p) => p.methods.includes(method));
      if (!found) throw new ByowError("unsupported_method", `No profile registered for ${method}; this SDK will not return a result it cannot validate.`);
      profile = found;
      if (!isPlainObject(params)) throw new ByowError("bad_params", "params must be an object");
      if (params.chain !== undefined) {
        if (!isChainId(params.chain)) throw new ByowError("bad_params", "params.chain must be a CAIP-2 chain id");
        if (chainFamily(params.chain) !== profile.family) throw new ByowError("bad_params", `${method} does not apply to ${params.chain}`);
      }
      profile.validateParams(method, params); // fail before a wallet ever hears about it
    } catch (e) {
      return Promise.reject(e);
    }
    const chain = params.chain as string | undefined;
    return this.carrier
      .call({
        method,
        params,
        check(m) {
          if (!m.methods.includes(method)) throw new ByowError("unsupported_method", `This wallet does not implement ${method}.`, { wallet: m.methods });
          if (chain && !m.chains.includes(chain)) throw new ByowError("unsupported_chain", `This wallet does not support ${chain}.`, { wallet: m.chains });
          profile.preflight?.(method, params, m);
        },
      })
      .then(({ result, info }) => {
        const parsed = profile.parseResult(method, result, params) as T;
        this.lastInfo = info;
        return parsed;
      });
  }
}
