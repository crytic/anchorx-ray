import type { CodecRegistry } from "./codec.js";
import { hasOneConstraints, type Constraints } from "./constraints.js";
import {
  KNOWN_ADDRESSES,
  SYSTEM_PROGRAM,
  SYSVAR_OWNER,
  UPGRADEABLE_LOADER,
  isOnCurve,
  programDataAddress,
  upgradeAuthority,
} from "./known.js";
import { pdaFindings, resolvePdas, type AccountIndex } from "./resolve.js";
import type { InstructionBinding } from "./tx.js";
import type {
  AccountKind,
  AccountNode,
  Edge,
  PdaInfo,
  ProgramSummary,
  RawAccount,
  RawState,
  XrayModel,
} from "./types.js";

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

interface Index extends AccountIndex {
  decodeErrors: Map<string, { typeName?: string; error: string }>;
}

type Nodes = Map<string, AccountNode>;

const bytes = (account: RawAccount) => Buffer.from(account.data, "base64");

function buildIndex(state: RawState, codecs: CodecRegistry): Index {
  const index: Index = { raw: new Map(), decoded: new Map(), decodeErrors: new Map() };
  for (const account of [...state.accounts, ...state.referenced]) {
    index.raw.set(account.address, account);
  }
  for (const account of index.raw.values()) {
    const codec = codecs.get(account.owner);
    if (!codec || account.executable) continue;
    const result = codec.decodeAccount(bytes(account));
    if ("error" in result) index.decodeErrors.set(account.address, result);
    else index.decoded.set(account.address, result);
  }
  return index;
}

function classify(account: RawAccount, codecs: CodecRegistry, onCurve: boolean): AccountKind {
  if (account.executable) return codecs.get(account.address) ? "program" : "external-program";
  if (account.owner === SYSVAR_OWNER) return "sysvar";
  if (codecs.get(account.owner)) return onCurve ? "keypair" : "pda";
  return account.owner === SYSTEM_PROGRAM ? "wallet" : "external";
}

function labelFor(node: AccountNode, codecs: CodecRegistry): string {
  const known = KNOWN_ADDRESSES[node.address];
  if (known) return known;
  if (node.kind === "program") return codecs.get(node.address)?.name ?? "program";
  if (node.typeName) return node.typeName;
  if (node.executable) return "program";
  return node.owner === UPGRADEABLE_LOADER ? "program data" : node.kind;
}

function attachDecoded(node: AccountNode, index: Index): void {
  const decoded = index.decoded.get(node.address);
  if (decoded) {
    node.typeName = decoded.typeName;
    node.decoded = decoded.json;
    return;
  }
  const failed = index.decodeErrors.get(node.address);
  if (!failed) return;
  if (failed.typeName) node.typeName = failed.typeName;
  node.decodeError = failed.error;
  node.findings.push({ severity: "warning", code: "undecodable-account", message: failed.error });
}

function buildNode(
  account: RawAccount,
  index: Index,
  codecs: CodecRegistry,
  pdas: Map<string, PdaInfo>,
) {
  const onCurve = isOnCurve(account.address);
  const node: AccountNode = {
    address: account.address,
    kind: classify(account, codecs, onCurve),
    label: "",
    owner: account.owner,
    lamports: account.lamports,
    dataLen: account.truncated?.length ?? bytes(account).length,
    executable: account.executable,
    onCurve,
    findings: [],
  };
  if (codecs.get(account.owner)) node.program = account.owner;
  attachDecoded(node, index);
  const pda = pdas.get(account.address);
  if (pda) {
    node.pda = pda;
    node.findings.push(...pdaFindings(pda, index.decoded.get(account.address)?.raw["bump"]));
  }
  node.label = labelFor(node, codecs);
  return node;
}

function missingNode(address: string): AccountNode {
  return {
    address,
    kind: "missing",
    label: KNOWN_ADDRESSES[address] ?? "missing",
    owner: "",
    lamports: 0,
    dataLen: 0,
    executable: false,
    onCurve: isOnCurve(address),
    findings: [],
  };
}

type EdgeDraft = Omit<Edge, "id">;

function fieldEdges(node: AccountNode, index: Index, constraints: Constraints): EdgeDraft[] {
  const decoded = index.decoded.get(node.address);
  if (!decoded) return [];
  return decoded.pubkeys
    .filter((ref) => ref.pubkey !== DEFAULT_PUBKEY)
    .map((ref) => {
      const edge: EdgeDraft = {
        kind: "field",
        from: node.address,
        to: ref.pubkey,
        label: ref.path,
      };
      const by = constraints.get(`${node.program}:${decoded.typeName}.${ref.path}`);
      if (by) edge.constrainedBy = [...by];
      return edge;
    });
}

function seedEdges(node: AccountNode): EdgeDraft[] {
  return (node.pda?.seeds ?? []).flatMap((seed, i): EdgeDraft[] =>
    seed.pubkey ? [{ kind: "seed", from: node.address, to: seed.pubkey, label: `seed[${i}]` }] : [],
  );
}

function structuralEdges(node: AccountNode, index: Index): EdgeDraft[] {
  const from = node.address;
  const raw = index.raw.get(from);
  if (!raw?.executable) {
    return node.program ? [{ kind: "owner", from, to: node.program, label: "owner" }] : [];
  }
  const programData = programDataAddress(bytes(raw));
  return programData ? [{ kind: "programdata", from, to: programData, label: "programdata" }] : [];
}

/** Owner, field, seed and programdata edges leaving one node. */
function nodeEdges(node: AccountNode, index: Index, constraints: Constraints): EdgeDraft[] {
  return [
    ...structuralEdges(node, index),
    ...fieldEdges(node, index, constraints),
    ...seedEdges(node),
  ];
}

function buildEdges(nodes: Nodes, index: Index, constraints: Constraints): Edge[] {
  return [...nodes.values()]
    .flatMap((node) => nodeEdges(node, index, constraints))
    .filter((e) => e.from !== e.to && nodes.has(e.to))
    .map((e) => ({ ...e, id: `${e.kind}:${e.from}:${e.to}:${e.label}` }));
}

function danglingFindings(nodes: Nodes, edges: Edge[]): void {
  for (const edge of edges) {
    if (edge.kind !== "field" || nodes.get(edge.to)?.kind !== "missing") continue;
    nodes.get(edge.from)?.findings.push({
      severity: "info",
      code: "dangling-reference",
      message: `Field ${edge.label} points to ${edge.to}, which does not exist on chain`,
    });
  }
}

function attachUpgradeAuthorities(nodes: Nodes, index: Index): void {
  for (const node of nodes.values()) {
    const raw = index.raw.get(node.address);
    if (!raw?.executable || raw.owner !== UPGRADEABLE_LOADER) continue;
    const programData = index.raw.get(programDataAddress(bytes(raw)) ?? "");
    const authority = programData ? upgradeAuthority(bytes(programData)) : undefined;
    if (authority !== undefined) node.upgradeAuthority = authority;
  }
}

function summarize(codecs: CodecRegistry, nodes: Nodes): ProgramSummary[] {
  return codecs.all().map((codec) => ({
    id: codec.id,
    name: codec.name,
    version: codec.idl.metadata.version,
    deployed: nodes.get(codec.id)?.executable === true,
    accountTypes: (codec.idl.accounts ?? []).map((a) => a.name),
    instructions: codec.idl.instructions.map((i) => i.name),
    events: (codec.idl.events ?? []).map((e) => e.name),
  }));
}

const GENERIC_ROLES = new Set(["system_program", "program", "event_authority", "rent", "clock"]);

const byFrequency = (counts: Map<string, number>) =>
  [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([role]) => role);

/** Instruction account names each address appeared under, most frequent first. */
function rolesByAddress(bindings: InstructionBinding[]): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const b of bindings) {
    for (const [name, address] of b.scope.accounts) {
      const role = name.split(".").at(-1) ?? name;
      if (GENERIC_ROLES.has(role)) continue;
      const perAddress = counts.get(address) ?? new Map<string, number>();
      counts.set(address, perAddress.set(role, (perAddress.get(role) ?? 0) + 1));
    }
  }
  return new Map([...counts].map(([address, m]) => [address, byFrequency(m)]));
}

function labelWallets(nodes: Nodes, bindings: InstructionBinding[]): void {
  const roles = rolesByAddress(bindings);
  for (const node of nodes.values()) {
    const seen = roles.get(node.address);
    if (!seen) continue;
    node.roles = seen;
    if (node.kind === "wallet") node.label = seen.slice(0, 2).join(" · ");
  }
}

function labelMissing(nodes: Nodes, edges: Edge[]): void {
  for (const edge of edges.filter((e) => e.kind === "field")) {
    const target = nodes.get(edge.to);
    const source = nodes.get(edge.from);
    if (target?.label !== "missing" || !source) continue;
    target.label = `${source.typeName ?? source.label}.${edge.label}`;
  }
}

/**
 * Gives wallets and missing accounts a meaningful label: the instruction roles
 * a wallet was passed as, or the field that points to a missing account.
 */
function nameAnonymous(nodes: Nodes, edges: Edge[], bindings: InstructionBinding[]): void {
  labelWallets(nodes, bindings);
  labelMissing(nodes, edges);
}

function markUndeployed(programs: ProgramSummary[], nodes: Nodes): void {
  for (const program of programs.filter((p) => !p.deployed)) {
    const node = nodes.get(program.id) ?? missingNode(program.id);
    nodes.set(program.id, node);
    node.label = program.name;
    node.findings.push({
      severity: "info",
      code: "program-not-deployed",
      message: "No executable account at the IDL address",
    });
  }
}

/**
 * Turns fetched chain state plus decoded transactions into the account graph:
 * decoded accounts, verified PDA seeds, reference edges and findings.
 */
export function buildModel(
  state: RawState,
  codecs: CodecRegistry,
  bindings: InstructionBinding[],
): XrayModel {
  const index = buildIndex(state, codecs);
  const pdas = resolvePdas(index, codecs, bindings);
  const nodes: Nodes = new Map();
  for (const account of index.raw.values()) {
    nodes.set(account.address, buildNode(account, index, codecs, pdas));
  }
  for (const address of state.missing)
    if (!nodes.has(address)) nodes.set(address, missingNode(address));
  attachUpgradeAuthorities(nodes, index);
  const typeOf = (address: string) => index.decoded.get(address)?.typeName;
  const edges = buildEdges(nodes, index, hasOneConstraints(codecs, bindings, typeOf));
  danglingFindings(nodes, edges);
  nameAnonymous(nodes, edges, bindings);
  const programs = summarize(codecs, nodes);
  markUndeployed(programs, nodes);
  const accounts = [...nodes.values()];
  return { slot: state.slot, fetchedAt: state.fetchedAt, programs, accounts, edges };
}

function referencesOf(account: RawAccount, codecs: CodecRegistry): string[] {
  if (account.executable)
    return [programDataAddress(bytes(account))].filter((a) => a !== undefined);
  const decoded = codecs.get(account.owner)?.decodeAccount(bytes(account));
  if (!decoded || "error" in decoded) return [];
  return decoded.pubkeys.map((r) => r.pubkey).filter((k) => k !== DEFAULT_PUBKEY);
}

/** Addresses referenced by program-owned data (and ProgramData of programs) not yet fetched. */
export function referencedAddresses(accounts: RawAccount[], codecs: CodecRegistry): string[] {
  const known = new Set(accounts.map((a) => a.address));
  const refs = new Set(accounts.flatMap((a) => referencesOf(a, codecs)));
  return [...refs].filter((a) => !known.has(a));
}
