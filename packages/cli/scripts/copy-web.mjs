import fs from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../web/dist", import.meta.url));
const to = fileURLToPath(new URL("../dist/web", import.meta.url));
if (!fs.existsSync(from)) {
  console.error(
    `Web UI build not found at ${from}; run \`pnpm --filter @anchorx-ray/web build\` first.`,
  );
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
