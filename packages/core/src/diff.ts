import type { CodecRegistry } from "./codec.js";
import type { Json, RawAccount, RawState } from "./types.js";

export interface FieldChange {
  path: string;
  before: Json | undefined;
  after: Json | undefined;
}

export interface AccountDiff {
  address: string;
  change: "added" | "removed" | "modified";
  typeName?: string;
  lamports?: { before: number; after: number };
  owner?: { before: string; after: string };
  dataLen?: { before: number; after: number };
  /** Decoded field changes; empty when the data could not be decoded on both sides. */
  fields: FieldChange[];
  /** True when raw bytes changed but no decoded field explains it. */
  rawDataChanged: boolean;
}

export interface StateDiff {
  from: { slot: number; fetchedAt: string };
  to: { slot: number; fetchedAt: string };
  accounts: AccountDiff[];
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An absent side diffs like an empty container, so added/removed data lists its leaves. */
function emptyLike(value: Json | undefined, other: Json | undefined): Json | undefined {
  if (value !== undefined) return value;
  if (Array.isArray(other)) return [];
  return isObject(other) ? {} : value;
}

function childPairs(left: Json | undefined, right: Json | undefined, path: string) {
  const before = emptyLike(left, right);
  const after = emptyLike(right, left);
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, i) => [`${path}[${i}]`, before[i], after[i]] as const);
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].map((k) => [path ? `${path}.${k}` : k, before[k], after[k]] as const);
  }
  return undefined;
}

/** Structural diff of two JSON values, reported as leaf paths. */
export function diffJson(
  before: Json | undefined,
  after: Json | undefined,
  path = "",
): FieldChange[] {
  const pairs = childPairs(before, after, path);
  if (pairs) return pairs.flatMap(([childPath, a, b]) => diffJson(a, b, childPath));
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || "(root)", before, after }];
}

function decodeJson(
  account: RawAccount | undefined,
  codecs: CodecRegistry,
): { typeName?: string; json?: Json } {
  if (!account) return {};
  const decoded = codecs.get(account.owner)?.decodeAccount(Buffer.from(account.data, "base64"));
  if (!decoded) return {};
  if ("error" in decoded) return decoded.typeName ? { typeName: decoded.typeName } : {};
  return { typeName: decoded.typeName, json: decoded.json };
}

const dataLength = (a: RawAccount) => a.truncated?.length ?? Buffer.byteLength(a.data, "base64");

/** Lamports, owner, size and raw-byte changes between two versions of an account. */
function metadataChanges(before: RawAccount, after: RawAccount, diff: AccountDiff): void {
  if (before.lamports !== after.lamports) {
    diff.lamports = { before: before.lamports, after: after.lamports };
  }
  if (before.owner !== after.owner) diff.owner = { before: before.owner, after: after.owner };
  if (dataLength(before) !== dataLength(after)) {
    diff.dataLen = { before: dataLength(before), after: dataLength(after) };
  }
  const bytesChanged =
    before.data !== after.data || before.truncated?.sha256 !== after.truncated?.sha256;
  diff.rawDataChanged = bytesChanged && diff.fields.length === 0;
}

function isEmpty(diff: AccountDiff): boolean {
  const meta = diff.lamports ?? diff.owner ?? diff.dataLen;
  return diff.change === "modified" && !meta && !diff.rawDataChanged && diff.fields.length === 0;
}

function changeKind(before: RawAccount | undefined, after: RawAccount | undefined) {
  if (!before) return "added";
  return after ? "modified" : "removed";
}

/** Compares two versions of one account (either side may be absent). */
export function diffAccount(
  before: RawAccount | undefined,
  after: RawAccount | undefined,
  codecs: CodecRegistry,
): AccountDiff | undefined {
  const base = after ?? before;
  if (!base) return undefined;
  const a = decodeJson(before, codecs);
  const b = decodeJson(after, codecs);
  const diff: AccountDiff = {
    address: base.address,
    change: changeKind(before, after),
    fields: diffJson(a.json, b.json),
    rawDataChanged: false,
  };
  const typeName = b.typeName ?? a.typeName;
  if (typeName) diff.typeName = typeName;
  if (before && after) metadataChanges(before, after, diff);
  return isEmpty(diff) ? undefined : diff;
}

function byAddress(state: RawState): Map<string, RawAccount> {
  return new Map([...state.accounts, ...state.referenced].map((a) => [a.address, a]));
}

/** Lists every account that was added, removed or modified between two scans. */
export function diffStates(from: RawState, to: RawState, codecs: CodecRegistry): StateDiff {
  const a = byAddress(from);
  const b = byAddress(to);
  const accounts: AccountDiff[] = [];
  for (const address of new Set([...a.keys(), ...b.keys()])) {
    const diff = diffAccount(a.get(address), b.get(address), codecs);
    if (diff) accounts.push(diff);
  }
  const order = { added: 0, modified: 1, removed: 2 };
  accounts.sort((x, y) => order[x.change] - order[y.change] || x.address.localeCompare(y.address));
  return {
    from: { slot: from.slot, fetchedAt: from.fetchedAt },
    to: { slot: to.slot, fetchedAt: to.fetchedAt },
    accounts,
  };
}
