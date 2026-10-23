import { createHash } from "node:crypto";
import type {
  SharedAddressOccurrence,
  SharedAddress,
  SharedField,
  SharedPattern,
  XrayModel,
} from "./types.js";

export interface SharedPatternIndex {
  patterns: SharedPattern[];
  byValue: Map<string, string[]>;
  pathsByAccount: Map<string, Map<string, Set<string>>>;
}

interface FieldOccurrences {
  field: SharedField;
  count: number;
  first: SharedAddressOccurrence;
  second?: SharedAddressOccurrence;
}

const normalizedPath = (path: string) => path.replace(/\[\d+\]/g, "[]");
const fieldKey = (field: SharedField) =>
  JSON.stringify([field.program, field.typeName, field.path]);
const patternId = (left: string, right: string) =>
  createHash("sha256")
    .update(JSON.stringify([left, right]))
    .digest("hex")
    .slice(0, 24);

function fieldsForValue(
  occurrences: SharedAddressOccurrence[],
  accounts: Map<string, XrayModel["accounts"][number]>,
): Map<string, FieldOccurrences> {
  const fields = new Map<string, FieldOccurrences>();
  for (const occurrence of occurrences) {
    const account = accounts.get(occurrence.account);
    if (!account?.program || !account.typeName) continue;
    const field = {
      program: account.program,
      typeName: account.typeName,
      path: normalizedPath(occurrence.path),
    };
    const key = fieldKey(field);
    const row: FieldOccurrences = fields.get(key) ?? { field, count: 0, first: occurrence };
    row.count += 1;
    if (row.count === 2) row.second = occurrence;
    fields.set(key, row);
  }
  return fields;
}

function addPattern(
  patterns: Map<string, SharedPattern>,
  value: string,
  leftEntry: [string, FieldOccurrences],
  rightEntry: [string, FieldOccurrences],
): string {
  const [leftKey, left] = leftEntry;
  const [rightKey, right] = rightEntry;
  const id = patternId(leftKey, rightKey);
  const example = {
    value,
    left: left.first,
    right: leftKey === rightKey ? right.second! : right.first,
  };
  const pattern = patterns.get(id) ?? {
    id,
    left: left.field,
    right: right.field,
    matchedValues: 0,
    examples: [],
  };
  pattern.matchedValues += 1;
  if (pattern.examples.length < 2) pattern.examples.push(example);
  patterns.set(id, pattern);
  return id;
}

function patternsForValue(
  group: SharedAddress,
  accounts: Map<string, XrayModel["accounts"][number]>,
  patterns: Map<string, SharedPattern>,
): string[] {
  const fields = [...fieldsForValue(group.occurrences, accounts)].toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  const ids: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i; j < fields.length; j += 1) {
      const left = fields[i]!;
      const right = fields[j]!;
      if (i === j && left[1].count < 2) continue;
      ids.push(addPattern(patterns, group.value, left, right));
    }
  }
  return ids;
}

function recordAccountPaths(
  group: SharedAddress,
  pathsByAccount: Map<string, Map<string, Set<string>>>,
): void {
  for (const occurrence of group.occurrences) {
    const perAccount = pathsByAccount.get(occurrence.account) ?? new Map();
    const paths = perAccount.get(group.value) ?? new Set<string>();
    paths.add(normalizedPath(occurrence.path));
    perAccount.set(group.value, paths);
    pathsByAccount.set(occurrence.account, perAccount);
  }
}

/** Build one review item per pair of account field positions, never per account pair. */
export function indexSharedPatterns(model: XrayModel): SharedPatternIndex {
  const accounts = new Map(model.accounts.map((account) => [account.address, account]));
  const patterns = new Map<string, SharedPattern>();
  const byValue = new Map<string, string[]>();
  const pathsByAccount = new Map<string, Map<string, Set<string>>>();
  for (const group of model.sharedAddresses) {
    byValue.set(group.value, patternsForValue(group, accounts, patterns));
    recordAccountPaths(group, pathsByAccount);
  }
  return { patterns: [...patterns.values()], byValue, pathsByAccount };
}
