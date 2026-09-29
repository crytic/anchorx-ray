import type { IdlInstructionAccountItem, IdlSeed } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import type { ProgramCodec } from "./codec.js";
import {
  argTypeAtPath,
  displayConst,
  getPath,
  seedBytesFor,
  typeAtPath,
  type SeedBytes,
} from "./seeds.js";
import type { PdaInfo, ResolvedSeed } from "./types.js";

/** One `seeds = [...]` declaration found in an instruction's accounts. */
export interface SeedTemplate {
  /** Program whose IDL declares the template. */
  declaringProgram: string;
  instruction: string;
  /** Instruction account (dotted for composites) that is the PDA. */
  account: string;
  seeds: IdlSeed[];
  program?: IdlSeed;
}

/** Decoded state the resolver can read seed values from. */
export interface SeedContext {
  codec: ProgramCodec;
  /** Decoded raw data of any known account, by address. */
  accountData(address: string): { typeName: string; raw: Record<string, unknown> } | undefined;
}

/** Values bound to names while resolving a template inside one instruction. */
export interface InstructionScope {
  accounts: Map<string, string>;
  args: Record<string, unknown>;
}

export interface PdaMatch {
  address: string;
  info: PdaInfo;
  template: SeedTemplate;
}

type Candidate = SeedBytes & { kind: ResolvedSeed["kind"]; path?: string };

const MAX_COMBINATIONS = 2048;

function walkTemplates(
  codec: ProgramCodec,
  instruction: string,
  items: IdlInstructionAccountItem[],
  prefix: string,
  out: SeedTemplate[],
): void {
  for (const item of items) {
    const name = prefix ? `${prefix}.${item.name}` : item.name;
    if ("accounts" in item) {
      walkTemplates(codec, instruction, item.accounts, name, out);
    } else if (item.pda) {
      const template: SeedTemplate = {
        declaringProgram: codec.id,
        instruction,
        account: name,
        seeds: item.pda.seeds,
      };
      if (item.pda.program) template.program = item.pda.program;
      out.push(template);
    }
  }
}

/** Lists every PDA template in a program's IDL, one per instruction account. */
export function collectTemplates(codec: ProgramCodec): SeedTemplate[] {
  const out: SeedTemplate[] = [];
  for (const ix of codec.idl.instructions) walkTemplates(codec, ix.name, ix.accounts, "", out);
  return out;
}

/** Deduplicates templates that declare identical seeds. */
export function uniqueTemplates(templates: SeedTemplate[]): SeedTemplate[] {
  const seen = new Map<string, SeedTemplate>();
  for (const t of templates) {
    const key = JSON.stringify([t.declaringProgram, t.seeds, t.program ?? null]);
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

function toResolved(c: Candidate): ResolvedSeed {
  const seed: ResolvedSeed = { kind: c.kind, display: c.display, hex: c.bytes.toString("hex") };
  if (c.path !== undefined) seed.path = c.path;
  if (c.pubkey !== undefined) seed.pubkey = c.pubkey;
  return seed;
}

/** Values of account-seed `path` (`name` or `name.field...`) inside an instruction scope. */
function scopeAccountSeed(
  seed: Extract<IdlSeed, { kind: "account" }>,
  scope: InstructionScope,
  ctx: SeedContext,
): SeedBytes | undefined {
  const [head, ...rest] = seed.path.split(".");
  const address = head === undefined ? undefined : scope.accounts.get(head);
  if (!address) return undefined;
  if (rest.length === 0) return seedBytesFor(new PublicKey(address), "pubkey");
  const data = ctx.accountData(address);
  if (!data) return undefined;
  const type = typeAtPath(ctx.codec.idl, seed.account ?? data.typeName, rest);
  return seedBytesFor(getPath(data.raw, rest), type);
}

function scopeSeed(
  seed: IdlSeed,
  template: SeedTemplate,
  scope: InstructionScope,
  ctx: SeedContext,
): Candidate | undefined {
  if (seed.kind === "const") {
    const bytes = Buffer.from(seed.value);
    return { kind: "const", bytes, display: displayConst(bytes) };
  }
  if (seed.kind === "arg") {
    const type = argTypeAtPath(ctx.codec.idl, template.instruction, seed.path);
    const value = seedBytesFor(getPath(scope.args, seed.path.split(".")), type);
    return value && { ...value, kind: "arg", path: seed.path };
  }
  const value = scopeAccountSeed(seed, scope, ctx);
  return value && { ...value, kind: "account", path: seed.path };
}

function programIdFor(template: SeedTemplate, resolve: (seed: IdlSeed) => SeedBytes | undefined) {
  if (!template.program) return new PublicKey(template.declaringProgram);
  const bytes = resolve(template.program)?.bytes;
  return bytes?.length === 32 ? new PublicKey(bytes) : undefined;
}

/**
 * Tries to derive `target` from `seeds`, first with the account's stored bump
 * (which catches non-canonical bumps), then by canonical search.
 */
function derive(
  seeds: Buffer[],
  programId: PublicKey,
  target: string,
  storedBump: number | undefined,
): { bump: number; canonicalBump: number } | undefined {
  const [canonical, canonicalBump] = PublicKey.findProgramAddressSync(seeds, programId);
  if (canonical.toBase58() === target) return { bump: canonicalBump, canonicalBump };
  if (storedBump === undefined || storedBump === canonicalBump) return undefined;
  try {
    const address = PublicKey.createProgramAddressSync(
      [...seeds, Buffer.from([storedBump])],
      programId,
    );
    if (address.toBase58() === target) return { bump: storedBump, canonicalBump };
  } catch {
    // The stored bump yields an on-curve point: not a valid PDA for these seeds.
  }
  return undefined;
}

function storedBumpOf(ctx: SeedContext, address: string): number | undefined {
  const bump = ctx.accountData(address)?.raw["bump"];
  return typeof bump === "number" && bump >= 0 && bump <= 255 ? bump : undefined;
}

/**
 * Verifies the PDAs of one decoded instruction: every account the IDL marks
 * with seeds is re-derived from the instruction's own accounts and arguments.
 */
export function resolveFromInstruction(
  templates: SeedTemplate[],
  scope: InstructionScope,
  ctx: SeedContext,
): PdaMatch[] {
  const matches: PdaMatch[] = [];
  for (const template of templates) {
    const target = scope.accounts.get(template.account);
    if (!target) continue;
    const candidates = template.seeds.map((s) => scopeSeed(s, template, scope, ctx));
    if (candidates.some((c) => c === undefined)) continue;
    const resolved = candidates as Candidate[];
    const programId = programIdFor(template, (s) => scopeSeed(s, template, scope, ctx));
    if (!programId) continue;
    const bumps = derive(
      resolved.map((c) => c.bytes),
      programId,
      target,
      storedBumpOf(ctx, target),
    );
    if (!bumps) continue;
    matches.push({
      address: target,
      template,
      info: {
        status: "verified",
        method: "transaction",
        source: { instruction: template.instruction, account: template.account },
        seeds: resolved.map(toResolved),
        ...bumps,
      },
    });
  }
  return matches;
}

/** Hints for guessing seeds when no transaction touched the account. */
export interface GuessHints {
  /** Keys worth trying for `account` seeds (signers, wallets, scanned accounts). */
  pubkeys: string[];
  /** Instruction argument values observed in transactions, by argument name. */
  args: Map<string, unknown[]>;
  /** Raw decoded data of every known account of a given type. */
  accountsOfType(typeName: string): Record<string, unknown>[];
}

type Own = { typeName: string; raw: Record<string, unknown> };

function uniqueCandidates(
  values: (SeedBytes | undefined)[],
  kind: Candidate["kind"],
  path: string,
) {
  const out: Candidate[] = [];
  for (const value of values) {
    if (value && !out.some((c) => c.bytes.equals(value.bytes))) out.push({ ...value, kind, path });
  }
  return out;
}

function argCandidates(
  seed: { path: string },
  template: SeedTemplate,
  own: Own,
  ctx: SeedContext,
  hints: GuessHints,
) {
  const name = seed.path.split(".").at(-1) ?? seed.path;
  const type = argTypeAtPath(ctx.codec.idl, template.instruction, seed.path);
  const values = [own.raw[name], ...(hints.args.get(name) ?? [])];
  return uniqueCandidates(
    values.map((v) => seedBytesFor(v, type)),
    "arg",
    seed.path,
  );
}

function accountCandidates(
  seed: { path: string; account?: string },
  own: Own,
  ctx: SeedContext,
  hints: GuessHints,
) {
  const [head, ...rest] = seed.path.split(".");
  if (rest.length === 0) {
    const keys = [own.raw[head ?? ""], ...hints.pubkeys];
    return uniqueCandidates(
      keys.map((k) => seedBytesFor(k, "pubkey")),
      "account",
      seed.path,
    );
  }
  // `other.field`: the PDA often stores the same field itself (self-referential seeds).
  const typeName = seed.account ?? own.typeName;
  const type = typeAtPath(ctx.codec.idl, typeName, rest);
  const sources = [own.raw, ...hints.accountsOfType(typeName)];
  return uniqueCandidates(
    sources.map((raw) => seedBytesFor(getPath(raw, rest), type)),
    "account",
    seed.path,
  );
}

function guessCandidates(
  seed: IdlSeed,
  template: SeedTemplate,
  own: Own,
  ctx: SeedContext,
  hints: GuessHints,
): Candidate[] {
  if (seed.kind === "arg") return argCandidates(seed, template, own, ctx, hints);
  if (seed.kind === "account") return accountCandidates(seed, own, ctx, hints);
  const bytes = Buffer.from(seed.value);
  return [{ kind: "const", bytes, display: displayConst(bytes) }];
}

function* product(lists: Candidate[][]): Generator<Candidate[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head, ...tail] = lists;
  for (const item of head ?? []) for (const rest of product(tail)) yield [item, ...rest];
}

/**
 * Recovers seeds for a PDA no transaction explained, by trying values from the
 * account's own fields and from observed keys/arguments against each template.
 */
export function guessSeeds(
  address: string,
  templates: SeedTemplate[],
  ctx: SeedContext,
  hints: GuessHints,
): PdaMatch | undefined {
  const own = ctx.accountData(address);
  if (!own) return undefined;
  const storedBump = storedBumpOf(ctx, address);
  for (const template of templates) {
    if (template.program) continue;
    const lists = template.seeds.map((s) => guessCandidates(s, template, own, ctx, hints));
    const total = lists.reduce((n, l) => n * l.length, 1);
    if (total === 0 || total > MAX_COMBINATIONS) continue;
    const programId = new PublicKey(template.declaringProgram);
    for (const combo of product(lists)) {
      const bumps = derive(
        combo.map((c) => c.bytes),
        programId,
        address,
        storedBump,
      );
      if (!bumps) continue;
      return {
        address,
        template,
        info: {
          status: "verified",
          method: "account-data",
          source: { instruction: template.instruction, account: template.account },
          seeds: combo.map(toResolved),
          ...bumps,
        },
      };
    }
  }
  return undefined;
}
