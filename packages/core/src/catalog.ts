import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import type { CodecRegistry } from "./codec.js";
import type { CatalogEntry, InventoryRow, RawAccount } from "./types.js";

/** Longest discriminator we read during the cheap scan (Anchor's default is 8 bytes). */
const DISCRIMINATOR_BYTES = 8;

/**
 * Lists every account a program owns with its account type, reading only the
 * discriminator bytes. This stays cheap for programs with hundreds of
 * thousands of accounts, where fetching full data would exhaust memory.
 */
export async function scanCatalog(
  connection: Connection,
  codecs: CodecRegistry,
  commitment: Commitment = "confirmed",
): Promise<CatalogEntry[]> {
  const catalog: CatalogEntry[] = [];
  for (const codec of codecs.all()) {
    const owned = await connection.getProgramAccounts(new PublicKey(codec.id), {
      commitment,
      dataSlice: { offset: 0, length: DISCRIMINATOR_BYTES },
    });
    for (const { pubkey, account } of owned) {
      const typeName = codec.identifyAccount(account.data) ?? null;
      catalog.push({ address: pubkey.toBase58(), program: codec.id, typeName });
    }
  }
  return catalog;
}

const groupKey = (e: Pick<CatalogEntry, "program" | "typeName">) => `${e.program}:${e.typeName}`;

function groups(catalog: CatalogEntry[]): CatalogEntry[][] {
  const byKey = new Map<string, CatalogEntry[]>();
  for (const entry of catalog) {
    const list = byKey.get(groupKey(entry));
    if (list) list.push(entry);
    else byKey.set(groupKey(entry), [entry]);
  }
  return [...byKey.values()];
}

/**
 * Picks up to `max` entries, round-robin across (program, type) groups so a
 * type with few accounts is not crowded out by one with millions.
 */
export function selectInitial(catalog: CatalogEntry[], max: number): CatalogEntry[] {
  if (catalog.length <= max) return catalog;
  const queues = groups(catalog);
  const picked: CatalogEntry[] = [];
  for (let round = 0; picked.length < max; round++) {
    const before = picked.length;
    for (const queue of queues) {
      const entry = queue[round];
      if (entry && picked.length < max) picked.push(entry);
    }
    if (picked.length === before) break;
  }
  return picked;
}

/** The next `count` catalog entries of one (program, type) group that are not loaded yet. */
export function nextUnloaded(
  catalog: CatalogEntry[],
  loaded: Set<string>,
  program: string,
  typeName: string | null,
  count: number,
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const entry of catalog) {
    if (out.length >= count) break;
    if (entry.program === program && entry.typeName === typeName && !loaded.has(entry.address)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Per program and account type: how many accounts exist and how many are
 * loaded (fetched directly or as a reference of a loaded account).
 */
export function inventory(
  catalog: CatalogEntry[] | undefined,
  accounts: RawAccount[],
  codecs: CodecRegistry,
  referenced: RawAccount[] = [],
): InventoryRow[] {
  const loaded = new Set(accounts.concat(referenced).map((a) => a.address));
  // Without a catalog (e.g. an old snapshot), what is loaded is all we know about.
  const entries: CatalogEntry[] =
    catalog ??
    accounts
      .concat(referenced)
      .filter((a) => codecs.get(a.owner) && !a.executable)
      .map((a) => ({
        address: a.address,
        program: a.owner,
        typeName: codecs.get(a.owner)?.identifyAccount(Buffer.from(a.data, "base64")) ?? null,
      }));
  const rows = new Map<string, InventoryRow>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const row = rows.get(key) ?? {
      program: entry.program,
      typeName: entry.typeName,
      total: 0,
      loaded: 0,
    };
    row.total += 1;
    if (loaded.has(entry.address)) row.loaded += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}
