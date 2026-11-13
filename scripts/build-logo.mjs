// Draws the BYOW logo into assets/: the mark, the wordmark, the two lockups and GitHub's social preview.
// Change the drawing here and run `node scripts/build-logo.mjs`; never edit the SVGs by hand.
// The PNG needs Playwright's Chromium (`npx playwright install chromium`).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets");
mkdirSync(out, { recursive: true });

const INK = "#16181d";
const PAPER = "#f5f2ea";
const KRAFT = "#c4925a";
const n = (x) => +x.toFixed(2);

/*
 * The mark: a paper bag with a wallet dropped in it, on a 64 grid.
 * - The bag is a rectangle whose top is pinked (cut in a zigzag, as a paper bag's mouth is).
 * - The wallet is a rounded rectangle with its clasp on the right edge, turned -16 degrees so it reads as
 *   dropped in rather than resting on top like a lid. A gap cut around the bag keeps the two apart in one
 *   colour.
 * - Two cuts of one drawing. "full" from 32px up. "small" at 24px and under, where seven teeth and the
 *   clasp's dot turn to mush: four deeper teeth, a wider gap, a heavier clasp line, no dot.
 * - Tried and dropped on 2026-11-12: a bottle cap with a W (too close to WordPress's mark), five big teeth
 *   (a mouth biting a wallet), a flared bag (a cupcake liner), a side panel (it didn't come through).
 */
const CUTS = {
  full: { bag: { x0: 15, x1: 49, top: 29, depth: 3, teeth: 7, bottom: 58, r: 2.5 }, gap: 5, clasp: 2.6, dot: 1.9 },
  small: { bag: { x0: 14, x1: 50, top: 30, depth: 5, teeth: 4, bottom: 58, r: 2.5 }, gap: 8, clasp: 4, dot: 0 },
};
const WALLET = { x: 19, y: 10, w: 26, h: 23, r: 4.5, turn: "rotate(-16 32 21)" };
const CLASP = "M45 13H39.5a3.5 3.5 0 0 0-3.5 3.5v2.5a3.5 3.5 0 0 0 3.5 3.5H45";
const DOT = { cx: 40.1, cy: 17.75 };
/** Where the full mark's ink sits on the grid, after its 0.5 lift: the lockups crop to it. */
const MARK_INK = { x0: 15, y0: 7.4, x1: 49, y1: 57.5 };

function bagPath({ x0, x1, top, depth, teeth, bottom, r }) {
  const w = (x1 - x0) / teeth;
  let d = `M${x0} ${top}`;
  for (let i = 0; i < teeth; i++) d += `L${n(x0 + w * (i + 0.5))} ${top - depth}L${n(x0 + w * (i + 1))} ${top}`;
  return d + `V${bottom - r}A${r} ${r} 0 0 1 ${x1 - r} ${bottom}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${bottom - r}Z`;
}

/** The mark's drawing without its <svg>, so a lockup can place it. `id` names its mask: unique per page. */
function mark(id, { cut = "full", bag = "currentColor", wallet = "currentColor" } = {}) {
  const c = CUTS[cut];
  const b = bagPath(c.bag);
  return (
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">` +
    `<rect x="-8" y="-8" width="80" height="80" fill="#fff"/>` +
    `<g transform="${WALLET.turn}"><path d="${CLASP}" fill="none" stroke="#000" stroke-width="${c.clasp}"/>` +
    (c.dot ? `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${c.dot}" fill="#000"/>` : "") +
    `</g><path d="${b}" fill="#000" stroke="#000" stroke-width="${c.gap}" stroke-linejoin="round"/></mask></defs>` +
    `<g transform="translate(0 -0.5)"><g mask="url(#${id})">` +
    `<rect transform="${WALLET.turn}" x="${WALLET.x}" y="${WALLET.y}" width="${WALLET.w}" height="${WALLET.h}" rx="${WALLET.r}" fill="${wallet}"/>` +
    `</g><path d="${b}" fill="${bag}"/></g>`
  );
}

/*
 * The wordmark: BYOW in one rounded monoline, stroke 6 on a cap height of 40, drawn as strokes so it needs
 * no font. The B's lower bowl is wider than its upper; the W's middle peak sits 7 below the cap line.
 */
const WORD = (() => {
  const s = 6, h = s / 2, top = 10, base = 50, mid = 30;
  const xb = 4; // the B's stem
  const xy = xb + 14 + 10.5 + h + 2.5 + h; // the Y's left arm, clear of the B's lower bowl
  const ox = xy + 26 + h + 2.5 + 20.4 + h; // the O's centre
  const xw = ox + 20.4 + h + 3 + h; // the W's first stroke
  const d =
    `M${xb} ${top}V${base}M${xb} ${top}H${xb + 12}a9.5 9.5 0 0 1 0 19H${xb}M${xb} ${top + 19}H${xb + 14}a10.5 10.5 0 0 1 0 21H${xb}` +
    `M${xy} ${top}L${xy + 13} ${mid + 1}L${xy + 26} ${top}M${xy + 13} ${mid + 1}V${base}` +
    `M${n(xw)} ${top}L${n(xw + 10.5)} ${base}L${n(xw + 21)} ${top + 7}L${n(xw + 31.5)} ${base}L${n(xw + 42)} ${top}`;
  return { s, d, ox: n(ox), mid, y0: top - h - 3, w: n(xw + 42 + h + 2), h: base - top + s + 6, inkRight: xw + 42 + h };
})();
const word = (color) =>
  `<path d="${WORD.d}" fill="none" stroke="${color}" stroke-width="${WORD.s}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="${WORD.ox}" cy="${WORD.mid}" r="20.4" fill="none" stroke="${color}" stroke-width="${WORD.s}"/>`;

const svg = (box, body) => {
  const [, , w, h] = box.split(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="${w}" height="${h}">${body}</svg>\n`;
};

/*
 * The lockup: the mark at 68/64 and the word 44 high, as the concept sheet settled them; the word about 22
 * clear of the bag, the two centred on each other, cropped to the ink with 1 to spare.
 */
function lockup(id, { bag, wallet, ink }) {
  const ms = 68 / 64;
  const ws = 44 / WORD.h;
  const wx = 74;
  const wy = 12.5;
  const x0 = MARK_INK.x0 * ms - 1;
  const y0 = MARK_INK.y0 * ms - 1;
  const x1 = wx + WORD.inkRight * ws + 1;
  const y1 = MARK_INK.y1 * ms + 1;
  return svg(
    `${n(x0)} ${n(y0)} ${n(x1 - x0)} ${n(y1 - y0)}`,
    `<g transform="scale(${+ms.toFixed(4)})">${mark(id, { bag, wallet })}</g>` +
      `<g transform="translate(${wx} ${wy}) scale(${+ws.toFixed(4)}) translate(0 ${-WORD.y0})">${word(ink)}</g>`,
  );
}

const files = {
  "byow-mark.svg": svg("0 0 64 64", mark("byow-mark")),
  "byow-mark-small.svg": svg("0 0 64 64", mark("byow-mark-small", { cut: "small" })),
  "byow-mark-color.svg": svg("0 0 64 64", mark("byow-mark-color", { bag: KRAFT, wallet: INK })),
  "byow-mark-color-dark.svg": svg("0 0 64 64", mark("byow-mark-color-dark", { bag: KRAFT, wallet: PAPER })),
  "byow-wordmark.svg": svg(`0 ${WORD.y0} ${WORD.w} ${WORD.h}`, word("currentColor")),
  "byow-logo.svg": lockup("byow-logo", { bag: KRAFT, wallet: INK, ink: INK }),
  "byow-logo-dark.svg": lockup("byow-logo-dark", { bag: KRAFT, wallet: PAPER, ink: PAPER }),
};
for (const [name, body] of Object.entries(files)) writeFileSync(path.join(out, name), body);

// GitHub's social preview: 1280x640, uploaded by hand in the repository's settings.
const preview = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; }
body { width: 1280px; height: 640px; background: ${PAPER}; color: ${INK}; display: grid; place-items: center;
  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif; }
main { display: grid; justify-items: center; gap: 46px; }
main > svg { width: 600px; height: auto; display: block; }
h1 { margin: 0; font-size: 46px; font-weight: 650; letter-spacing: -0.01em; text-align: center; }
p { margin: 12px 0 0; font-size: 27px; color: #6d6a63; text-align: center; }
</style></head><body><main>${files["byow-logo.svg"]}<div><h1>Bring your own wallet.</h1>
<p>A protocol that lets any website work with any wallet.</p></div></main></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.setContent(preview);
await page.screenshot({ path: path.join(out, "social-preview.png") });
await browser.close();

console.log(`logo drawn: ${Object.keys(files).join(", ")}, social-preview.png`);
