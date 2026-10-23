import fs from "node:fs";
import path from "node:path";
import type { RawTransaction } from "./tx.js";
import type { RawState } from "./types.js";

export const SNAPSHOT_FORMAT = "anchorx-ray/snapshot@1";

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  name: string;
  createdAt: string;
  rpcUrl: string;
  programs: { id: string; name: string }[];
  state: RawState;
  transactions: RawTransaction[];
}

export interface SnapshotSummary {
  name: string;
  createdAt: string;
  slot: number;
  accounts: number;
  transactions: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function snapshotDir(root: string): string {
  return path.join(root, ".anchorx-ray", "snapshots");
}

/** Name that `diff` reserves for the current cluster state. */
export const LIVE = "live";

function fileFor(root: string, name: string): string {
  if (name === LIVE)
    throw new Error(`"${LIVE}" is reserved for the current state; pick another name`);
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid snapshot name "${name}": use letters, digits, ".", "_" or "-" (max 64 chars)`,
    );
  }
  return path.join(snapshotDir(root), `${name}.json`);
}

export function saveSnapshot(root: string, snapshot: Snapshot): string {
  const file = fileFor(root, snapshot.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot)}\n`);
  return file;
}

export function loadSnapshot(root: string, name: string): Snapshot {
  const file = fileFor(root, name);
  if (!fs.existsSync(file)) throw new Error(`Snapshot "${name}" not found in ${snapshotDir(root)}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Snapshot>;
  if (parsed.format !== SNAPSHOT_FORMAT || !parsed.state) {
    throw new Error(`${file} is not an ${SNAPSHOT_FORMAT} file`);
  }
  return parsed as Snapshot;
}

export function listSnapshots(root: string): SnapshotSummary[] {
  const dir = snapshotDir(root);
  if (!fs.existsSync(dir)) return [];
  const out: SnapshotSummary[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const snapshot = loadSnapshot(root, file.slice(0, -5));
    out.push({
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      slot: snapshot.state.slot,
      accounts: snapshot.state.accounts.length + snapshot.state.referenced.length,
      transactions: snapshot.transactions.length,
    });
  }
  return out.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}
