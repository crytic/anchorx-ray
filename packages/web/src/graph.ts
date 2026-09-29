import type { AccountKind, AccountNode, Edge, EdgeKind, ProgramSummary, XrayModel } from "./api.js";
import { KIND_LABEL } from "./format.js";

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 84;
export const GROUP_HEADER = 64;

/** A type with more accounts than this is folded into a stack, keeping the most relevant. */
export const COLLAPSE_AT = 24;
export const KEEP_WHEN_COLLAPSED = 8;

export interface Filters {
  hiddenPrograms: Set<string>;
  hiddenKinds: Set<AccountKind>;
  edgeKinds: Set<EdgeKind>;
  search: string;
  findingsOnly: boolean;
  /** Stack ids the user expanded. */
  expanded: Set<string>;
}

export const DEFAULT_EDGE_KINDS: EdgeKind[] = ["field", "seed"];

export function defaultFilters(): Filters {
  return {
    hiddenPrograms: new Set(),
    hiddenKinds: new Set(),
    edgeKinds: new Set(DEFAULT_EDGE_KINDS),
    search: "",
    findingsOnly: false,
    expanded: new Set(),
  };
}

/** Many accounts of one type drawn as a single node. */
export interface Stack {
  id: string;
  label: string;
  kind: AccountKind;
  count: number;
  /** Warnings among the folded accounts, so a stack never hides a problem silently. */
  warnings: number;
}

export interface GraphGroup {
  id: string;
  program: ProgramSummary;
  node: AccountNode | undefined;
  children: AccountNode[];
  stacks: Stack[];
}

/** The model reduced to what the canvas draws: program groups, loose nodes, stacks and edges. */
export interface VisibleGraph {
  groups: GraphGroup[];
  loose: AccountNode[];
  looseStacks: Stack[];
  /** Edges between drawn ids; `count` > 1 when several edges were folded into one. */
  edges: (Edge & { count: number })[];
  /** Accounts that match the search/findings filter; the rest are drawn dimmed. */
  matches: Set<string>;
}

export const groupId = (programId: string) => `group:${programId}`;

function matchesSearch(node: AccountNode, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [node.address, node.label, node.typeName ?? "", node.kind].some((s) =>
    s.toLowerCase().includes(q),
  );
}

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

function isVisible(node: AccountNode, filters: Filters, programIds: Set<string>): boolean {
  if (filters.hiddenKinds.has(node.kind)) return false;
  // ProgramData accounts only matter when their edges are shown.
  const isProgramData = node.owner === UPGRADEABLE_LOADER && !node.executable;
  if (isProgramData && !filters.edgeKinds.has("programdata")) return false;
  if (node.program && filters.hiddenPrograms.has(node.program)) return false;
  // Program accounts are drawn as group headers, not as nodes.
  return !programIds.has(node.address);
}

/** Higher first: pinned (selected, just changed), then warnings, then any finding. */
function relevance(node: AccountNode, pinned: Set<string>, matches: Set<string>): number {
  let score = pinned.has(node.address) ? 8 : 0;
  if (node.findings.some((f) => f.severity === "warning")) score += 4;
  if (node.findings.length > 0) score += 2;
  if (matches.has(node.address)) score += 1;
  return score;
}

interface Folded {
  shown: AccountNode[];
  stacks: Stack[];
  /** Folded account address → stack id. */
  into: Map<string, string>;
}

function bucketOf(node: AccountNode): string {
  return node.typeName ?? node.kind;
}

function bucketsOf(nodes: AccountNode[]): Map<string, AccountNode[]> {
  const buckets = new Map<string, AccountNode[]>();
  for (const node of nodes) {
    const key = bucketOf(node);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(node);
    else buckets.set(key, [node]);
  }
  return buckets;
}

const hasWarning = (n: AccountNode) => n.findings.some((f) => f.severity === "warning");

/** Keeps the most relevant accounts of an over-full bucket and folds the rest into a stack. */
function foldBucket(id: string, bucket: AccountNode[], ctx: FoldContext, out: Folded) {
  const score = (n: AccountNode) => relevance(n, ctx.pinned, ctx.matches);
  const ranked = bucket.toSorted((a, b) => score(b) - score(a));
  const rest = ranked.slice(KEEP_WHEN_COLLAPSED);
  out.shown.push(...ranked.slice(0, KEEP_WHEN_COLLAPSED));
  const kind = bucket[0]?.kind ?? "external";
  out.stacks.push({
    id,
    label: bucket[0]?.typeName ?? KIND_LABEL[kind],
    kind,
    count: rest.length,
    warnings: rest.filter(hasWarning).length,
  });
  for (const node of rest) out.into.set(node.address, id);
}

/** Folds each over-full bucket (type, or kind for loose accounts) into a stack. */
function fold(nodes: AccountNode[], scope: string, ctx: FoldContext): Folded {
  const out: Folded = { shown: [], stacks: [], into: new Map() };
  for (const [key, bucket] of bucketsOf(nodes)) {
    const id = `stack:${scope}:${key}`;
    const small = bucket.length <= COLLAPSE_AT || ctx.filters.expanded.has(id);
    if (small) for (const node of bucket) out.shown.push(node);
    else foldBucket(id, bucket, ctx, out);
  }
  return out;
}

interface FoldContext {
  filters: Filters;
  pinned: Set<string>;
  matches: Set<string>;
}

type Resolve = (address: string) => string | undefined;

/** The edge as drawn, or undefined when an endpoint is hidden or both land on one node. */
function redraw(edge: Edge, resolve: Resolve): Edge | undefined {
  const from = resolve(edge.from);
  const to = resolve(edge.to);
  if (!from || !to || from === to) return undefined;
  // Folded edges share a label: `entries[3]` and `entries[7]` both become `entries[]`.
  const folded = from !== edge.from || to !== edge.to;
  const label = folded ? edge.label.replace(/\[\d+\]/g, "[]") : edge.label;
  return { ...edge, id: `${edge.kind}:${from}:${to}:${label}`, from, to, label };
}

/** Remaps edge endpoints to drawn ids and merges edges that now coincide. */
function drawEdges(model: XrayModel, filters: Filters, resolve: Resolve) {
  const merged = new Map<string, Edge & { count: number }>();
  for (const edge of model.edges) {
    const drawn = filters.edgeKinds.has(edge.kind) ? redraw(edge, resolve) : undefined;
    if (!drawn) continue;
    const existing = merged.get(drawn.id);
    if (existing) existing.count += 1;
    else merged.set(drawn.id, { ...drawn, count: 1 });
  }
  return [...merged.values()];
}

export function visibleGraph(
  model: XrayModel,
  filters: Filters,
  pinned: Set<string> = new Set(),
): VisibleGraph {
  const programIds = new Set(model.programs.map((p) => p.id));
  const shown = model.accounts.filter((a) => isVisible(a, filters, programIds));
  const matches = new Set(
    shown
      .filter((a) => matchesSearch(a, filters.search))
      .filter((a) => !filters.findingsOnly || a.findings.length > 0)
      .map((a) => a.address),
  );
  const ctx: FoldContext = { filters, pinned, matches };
  const into = new Map<string, string>();
  const groups: GraphGroup[] = model.programs
    .filter((p) => !filters.hiddenPrograms.has(p.id))
    .map((program) => {
      const folded = fold(
        shown.filter((a) => a.program === program.id),
        program.id,
        ctx,
      );
      for (const [address, stack] of folded.into) into.set(address, stack);
      const node = model.accounts.find((a) => a.address === program.id);
      return {
        id: groupId(program.id),
        program,
        node,
        children: folded.shown,
        stacks: folded.stacks,
      };
    });
  const loose = fold(
    shown.filter((a) => !a.program || !programIds.has(a.program)),
    "loose",
    ctx,
  );
  for (const [address, stack] of loose.into) into.set(address, stack);
  const drawn = new Set(
    [...groups.flatMap((g) => g.children), ...loose.shown].map((a) => a.address),
  );
  const resolve = (address: string) => {
    if (programIds.has(address))
      return filters.hiddenPrograms.has(address) ? undefined : groupId(address);
    return drawn.has(address) ? address : into.get(address);
  };
  const edges = drawEdges(model, filters, resolve);
  return { groups, loose: loose.shown, looseStacks: loose.stacks, edges, matches };
}

/** Accounts directly linked to `address` by any edge in the model. */
export function neighbours(model: XrayModel, address: string): Set<string> {
  const out = new Set<string>();
  for (const e of model.edges) {
    if (e.from === address) out.add(e.to);
    if (e.to === address) out.add(e.from);
  }
  return out;
}
