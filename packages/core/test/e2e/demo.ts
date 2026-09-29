// Starts solana-test-validator with the xray-demo programs, runs the e2e scenario
// and keeps the validator up so the CLI/UI can be pointed at it: `pnpm demo`.
import { Keypair } from "@solana/web3.js";
import { bulkAccounts, exampleBuilt, injectedAccounts, programsToLoad, seed } from "./scenario.js";
import { hasValidator, startValidator } from "./validator.js";

if (!hasValidator() || !exampleBuilt()) {
  console.error("Needs solana-test-validator on PATH and `anchor build` in examples/xray-demo.");
  process.exit(1);
}
const actors = {
  admin: Keypair.generate(),
  alice: Keypair.generate(),
  bob: Keypair.generate(),
  treasury: Keypair.generate(),
};
const injected = await injectedAccounts(actors.admin.publicKey);
// DEMO_BULK=3000 adds that many extra vaults (plus receipts) to try large-program loading.
const bulk = Number(process.env["DEMO_BULK"] ?? 0);
if (bulk > 0) injected.accounts.push(...(await bulkAccounts(bulk, Math.ceil(bulk / 15))));
const port = Number(process.env["DEMO_RPC_PORT"] ?? 8899);
const validator = await startValidator(
  programsToLoad(actors.admin.publicKey, actors.bob.publicKey),
  injected.accounts,
  port,
);
await seed(validator.connection, actors);
console.log(`Demo validator ready at ${validator.rpcUrl}. In examples/xray-demo run: anchorx-ray`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void validator.stop().then(() => process.exit(0)));
}
