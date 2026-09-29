import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// oxlint-disable-next-line import/default -- CommonJS: the default import is module.exports.
import anchor, { type Idl } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, type Connection } from "@solana/web3.js";
import type { AccountToLoad, ProgramToLoad } from "./validator.js";

// CommonJS package: named ESM imports fail under plain Node (`pnpm demo`).
export { anchor };
// oxlint-disable-next-line import/no-named-as-default-member -- see above.
const { AnchorProvider, BN, BorshAccountsCoder, Program, Wallet } = anchor;
type Program = InstanceType<typeof Program>;

const EXAMPLE = fileURLToPath(new URL("../../../../examples/xray-demo", import.meta.url));
const IDL_DIR = path.join(EXAMPLE, "target", "idl");
const DEPLOY_DIR = path.join(EXAMPLE, "target", "deploy");

export const VAULT_ID = "6PLfEPyKqpNThbdTSCBVuUBAjUpZCoh3DzdTDeLsbGh4";
export const REGISTRY_ID = "DtkVbe7MzaPYfZ5cgmp1QaVWtd592LW5ffG5BVUp3sGx";

export function exampleRoot(): string {
  return EXAMPLE;
}

export function exampleBuilt(): boolean {
  return ["xray_vault", "xray_registry"].every(
    (n) =>
      fs.existsSync(path.join(DEPLOY_DIR, `${n}.so`)) &&
      fs.existsSync(path.join(IDL_DIR, `${n}.json`)),
  );
}

export function loadIdl(name: string): Idl {
  return JSON.parse(fs.readFileSync(path.join(IDL_DIR, `${name}.json`), "utf8")) as Idl;
}

export function programsToLoad(
  vaultAuthority: PublicKey,
  registryAuthority: PublicKey,
): ProgramToLoad[] {
  return [
    {
      id: VAULT_ID,
      so: path.join(DEPLOY_DIR, "xray_vault.so"),
      upgradeAuthority: vaultAuthority.toBase58(),
    },
    {
      id: REGISTRY_ID,
      so: path.join(DEPLOY_DIR, "xray_registry.so"),
      upgradeAuthority: registryAuthority.toBase58(),
    },
  ];
}

/**
 * Accounts injected at genesis that no instruction could create: a Config at a
 * non-canonical bump, and a program-owned account with an unknown discriminator.
 */
export async function injectedAccounts(
  admin: PublicKey,
): Promise<{ accounts: AccountToLoad[]; nonCanonical: string; garbage: string }> {
  const programId = new PublicKey(VAULT_ID);
  const seeds = [Buffer.from("config")];
  const [, canonical] = PublicKey.findProgramAddressSync(seeds, programId);
  let found: { address: PublicKey; bump: number } | undefined;
  for (let bump = canonical - 1; bump >= 0 && !found; bump--) {
    try {
      found = {
        address: PublicKey.createProgramAddressSync([...seeds, Buffer.from([bump])], programId),
        bump,
      };
    } catch {
      // On-curve for this bump; try the next one.
    }
  }
  if (!found) throw new Error("no non-canonical bump found");
  const address = found.address;
  const coder = new BorshAccountsCoder(loadIdl("xray_vault"));
  const data = await coder.encode("Config", {
    admin,
    treasury: admin,
    fee_bps: 0,
    vault_count: new BN(0),
    bump: found.bump,
  });
  const garbage = Keypair.generate().publicKey;
  return {
    nonCanonical: address.toBase58(),
    garbage: garbage.toBase58(),
    accounts: [
      { address: address.toBase58(), owner: VAULT_ID, lamports: LAMPORTS_PER_SOL, data },
      {
        address: garbage.toBase58(),
        owner: VAULT_ID,
        lamports: LAMPORTS_PER_SOL,
        data: Buffer.alloc(40, 7),
      },
    ],
  };
}

export interface Actors {
  admin: Keypair;
  alice: Keypair;
  bob: Keypair;
  treasury: Keypair;
}

export interface Seeded {
  vaults: { alice1: PublicKey; alice2: PublicKey; bob7: PublicKey };
  config: PublicKey;
  registry: PublicKey;
  entry: PublicKey;
  receipts: PublicKey[];
}

/** Calls an instruction on an untyped Program (IDL loaded at runtime). */
export function ix(p: Program, name: string, ...args: unknown[]) {
  const method = p.methods[name];
  if (!method) throw new Error(`${name} is not an instruction of ${p.idl.metadata.name}`);
  return method(...args);
}

function program(connection: Connection, signer: Keypair, name: string): Program {
  const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: "confirmed" });
  return new Program(loadIdl(name), provider);
}

async function fund(connection: Connection, keys: PublicKey[]): Promise<void> {
  for (const key of keys) {
    const sig = await connection.requestAirdrop(key, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(
      { signature: sig, ...(await connection.getLatestBlockhash()) },
      "confirmed",
    );
  }
}

export function vaultPda(owner: PublicKey, id: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)],
    new PublicKey(VAULT_ID),
  )[0];
}

/** Drives the demo programs through a realistic sequence, including a failing transaction. */
export async function seed(connection: Connection, actors: Actors): Promise<Seeded> {
  const { admin, alice, bob, treasury } = actors;
  await fund(connection, [admin.publicKey, alice.publicKey, bob.publicKey]);
  const asAdmin = program(connection, admin, "xray_vault");
  const asAlice = program(connection, alice, "xray_vault");
  const asBob = program(connection, bob, "xray_vault");

  await ix(asAdmin, "initConfig", 250).accounts({ treasury: treasury.publicKey }).rpc();
  await ix(asAlice, "createVault", new BN(1), "alice-main").accounts({}).rpc();
  await ix(asAlice, "createVault", new BN(2), "alice-savings").accounts({}).rpc();
  await ix(asBob, "createVault", new BN(7), "bob").accounts({}).rpc();
  const vaults = {
    alice1: vaultPda(alice.publicKey, 1),
    alice2: vaultPda(alice.publicKey, 2),
    bob7: vaultPda(bob.publicKey, 7),
  };

  const receipts = [Keypair.generate(), Keypair.generate()];
  await ix(asBob, "deposit", new BN(LAMPORTS_PER_SOL))
    .accountsPartial({ vault: vaults.alice1, receipt: receipts[0]!.publicKey })
    .signers([receipts[0]!])
    .rpc();
  await ix(asAlice, "setDelegate", bob.publicKey).accountsPartial({ vault: vaults.alice1 }).rpc();
  await ix(asAdmin, "setState", { frozen: { reason: "audit" } })
    .accountsPartial({ vault: vaults.alice2 })
    .rpc();

  const failedReceipt = Keypair.generate();
  // Lands on chain but fails with VaultFrozen: exercises error decoding in the timeline.
  await ix(asBob, "deposit", new BN(1000))
    .accountsPartial({ vault: vaults.alice2, receipt: failedReceipt.publicKey })
    .signers([failedReceipt])
    .rpc({ skipPreflight: true })
    .then(
      () => {
        throw new Error("deposit into a frozen vault succeeded");
      },
      () => undefined,
    );

  const registryAsAlice = program(connection, alice, "xray_registry");
  await ix(registryAsAlice, "initRegistry").accounts({}).rpc();
  await ix(registryAsAlice, "register", "alice-main", ["demo", "main"])
    .accounts({ target: vaults.alice1 })
    .rpc();
  const registryAsBob = program(connection, bob, "xray_registry");
  await ix(registryAsBob, "depositViaRegistry", new BN(LAMPORTS_PER_SOL / 2))
    .accountsPartial({ vault: vaults.alice1, receipt: receipts[1]!.publicKey })
    .signers([receipts[1]!])
    .rpc();
  await ix(asAlice, "withdraw", new BN(LAMPORTS_PER_SOL / 4))
    .accountsPartial({ vault: vaults.alice1 })
    .rpc();

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    new PublicKey(VAULT_ID),
  );
  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("registry"), alice.publicKey.toBuffer()],
    new PublicKey(REGISTRY_ID),
  );
  const [entry] = PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), vaults.alice1.toBuffer()],
    new PublicKey(REGISTRY_ID),
  );
  return { vaults, config, registry, entry, receipts: receipts.map((r) => r.publicKey) };
}

/** Genesis Vault and Receipt accounts, as a large deployed program would have. */
export async function bulkAccounts(vaults: number, receipts: number): Promise<AccountToLoad[]> {
  const coder = new BorshAccountsCoder(loadIdl("xray_vault"));
  const programId = new PublicKey(VAULT_ID);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const accounts: AccountToLoad[] = [];
  for (let i = 0; i < vaults; i++) {
    const owner = Keypair.generate().publicKey;
    const id = new BN(i);
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      programId,
    );
    const data = await coder.encode("Vault", {
      owner,
      config,
      vault_id: id,
      label: `vault-${i}`,
      state: { Active: {} },
      total_deposits: new BN(0),
      delegate: null,
      bump,
    });
    accounts.push({
      address: address.toBase58(),
      owner: VAULT_ID,
      lamports: LAMPORTS_PER_SOL,
      data,
    });
  }
  for (let i = 0; i < receipts; i++) {
    const data = await coder.encode("Receipt", {
      vault: new PublicKey(accounts[i]?.address ?? VAULT_ID),
      depositor: Keypair.generate().publicKey,
      amount: new BN(i),
      slot: new BN(0),
    });
    const address = Keypair.generate().publicKey.toBase58();
    accounts.push({ address, owner: VAULT_ID, lamports: LAMPORTS_PER_SOL, data });
  }
  return accounts;
}
