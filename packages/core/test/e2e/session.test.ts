import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  loadWorkspace,
  Session,
  type AccountNode,
  type SessionEvent,
  type Workspace,
  type XrayModel,
} from "@anchorx-ray/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  anchor,
  exampleBuilt,
  exampleRoot,
  injectedAccounts,
  ix,
  loadIdl,
  programsToLoad,
  REGISTRY_ID,
  seed,
  VAULT_ID,
  type Actors,
  type Seeded,
} from "./scenario.js";
import { hasValidator, startValidator, type Validator } from "./validator.js";

const { AnchorProvider, BN, Program, Wallet } = anchor;
const FIXTURE = fileURLToPath(new URL("../fixtures/demo-snapshot.json", import.meta.url));
const ready = hasValidator() && exampleBuilt();

function node(model: XrayModel, address: { toBase58(): string } | string): AccountNode {
  const key = typeof address === "string" ? address : address.toBase58();
  const found = model.accounts.find((a) => a.address === key);
  if (!found) throw new Error(`no node for ${key}`);
  return found;
}

function nextEvent(
  session: Session,
  match: (e: SessionEvent) => boolean,
  ms = 20_000,
): Promise<SessionEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for session event")), ms);
    const listener = (event: SessionEvent) => {
      if (!match(event)) return;
      clearTimeout(timer);
      session.off("event", listener);
      resolve(event);
    };
    session.on("event", listener);
  });
}

describe.skipIf(!ready)("against solana-test-validator", () => {
  let validator: Validator;
  let actors: Actors;
  let seeded: Seeded;
  let injected: Awaited<ReturnType<typeof injectedAccounts>>;
  let workspace: Workspace;
  let root: string;

  beforeAll(async () => {
    actors = {
      admin: Keypair.generate(),
      alice: Keypair.generate(),
      bob: Keypair.generate(),
      treasury: Keypair.generate(),
    };
    injected = await injectedAccounts(actors.admin.publicKey);
    validator = await startValidator(
      programsToLoad(actors.admin.publicKey, actors.bob.publicKey),
      injected.accounts,
    );
    seeded = await seed(validator.connection, actors);
    // Snapshots are written under the workspace root; keep them out of the example folder.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anchorx-ray-ws-"));
    workspace = { ...loadWorkspace({ root: exampleRoot() }), root };
  });

  afterAll(async () => {
    await validator?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const session = (txLimit = 50) => new Session({ workspace, rpcUrl: validator.rpcUrl, txLimit });

  test("builds the account graph with verified PDAs and findings", async () => {
    const s = session();
    const model = await s.refresh();
    expect(model.programs.map((p) => [p.name, p.deployed])).toEqual([
      ["xray_registry", true],
      ["xray_vault", true],
    ]);
    expect(node(model, VAULT_ID).upgradeAuthority).toBe(actors.admin.publicKey.toBase58());
    expect(node(model, REGISTRY_ID).upgradeAuthority).toBe(actors.bob.publicKey.toBase58());

    const vault = node(model, seeded.vaults.alice1);
    expect(vault).toMatchObject({ kind: "pda", typeName: "Vault", label: "Vault" });
    expect(vault.pda).toMatchObject({
      status: "verified",
      method: "transaction",
      bump: vault.pda?.canonicalBump,
    });
    expect(vault.pda?.seeds?.map((x) => x.display)).toEqual([
      '"vault"',
      actors.alice.publicKey.toBase58(),
      "1",
    ]);
    expect(node(model, seeded.entry).pda?.seeds?.[1]?.pubkey).toBe(seeded.vaults.alice1.toBase58());
    expect(node(model, seeded.receipts[0]!)).toMatchObject({
      kind: "keypair",
      typeName: "Receipt",
    });

    const codes = (address: string) => node(model, address).findings.map((f) => f.code);
    expect(codes(injected.nonCanonical)).toContain("pda-noncanonical-bump");
    expect(codes(injected.garbage)).toContain("undecodable-account");
    expect(codes(seeded.config.toBase58())).toContain("dangling-reference");

    const ownerEdge = model.edges.find(
      (e) =>
        e.kind === "field" && e.from === seeded.vaults.alice1.toBase58() && e.label === "owner",
    );
    expect(ownerEdge?.to).toBe(actors.alice.publicKey.toBase58());
    expect(ownerEdge?.constrainedBy).toEqual(expect.arrayContaining(["set_delegate", "withdraw"]));
    const delegateEdge = model.edges.find(
      (e) => e.from === seeded.vaults.alice1.toBase58() && e.label === "delegate",
    );
    expect(delegateEdge?.to).toBe(actors.bob.publicKey.toBase58());
    expect(delegateEdge?.constrainedBy).toBeUndefined();
  });

  test("recovers PDA seeds from account data when no transaction is available", async () => {
    const model = await session(0).refresh();
    for (const address of [
      seeded.vaults.alice1,
      seeded.vaults.bob7,
      seeded.config,
      seeded.registry,
      seeded.entry,
    ]) {
      expect(node(model, address).pda).toMatchObject({
        status: "verified",
        method: "account-data",
      });
    }
  });

  test("decodes the transaction timeline", async () => {
    const s = session();
    await s.refresh();
    const timeline = s.timeline();
    const failed = timeline.find((t) => !t.success);
    expect(failed?.error).toMatchObject({ name: "VaultFrozen", code: 6001, program: VAULT_ID });

    const viaRegistry = timeline.find((t) => t.instructions[0]?.name === "deposit_via_registry");
    expect(viaRegistry?.instructions.map((i) => [i.index, i.programName, i.name])).toEqual(
      expect.arrayContaining([["1.1", "xray_vault", "deposit"]]),
    );
    expect(viaRegistry?.events).toEqual([
      expect.objectContaining({ name: "Deposited", via: "log" }),
    ]);

    const register = timeline.find((t) => t.instructions[0]?.name === "register");
    expect(register?.events).toEqual([
      expect.objectContaining({ name: "EntryRegistered", via: "cpi" }),
    ]);
    const first = register?.instructions[0];
    expect(first?.args).toEqual({ name: "alice-main", tags: ["demo", "main"] });
    expect(first?.accounts.map((a) => a.name)).toContain("entry");
  });

  test("streams account changes and attributes them to transactions", async () => {
    const s = session();
    await s.refresh();
    s.startWatch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const txEvent = nextEvent(
      s,
      (e) => e.type === "transaction" && e.item.instructions[0]?.name === "deposit",
    );
    const accountEvent = nextEvent(
      s,
      (e) => e.type === "account" && e.change.diff.address === seeded.vaults.bob7.toBase58(),
    );
    const receipt = Keypair.generate();
    const provider = new AnchorProvider(validator.connection, new Wallet(actors.alice), {
      commitment: "confirmed",
    });
    await ix(new Program(loadIdl("xray_vault"), provider), "deposit", new BN(LAMPORTS_PER_SOL))
      .accountsPartial({ vault: seeded.vaults.bob7, receipt: receipt.publicKey })
      .signers([receipt])
      .rpc();

    const change = await accountEvent;
    expect(change.type === "account" && change.change.diff.fields).toEqual(
      expect.arrayContaining([
        { path: "total_deposits", before: "0", after: String(LAMPORTS_PER_SOL) },
      ]),
    );
    await txEvent;
    // The diff is joined lazily, whichever notification arrived first.
    const item = s
      .timeline()
      .find(
        (t) =>
          t.instructions[0]?.name === "deposit" &&
          t.slot === (change.type === "account" ? change.change.slot : -1),
      );
    expect(item?.accountDiffs.map((d) => d.address)).toContain(seeded.vaults.bob7.toBase58());
    await s.stopWatch();
  });

  test("saves snapshots and diffs them against live state", async () => {
    const s = session();
    await s.refresh();
    s.saveSnapshot("before-withdraw");
    const provider = new AnchorProvider(validator.connection, new Wallet(actors.bob), {
      commitment: "confirmed",
    });
    await ix(new Program(loadIdl("xray_vault"), provider), "withdraw", new BN(LAMPORTS_PER_SOL / 2))
      .accountsPartial({ vault: seeded.vaults.bob7 })
      .rpc();
    await s.refresh();
    const diff = s.diff("before-withdraw", "live");
    const vaultDiff = diff.accounts.find((a) => a.address === seeded.vaults.bob7.toBase58());
    expect(vaultDiff).toMatchObject({ change: "modified", typeName: "Vault" });
    expect(vaultDiff?.fields).toEqual([
      {
        path: "total_deposits",
        before: String(LAMPORTS_PER_SOL),
        after: String(LAMPORTS_PER_SOL / 2),
      },
    ]);
    expect(s.snapshots().map((x) => x.name)).toEqual(["before-withdraw"]);
    if (process.env["ANCHORX_RAY_WRITE_FIXTURE"]) {
      s.saveSnapshot("demo");
      fs.copyFileSync(path.join(root, ".anchorx-ray", "snapshots", "demo.json"), FIXTURE);
    }
  });
});
