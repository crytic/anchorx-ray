import { createHash } from "node:crypto";
import { utils } from "./anchor.js";
import {
  PublicKey,
  type AccountInfo,
  type Commitment,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { referencedAddresses } from "./analyze.js";
import type { CodecRegistry } from "./codec.js";
import { UPGRADEABLE_LOADER } from "./known.js";
import type { RawTransaction, RawTxInstruction } from "./tx.js";
import type { Json, RawAccount, RawState } from "./types.js";

const BATCH = 100;

const PROGRAM_DATA_HEADER = 45;

export function toRawAccount(address: string, info: AccountInfo<Buffer>): RawAccount {
  const account: RawAccount = {
    address,
    owner: info.owner.toBase58(),
    lamports: info.lamports,
    executable: info.executable,
    data: info.data.toString("base64"),
  };
  const isProgramData =
    account.owner === UPGRADEABLE_LOADER &&
    info.data.length > PROGRAM_DATA_HEADER &&
    info.data.readUInt32LE(0) === 3;
  if (isProgramData) {
    // Keep snapshots small: the binary itself is only compared by hash.
    account.data = info.data.subarray(0, PROGRAM_DATA_HEADER).toString("base64");
    account.truncated = {
      length: info.data.length,
      sha256: createHash("sha256").update(info.data).digest("hex"),
    };
  }
  return account;
}

/** Fetches accounts in RPC-sized batches, splitting found from missing addresses. */
export async function fetchMany(
  connection: Connection,
  addresses: string[],
  commitment: Commitment = "confirmed",
) {
  const found: RawAccount[] = [];
  const missing: string[] = [];
  for (let i = 0; i < addresses.length; i += BATCH) {
    const chunk = addresses.slice(i, i + BATCH);
    const infos = await connection.getMultipleAccountsInfo(
      chunk.map((a) => new PublicKey(a)),
      commitment,
    );
    chunk.forEach((address, j) => {
      const info = infos[j];
      if (info) found.push(toRawAccount(address, info));
      else missing.push(address);
    });
  }
  return { found, missing };
}

/**
 * Fetches the program accounts, every account they own, and the accounts
 * their data references (plus ProgramData of referenced programs).
 */
export async function fetchState(
  connection: Connection,
  codecs: CodecRegistry,
  commitment: Commitment = "confirmed",
): Promise<RawState> {
  const slot = await connection.getSlot(commitment);
  const programs = await fetchMany(connection, codecs.ids(), commitment);
  const accounts: RawAccount[] = [...programs.found];
  for (const id of codecs.ids()) {
    const owned = await connection.getProgramAccounts(new PublicKey(id), { commitment });
    for (const { pubkey, account } of owned)
      accounts.push(toRawAccount(pubkey.toBase58(), account));
  }
  const refs = await fetchMany(connection, referencedAddresses(accounts, codecs), commitment);
  // ProgramData accounts of referenced programs are one more hop away.
  const next = await fetchMany(connection, referencedAddresses(refs.found, codecs), commitment);
  return {
    slot,
    fetchedAt: new Date().toISOString(),
    accounts,
    referenced: [...refs.found, ...next.found],
    missing: [...programs.missing, ...refs.missing, ...next.missing],
  };
}

function accountKeysOf(tx: VersionedTransactionResponse): RawTransaction["accountKeys"] {
  const message = tx.transaction.message;
  const lookups = tx.meta?.loadedAddresses;
  const keys = message.getAccountKeys(lookups ? { accountKeysFromLookups: lookups } : {});
  return keys
    .keySegments()
    .flat()
    .map((key, i) => ({
      pubkey: key.toBase58(),
      signer: message.isAccountSigner(i),
      writable: message.isAccountWritable(i),
    }));
}

/** Interleaves each top-level instruction with the CPIs it made, in execution order. */
function instructionsOf(tx: VersionedTransactionResponse): RawTxInstruction[] {
  const inner = new Map(
    (tx.meta?.innerInstructions ?? []).map((set) => [set.index, set.instructions]),
  );
  return tx.transaction.message.compiledInstructions.flatMap((ix, i) => [
    {
      programIdIndex: ix.programIdIndex,
      accounts: [...ix.accountKeyIndexes],
      data: Buffer.from(ix.data).toString("base64"),
      stackHeight: 1,
    },
    ...(inner.get(i) ?? []).map((cpi) => ({
      programIdIndex: cpi.programIdIndex,
      accounts: [...cpi.accounts],
      data: Buffer.from(utils.bytes.bs58.decode(cpi.data)).toString("base64"),
      // RPC nodes report stackHeight; older ones omit it, so assume a direct CPI.
      stackHeight: (cpi as { stackHeight?: number | null }).stackHeight ?? 2,
    })),
  ]);
}

function metaFields(meta: VersionedTransactionResponse["meta"]) {
  if (!meta)
    return { err: null, fee: 0, computeUnits: null, logs: [], preBalances: [], postBalances: [] };
  return {
    err: meta.err as Json,
    fee: meta.fee,
    computeUnits: meta.computeUnitsConsumed ?? null,
    logs: meta.logMessages ?? [],
    preBalances: meta.preBalances,
    postBalances: meta.postBalances,
  };
}

export function toRawTransaction(
  signature: string,
  tx: VersionedTransactionResponse,
): RawTransaction {
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    accountKeys: accountKeysOf(tx),
    instructions: instructionsOf(tx),
    ...metaFields(tx.meta),
  };
}

export async function fetchTransaction(
  connection: Connection,
  signature: string,
): Promise<RawTransaction | undefined> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx ? toRawTransaction(signature, tx) : undefined;
}

/** Fetches the most recent `limit` transactions that invoked any of the programs, newest first. */
export async function fetchRecentTransactions(
  connection: Connection,
  programIds: string[],
  limit: number,
): Promise<RawTransaction[]> {
  if (limit <= 0) return [];
  const signatures = new Map<string, number>();
  for (const id of programIds) {
    const infos = await connection.getSignaturesForAddress(
      new PublicKey(id),
      { limit },
      "confirmed",
    );
    for (const info of infos) signatures.set(info.signature, info.slot);
  }
  const newest = [...signatures.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, limit);
  const txs: RawTransaction[] = [];
  for (const [signature] of newest) {
    const tx = await fetchTransaction(connection, signature);
    if (tx) txs.push(tx);
  }
  return txs;
}
