import { build } from "esbuild";
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".test/worker.mjs",
});
