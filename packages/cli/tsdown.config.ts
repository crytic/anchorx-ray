import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  dts: false,
  // Bundle the workspace core library; keep published dependencies external.
  deps: { alwaysBundle: ["@anchorx-ray/core"] },
});
