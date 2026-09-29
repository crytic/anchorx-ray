import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@anchorx-ray/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          exclude: ["packages/*/test/e2e/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "e2e",
          include: ["packages/core/test/e2e/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
