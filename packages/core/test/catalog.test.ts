import {
  CodecRegistry,
  inventory,
  nextUnloaded,
  selectInitial,
  type CatalogEntry,
} from "@anchorx-ray/core";
import { describe, expect, test } from "vitest";
import { fixturePrograms } from "./helpers.js";

const entry = (address: string, typeName: string | null, program = "P"): CatalogEntry => ({
  address,
  program,
  typeName,
});

const big = [
  ...Array.from({ length: 1000 }, (_, i) => entry(`v${i}`, "Vault")),
  entry("c0", "Config"),
  entry("u0", null),
];

describe("catalog", () => {
  test("selects round-robin so small types are not crowded out", () => {
    const picked = selectInitial(big, 10);
    expect(picked).toHaveLength(10);
    expect(picked.map((e) => e.address)).toEqual(expect.arrayContaining(["c0", "u0", "v0"]));
    expect(selectInitial(big.slice(0, 3), 10)).toHaveLength(3);
    expect(selectInitial(big, 0)).toEqual([]);
  });

  test("returns the next unloaded entries of one type", () => {
    const loaded = new Set(["v0", "v1"]);
    expect(nextUnloaded(big, loaded, "P", "Vault", 2).map((e) => e.address)).toEqual(["v2", "v3"]);
    expect(nextUnloaded(big, loaded, "P", null, 5).map((e) => e.address)).toEqual(["u0"]);
    expect(nextUnloaded(big, loaded, "Q", "Vault", 5)).toEqual([]);
  });

  test("counts totals and loaded accounts per type", () => {
    const codecs = new CodecRegistry(fixturePrograms());
    const accounts = [{ address: "v0", owner: "P", lamports: 0, executable: false, data: "" }];
    const rows = inventory(big, accounts, codecs);
    expect(rows).toEqual(
      expect.arrayContaining([
        { program: "P", typeName: "Vault", total: 1000, loaded: 1 },
        { program: "P", typeName: "Config", total: 1, loaded: 0 },
        { program: "P", typeName: null, total: 1, loaded: 0 },
      ]),
    );
    // No catalog (old snapshot): loaded accounts of known programs are the inventory.
    expect(inventory(undefined, accounts, codecs)).toEqual([]);
  });
});
