import type { CodecRegistry, DecodedAccount } from "./codec.js";
import { SYSTEM_PROGRAM, isOnCurve } from "./known.js";
import {
  collectTemplates,
  guessSeeds,
  resolveFromInstruction,
  uniqueTemplates,
  type GuessHints,
  type SeedContext,
  type SeedTemplate,
} from "./pda.js";
import type { InstructionBinding } from "./tx.js";
import type { Finding, PdaInfo, RawAccount } from "./types.js";

const MAX_HINT_KEYS = 256;

export interface AccountIndex {
  raw: Map<string, RawAccount>;
  decoded: Map<string, DecodedAccount>;
}

function makeHints(index: AccountIndex, bindings: InstructionBinding[]): GuessHints {
  const pubkeys = new Set<string>();
  const args = new Map<string, unknown[]>();
  for (const b of bindings) {
    for (const address of b.scope.accounts.values()) pubkeys.add(address);
    for (const [name, value] of Object.entries(b.scope.args)) {
      args.set(name, [...(args.get(name) ?? []), value]);
    }
  }
  for (const [address, account] of index.raw) {
    if (account.owner === SYSTEM_PROGRAM) pubkeys.add(address);
  }
  return {
    pubkeys: [...pubkeys].slice(0, MAX_HINT_KEYS),
    args,
    accountsOfType: (typeName) =>
      [...index.decoded.values()].filter((d) => d.typeName === typeName).map((d) => d.raw),
  };
}

class Resolver {
  private readonly templates = new Map<string, SeedTemplate[]>();
  private readonly index: AccountIndex;
  private readonly codecs: CodecRegistry;
  readonly resolved = new Map<string, PdaInfo>();

  constructor(index: AccountIndex, codecs: CodecRegistry) {
    this.index = index;
    this.codecs = codecs;
    for (const codec of codecs.all()) this.templates.set(codec.id, collectTemplates(codec));
  }

  private context(programId: string): SeedContext | undefined {
    const codec = this.codecs.get(programId);
    return codec && { codec, accountData: (address) => this.index.decoded.get(address) };
  }

  fromTransactions(bindings: InstructionBinding[]): void {
    // Oldest first, so a PDA is explained by the instruction that created it.
    for (const binding of bindings.toSorted((a, b) => a.slot - b.slot)) {
      const ctx = this.context(binding.programId);
      if (!ctx) continue;
      const templates = (this.templates.get(binding.programId) ?? []).filter(
        (t) => t.instruction === binding.instruction,
      );
      for (const match of resolveFromInstruction(templates, binding.scope, ctx)) {
        if (!this.resolved.has(match.address)) this.resolved.set(match.address, match.info);
      }
    }
  }

  /** Program-owned, off-curve, not yet explained: candidates for seed guessing. */
  private unexplained(): [string, SeedContext][] {
    const out: [string, SeedContext][] = [];
    for (const [address, account] of this.index.raw) {
      if (account.executable || this.resolved.has(address) || isOnCurve(address)) continue;
      const ctx = this.context(account.owner);
      if (ctx) out.push([address, ctx]);
    }
    return out;
  }

  fromAccountData(hints: GuessHints): void {
    for (const [address, ctx] of this.unexplained()) {
      const templates = uniqueTemplates(this.templates.get(ctx.codec.id) ?? []);
      const match = guessSeeds(address, templates, ctx, hints);
      this.resolved.set(address, match?.info ?? { status: "unresolved" });
    }
  }
}

/**
 * Explains program-owned off-curve accounts: first by re-deriving PDAs from
 * observed instructions, then by guessing seeds from account data.
 */
export function resolvePdas(
  index: AccountIndex,
  codecs: CodecRegistry,
  bindings: InstructionBinding[],
): Map<string, PdaInfo> {
  const resolver = new Resolver(index, codecs);
  resolver.fromTransactions(bindings);
  resolver.fromAccountData(makeHints(index, bindings));
  return resolver.resolved;
}

export function pdaFindings(info: PdaInfo, storedBump: unknown): Finding[] {
  if (info.status === "unresolved") {
    const message = "Off-curve account whose seeds match no IDL template";
    return [{ severity: "info", code: "pda-unresolved", message }];
  }
  const findings: Finding[] = [];
  const { bump, canonicalBump } = info;
  if (bump !== undefined && canonicalBump !== undefined && bump !== canonicalBump) {
    findings.push({
      severity: "warning",
      code: "pda-noncanonical-bump",
      message: `Derived with bump ${bump}; canonical bump is ${canonicalBump}`,
    });
  }
  if (typeof storedBump === "number" && bump !== undefined && storedBump !== bump) {
    findings.push({
      severity: "warning",
      code: "pda-stored-bump-mismatch",
      message: `Stored bump ${storedBump} differs from the derivation bump ${bump}`,
    });
  }
  return findings;
}
