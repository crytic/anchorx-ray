import fs from "node:fs";
import path from "node:path";
import type { Idl } from "@anchor-lang/core";
import { parse as parseToml } from "smol-toml";

export interface LoadedProgram {
  id: string;
  name: string;
  idl: Idl;
  /** File the IDL was read from. */
  source: string;
}

export interface Workspace {
  root: string;
  cluster: string;
  rpcUrl: string;
  programs: LoadedProgram[];
  warnings: string[];
}

export interface WorkspaceOptions {
  root: string;
  /** Explicit IDL files; when empty, `target/idl/*.json` under root is used. */
  idlPaths?: string[];
  /** Overrides `[provider] cluster` from Anchor.toml. */
  cluster?: string;
  /** Only load these programs (by IDL name or program id). */
  include?: string[];
  /** Skip these programs (by IDL name or program id). */
  exclude?: string[];
}

const CLUSTER_URLS: Record<string, string> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Maps a cluster moniker (or URL) from Anchor.toml to an RPC URL. */
export function clusterToRpcUrl(cluster: string): string {
  if (/^https?:\/\//.test(cluster)) return cluster;
  const url = CLUSTER_URLS[cluster.toLowerCase()];
  if (!url) {
    throw new Error(
      `Unknown cluster "${cluster}". Use localnet, devnet, testnet, mainnet, or a URL.`,
    );
  }
  return url;
}

function missingSpecMessage(idl: Record<string, unknown>, source: string): string {
  const legacy = typeof idl["version"] === "string" && typeof idl["name"] === "string";
  return legacy
    ? `${source}: legacy (pre-0.30) IDL. Convert it with \`anchor idl convert ${source}\`.`
    : `${source}: not an Anchor IDL (missing "address" or "metadata.spec").`;
}

/**
 * Validates that `value` is an Anchor IDL in the 0.30+ spec format.
 *
 * Legacy IDLs (Anchor < 0.30) lack `address` and `metadata.spec`; they are
 * rejected with instructions to convert them.
 */
export function parseIdl(value: unknown, source: string): Idl {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${source}: IDL must be a JSON object`);
  }
  const idl = value as Record<string, unknown>;
  const spec = (idl["metadata"] as Record<string, unknown> | undefined)?.["spec"];
  if (typeof idl["address"] !== "string" || typeof spec !== "string") {
    throw new Error(missingSpecMessage(idl, source));
  }
  if (!Array.isArray(idl["instructions"])) {
    throw new Error(`${source}: IDL has no "instructions" array`);
  }
  return value as Idl;
}

export function loadIdlFile(file: string): Idl {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read IDL ${file}: ${(error as Error).message}`, { cause: error });
  }
  try {
    return parseIdl(JSON.parse(raw), file);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${file}: invalid JSON (${error.message})`, { cause: error });
  }
}

interface AnchorToml {
  cluster?: string;
  programs: Record<string, Record<string, string>>;
}

/** Entries are either `name = "id"` or `name = { address = "id", idl = "..." }`. */
function programIds(entries: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const id = typeof entry === "string" ? entry : (entry as { address?: unknown } | null)?.address;
    if (typeof id === "string") ids[name] = id;
  }
  return ids;
}

export function readAnchorToml(root: string): AnchorToml | undefined {
  const file = path.join(root, "Anchor.toml");
  if (!fs.existsSync(file)) return undefined;
  const doc = parseToml(fs.readFileSync(file, "utf8"));
  const rawPrograms = (doc["programs"] ?? {}) as Record<string, Record<string, unknown>>;
  const programs = Object.fromEntries(
    Object.entries(rawPrograms).map(([cluster, entries]) => [
      cluster.toLowerCase(),
      programIds(entries),
    ]),
  );
  const cluster = (doc["provider"] as Record<string, unknown> | undefined)?.["cluster"];
  return typeof cluster === "string" ? { cluster, programs } : { programs };
}

function listIdlDir(root: string): string[] {
  const dir = path.join(root, "target", "idl");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((f) => path.join(dir, f));
}

function idlFiles(root: string, idlPaths: string[] | undefined): string[] {
  const files = idlPaths?.length ? idlPaths.map((p) => path.resolve(p)) : listIdlDir(root);
  if (files.length === 0) {
    const dir = path.join(root, "target", "idl");
    throw new Error(`No IDL found in ${dir}. Run \`anchor build\` or pass --idl <file>.`);
  }
  return files;
}

function loadPrograms(files: string[], ids: Record<string, string>, warnings: string[]) {
  const programs: LoadedProgram[] = [];
  for (const file of files) {
    const idl = loadIdlFile(file);
    const name = idl.metadata.name;
    const configured = ids[name];
    const id = configured ?? idl.address;
    if (id !== idl.address) {
      warnings.push(`${name}: IDL address ${idl.address} differs from Anchor.toml; using ${id}`);
    }
    if (programs.some((p) => p.id === id)) {
      warnings.push(`${name}: program ${id} loaded twice; skipping ${file}`);
      continue;
    }
    programs.push({ id, name, idl: { ...idl, address: id }, source: file });
  }
  return programs;
}

function matcher(programs: LoadedProgram[], selectors: string[], flag: string) {
  const known = new Set(programs.flatMap((p) => [p.name, p.id]));
  const unknown = selectors.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    const available = programs.map((p) => p.name).join(", ");
    throw new Error(`${flag}: unknown program ${unknown.join(", ")}. Available: ${available}`);
  }
  const wanted = new Set(selectors);
  return (p: LoadedProgram) => wanted.has(p.name) || wanted.has(p.id);
}

/** Applies --include/--exclude; both match an IDL name or a program id. */
export function filterPrograms(
  programs: LoadedProgram[],
  include: string[] = [],
  exclude: string[] = [],
): LoadedProgram[] {
  const included = include.length > 0 ? matcher(programs, include, "--include") : () => true;
  const excluded = exclude.length > 0 ? matcher(programs, exclude, "--exclude") : () => false;
  const selected = programs.filter((p) => included(p) && !excluded(p));
  if (selected.length === 0)
    throw new Error("No program left to inspect after --include/--exclude.");
  return selected;
}

/**
 * Resolves the programs to inspect: IDLs from `target/idl` (or explicit
 * paths), with program ids taken from Anchor.toml for the active cluster when
 * they differ from the IDL's `address`.
 */
export function loadWorkspace(options: WorkspaceOptions): Workspace {
  const root = path.resolve(options.root);
  const toml = readAnchorToml(root);
  const cluster = options.cluster ?? toml?.cluster ?? "localnet";
  const rpcUrl = clusterToRpcUrl(cluster);
  const clusterKey = /^https?:/.test(cluster) ? "localnet" : cluster.toLowerCase();
  const warnings: string[] = [];
  const loaded = loadPrograms(
    idlFiles(root, options.idlPaths),
    toml?.programs[clusterKey] ?? {},
    warnings,
  );
  const programs = filterPrograms(loaded, options.include, options.exclude);
  return { root, cluster, rpcUrl, programs, warnings };
}
