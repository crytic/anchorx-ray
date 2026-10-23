import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Idl } from "@anchor-lang/core";
import {
  CodecRegistry,
  decodeTransaction,
  type LoadedProgram,
  type Snapshot,
} from "@anchorx-ray/core";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const VAULT_ID = "6PLfEPyKqpNThbdTSCBVuUBAjUpZCoh3DzdTDeLsbGh4";
export const REGISTRY_ID = "DtkVbe7MzaPYfZ5cgmp1QaVWtd592LW5ffG5BVUp3sGx";

export function fixtureIdl(name: "xray_vault" | "xray_registry"): Idl {
  return JSON.parse(fs.readFileSync(fixture(`${name}.json`), "utf8")) as Idl;
}

export function fixturePrograms(): LoadedProgram[] {
  return (["xray_registry", "xray_vault"] as const).map((name) => {
    const idl = fixtureIdl(name);
    return { id: idl.address, name, idl, source: fixture(`${name}.json`) };
  });
}

/** State and transactions recorded from the e2e scenario (`ANCHORX_RAY_WRITE_FIXTURE=1 pnpm test:e2e`). */
export function demoSnapshot(): Snapshot {
  return JSON.parse(fs.readFileSync(fixture("demo-snapshot.json"), "utf8")) as Snapshot;
}

export function demoContext() {
  const snapshot = demoSnapshot();
  const codecs = new CodecRegistry(fixturePrograms());
  const decoded = snapshot.transactions.map((raw) => decodeTransaction(raw, codecs));
  return { snapshot, codecs, decoded, bindings: decoded.flatMap((d) => d.bindings) };
}
