// Bundles the example wallet, the demo site's client, and its server. esbuild, no config files.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = { bundle: true, format: "iife", platform: "browser", target: "es2022", define: { global: "globalThis" }, logLevel: "warning" };

await Promise.all([
  build({ ...browser, entryPoints: [path.join(root, "examples/toy-wallet/wallet.ts")], outfile: path.join(root, "examples/toy-wallet/dist/wallet.js") }),
  build({ ...browser, entryPoints: [path.join(root, "examples/demo-dapp/app.ts")], outfile: path.join(root, "examples/demo-dapp/dist/app.js") }),
  build({ ...browser, entryPoints: [path.join(root, "examples/demo-dapp/return.ts")], outfile: path.join(root, "examples/demo-dapp/dist/return.js") }),
  build({
    bundle: true, format: "esm", platform: "node", target: "node20", packages: "external", logLevel: "warning",
    entryPoints: [path.join(root, "examples/demo-dapp/server.ts")], outfile: path.join(root, "examples/demo-dapp/dist/server.mjs"),
  }),
]);
console.log("examples built");
