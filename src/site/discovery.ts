// How a site learns which wallet to talk to. There is deliberately no registry the site must consult and
// no list this SDK ships: the user names the wallet (typed, remembered, or arriving as ?byow_wallet=).

import { ByowError, ICON_RE, MAX_ICON_CHARS, safeText } from "../protocol.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where a wallet that is named only by its domain is expected to answer. */
export const FRONT_DOOR_PATH = "/.well-known/byow";

/**
 * Validate a wallet URL. https only (http for localhost in development), no credentials.
 * `https://trusted.example@evil.example/` has a username: refused, because that URL's real host is evil.example.
 */
export function parseWalletUrl(input: string, opts: { allowInsecureLocalhost?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ByowError("invalid_wallet_url", "That is not a URL.");
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && local && (opts.allowInsecureLocalhost ?? true));
  if (!okScheme) throw new ByowError("invalid_wallet_url", "A wallet URL must be https (or http://localhost while developing).");
  if (u.username || u.password) throw new ByowError("invalid_wallet_url", "A wallet URL must not contain credentials.");
  return u;
}

// A bare host, with an optional port: what a person types when they mean "my wallet lives at this domain".
// Anything with a scheme, a path, a query, credentials or a space is not bare. Non-ASCII letters are allowed here
// and come out of URL parsing as punycode, so a look-alike domain looks different once it is shown back.
const BARE_HOST_RE = /^(?:\[[0-9a-fA-F:]+\]|[^\s/?#@\\:[\]]+)(?::\d{1,5})?$/u;

/**
 * Turn what a user typed into the URL to open. A full URL is used exactly as given, query string and all: a
 * wallet on a shared host cannot serve its origin's root, so the exact URL always has to work. A bare domain
 * ("wallet.example") means that domain's front door, https://wallet.example/.well-known/byow.
 */
export function resolveWallet(input: string, opts: { allowInsecureLocalhost?: boolean } = {}): URL {
  const text = input.trim();
  if (!text.includes("://") && BARE_HOST_RE.test(text)) {
    const host = text.replace(/:\d{1,5}$/, "");
    const scheme = LOCAL_HOSTS.has(host) ? "http" : "https";
    return parseWalletUrl(`${scheme}://${text}${FRONT_DOOR_PATH}`, opts);
  }
  return parseWalletUrl(text, opts);
}

/**
 * ?byow_wallet=<url or domain> lets a wallet publish an "open this site with my wallet" link. It only
 * PREFILLS the wallet field. It must never open anything: that needs a user gesture, and a link is not one.
 * A phishing link can carry this parameter too, which is why the user still has to choose to use it.
 */
export function walletFromLocation(search: string): string | null {
  const raw = new URLSearchParams(search).get("byow_wallet");
  if (!raw) return null;
  try {
    return resolveWallet(raw).href;
  } catch {
    return null;
  }
}

export interface RememberedWallet {
  url: string;
  /** Claimed by the wallet. Display as a claim, next to the origin. */
  name: string;
  /**
   * Claimed by the wallet too: the manifest's icon, kept so a returning user recognises their wallet. Held to the
   * manifest's rule (a small png, jpeg or webp data URI) on the way in and on every read. Never shown larger than,
   * or instead of, the origin.
   */
  icon?: string;
  origin: string;
  lastUsed: number;
}

const MAX_REMEMBERED = 12;

/** The manifest's icon rule (SPEC 4), applied again to anything read back from storage. */
const validIcon = (icon: unknown): string | undefined =>
  typeof icon === "string" && icon.length <= MAX_ICON_CHARS && ICON_RE.test(icon) ? icon : undefined;

/** Wallets this user has used on this site. localStorage on the site's own origin: no secrets, no cross-site state. */
export function rememberedWallets(storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(), key = "byow:wallets") {
  const read = (): RememberedWallet[] => {
    try {
      const raw = JSON.parse(storage?.getItem(key) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((e): RememberedWallet[] => {
        try {
          const u = parseWalletUrl(String(e?.url));
          const icon = validIcon(e?.icon);
          return [{ url: u.href, origin: u.origin, name: safeText(String(e?.name ?? ""), 64), ...(icon ? { icon } : {}), lastUsed: Number(e?.lastUsed) || 0 }];
        } catch {
          return []; // a tampered entry is dropped, never trusted
        }
      });
    } catch {
      return [];
    }
  };
  const write = (list: RememberedWallet[]) => {
    try {
      storage?.setItem(key, JSON.stringify(list.slice(0, MAX_REMEMBERED)));
    } catch {
      /* private mode or quota: remembering is a convenience */
    }
  };
  return {
    list: () => read().sort((a, b) => b.lastUsed - a.lastUsed),
    /** `icon` is the manifest's, if it sent one. A wallet that stops sending one loses the stored one. */
    remember(url: string, name: string, icon?: string) {
      const u = parseWalletUrl(url);
      const rest = read().filter((w) => w.url !== u.href);
      const ok = validIcon(icon);
      write([{ url: u.href, origin: u.origin, name: safeText(name, 64), ...(ok ? { icon: ok } : {}), lastUsed: Date.now() }, ...rest]);
    },
    forget(url: string) {
      let href = url;
      try {
        href = parseWalletUrl(url).href; // same normalisation remember() used, so "https://a.example" matches "https://a.example/"
      } catch {
        /* compare as given */
      }
      write(read().filter((w) => w.url !== href));
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
