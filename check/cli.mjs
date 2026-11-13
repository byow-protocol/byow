#!/usr/bin/env node
// byow-check entry point. Bundles run.ts on the fly (it shares src/protocol.ts with the SDK) and runs it.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, ".build", "run.mjs");
process.env.BYOW_CHECK_DIR = here;
await build({ entryPoints: [path.join(here, "run.ts")], outfile: out, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "error" });
const { main } = await import(pathToFileURL(out).href);
process.exit(await main(process.argv.slice(2)));
