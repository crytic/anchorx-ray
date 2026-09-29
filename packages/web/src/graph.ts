import type { AccountKind, AccountNode, Edge, EdgeKind, ProgramSummary, XrayModel } from "./api.js";

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 84;
export const GROUP_HEADER = 64;

export interface Filters {
  hiddenPrograms: Set<string>;
  hiddenKinds: Set<AccountKind>;
  edgeKinds: Set<EdgeKind>;
  search: string;
  findingsOnly: boolean;
}

export const DEFAULT_EDGE_KINDS: EdgeKind[] = ["field", "seed"];

export function defaultFilters(): Filters {
  return {
    hiddenPrograms: new Set(),
    hiddenKinds: new Set(),
    edgeKinds: new Set(DEFAULT_EDGE_KINDS),
    search: "",
    findingsOnly: false,
  };
}

export interface GraphGroup {
  id: string;
  program: ProgramSummary;
  node: AccountNode | undefined;
  children: AccountNode[];
}

/** The model reduced to what the canvas draws: program groups, loose nodes and edges. */
export interface VisibleGraph {
  groups: GraphGroup[];
  loose: AccountNode[];
  edges: Edge[];
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

/** Maps an edge endpoint to what is drawn: a program's group, a node, or nothing. */
function endpoint(address: string, drawn: Set<string>, programIds: Set<string>, filters: Filters) {
  if (programIds.has(address))
    return filters.hiddenPrograms.has(address) ? undefined : groupId(address);
  return drawn.has(address) ? address : undefined;
}

export function visibleGraph(model: XrayModel, filters: Filters): VisibleGraph {
  const programIds = new Set(model.programs.map((p) => p.id));
  const shown = model.accounts.filter((a) => isVisible(a, filters, programIds));
  const drawn = new Set(shown.map((a) => a.address));
  const groups = model.programs
    .filter((p) => !filters.hiddenPrograms.has(p.id))
    .map((program) => ({
      id: groupId(program.id),
      program,
      node: model.accounts.find((a) => a.address === program.id),
      children: shown.filter((a) => a.program === program.id),
    }));
  const loose = shown.filter((a) => !a.program || !programIds.has(a.program));
  const edges: Edge[] = [];
  for (const edge of model.edges) {
    if (!filters.edgeKinds.has(edge.kind)) continue;
    const from = endpoint(edge.from, drawn, programIds, filters);
    const to = endpoint(edge.to, drawn, programIds, filters);
    if (from && to && from !== to) edges.push({ ...edge, from, to });
  }
  const matches = new Set(
    shown
      .filter((a) => matchesSearch(a, filters.search))
      .filter((a) => !filters.findingsOnly || a.findings.length > 0)
      .map((a) => a.address),
  );
  return { groups, loose, edges, matches };
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
