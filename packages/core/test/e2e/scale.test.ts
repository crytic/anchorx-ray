import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadWorkspace, Session, type Workspace, type XrayModel } from "@anchorx-ray/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bulkAccounts, exampleBuilt, exampleRoot, programsToLoad, VAULT_ID } from "./scenario.js";
import { hasValidator, startValidator, type AccountToLoad, type Validator } from "./validator.js";

const VAULTS = 3000;
const RECEIPTS = 200;
const ready = hasValidator() && exampleBuilt();

const typeRow = (model: XrayModel, typeName: string) =>
  model.programs.find((p) => p.id === VAULT_ID)?.inventory.find((r) => r.typeName === typeName);

describe.skipIf(!ready)("a program with thousands of accounts", () => {
  let validator: Validator;
  let workspace: Workspace;
  let root: string;
  let injected: AccountToLoad[];

  beforeAll(async () => {
    injected = await bulkAccounts(VAULTS, RECEIPTS);
    const authority = Keypair.generate().publicKey;
    validator = await startValidator(programsToLoad(authority, authority), injected, 28899);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anchorx-ray-scale-"));
    workspace = { ...loadWorkspace({ root: exampleRoot() }), root };
  });

  afterAll(async () => {
    await validator?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const session = (maxAccounts: number) =>
    new Session({ workspace, rpcUrl: validator.rpcUrl, txLimit: 10, maxAccounts });

  test("lists every account but loads only the cap, keeping every type represented", async () => {
    const s = session(500);
    const model = await s.refresh();
    const vaults = typeRow(model, "Vault");
    // 300 picked directly, plus vaults pulled in as references of loaded receipts.
    expect(vaults?.total).toBe(VAULTS);
    expect(vaults?.loaded).toBeGreaterThanOrEqual(300);
    expect(vaults?.loaded).toBeLessThanOrEqual(300 + RECEIPTS);
    expect(typeRow(model, "Receipt")).toEqual({
      typeName: "Receipt",
      total: RECEIPTS,
      loaded: RECEIPTS,
    });
    const owned = model.accounts.filter((a) => a.program === VAULT_ID && a.kind !== "program");
    expect(owned).toHaveLength((vaults?.loaded ?? 0) + RECEIPTS);

    const more = await s.loadMore(VAULT_ID, "Vault", 1000);
    expect(typeRow(more, "Vault")?.loaded).toBe((vaults?.loaded ?? 0) + 1000);

    const target = injected.find((a) => !more.accounts.some((n) => n.address === a.address));
    if (!target) throw new Error("expected an unloaded account");
    const withTarget = await s.loadAddresses([target.address]);
    expect(withTarget.accounts.find((a) => a.address === target.address)?.typeName).toBeDefined();
  });

  test("analyzes all of them in reasonable time", async () => {
    const started = Date.now();
    const model = await session(VAULTS + RECEIPTS).refresh();
    const elapsed = Date.now() - started;
    const vaults = model.accounts.filter((a) => a.typeName === "Vault");
    expect(vaults).toHaveLength(VAULTS);
    expect(vaults.every((v) => v.pda?.status === "verified")).toBe(true);
    expect(elapsed).toBeLessThan(60_000);
  });
});
