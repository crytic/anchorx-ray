import type { IdlInstruction } from "@anchor-lang/core";
import type { CodecRegistry, ProgramCodec } from "./codec.js";
import type { InstructionBinding } from "./tx.js";

/** `"<program>:<Type>.<field>"` → instructions whose `has_one` checks that field. */
export type Constraints = Map<string, Set<string>>;

type TypeOf = (address: string) => string | undefined;

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  map.set(key, (map.get(key) ?? new Set()).add(value));
}

/** Instruction accounts do not name their type in the IDL; learn it from transactions. */
function observedTypes(bindings: InstructionBinding[], typeOf: TypeOf): Map<string, Set<string>> {
  const observed = new Map<string, Set<string>>();
  for (const b of bindings) {
    for (const [name, address] of b.scope.accounts) {
      const typeName = typeOf(address);
      if (typeName) addTo(observed, `${b.programId}:${b.instruction}:${name}`, typeName);
    }
  }
  return observed;
}

/** Falls back to the Anchor convention that `vault: Account<Vault>` is named after its type. */
function typeFromName(accountName: string, typeNames: Set<string>): Set<string> {
  const pascal = accountName.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
  return typeNames.has(pascal) ? new Set([pascal]) : new Set();
}

function addInstruction(
  codec: ProgramCodec,
  ix: IdlInstruction,
  observed: Map<string, Set<string>>,
  constraints: Constraints,
): void {
  const typeNames = new Set((codec.idl.accounts ?? []).map((a) => a.name));
  for (const acc of ix.accounts) {
    if ("accounts" in acc) continue;
    // `relations: ["vault"]` on account `owner` means `vault.owner == owner` (has_one).
    for (const holder of acc.relations ?? []) {
      const key = `${codec.id}:${ix.name}:${holder}`;
      for (const typeName of observed.get(key) ?? typeFromName(holder, typeNames)) {
        addTo(constraints, `${codec.id}:${typeName}.${acc.name}`, ix.name);
      }
    }
  }
}

export function hasOneConstraints(
  codecs: CodecRegistry,
  bindings: InstructionBinding[],
  typeOf: TypeOf,
): Constraints {
  const observed = observedTypes(bindings, typeOf);
  const constraints: Constraints = new Map();
  for (const codec of codecs.all()) {
    for (const ix of codec.idl.instructions) addInstruction(codec, ix, observed, constraints);
  }
  return constraints;
}
