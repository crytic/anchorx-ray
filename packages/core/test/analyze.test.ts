import { buildModel, type AccountNode, type XrayModel } from "@anchorx-ray/core";
import { describe, expect, test } from "vitest";
import { demoContext, REGISTRY_ID, VAULT_ID } from "./helpers.js";

const byType = (model: XrayModel, typeName: string) =>
  model.accounts.filter((a) => a.typeName === typeName);
const withFinding = (model: XrayModel, code: string) =>
  model.accounts.filter((a) => a.findings.some((f) => f.code === code));

describe("buildModel on the recorded demo state", () => {
  const { snapshot, codecs, bindings } = demoContext();
  const model = buildModel(snapshot.state, codecs, bindings);

  test("classifies programs, PDAs, keypair accounts and wallets", () => {
    const kinds = (kind: AccountNode["kind"]) =>
      model.accounts.filter((a) => a.kind === kind).length;
    expect(model.accounts.find((a) => a.address === VAULT_ID)).toMatchObject({
      kind: "program",
      label: "xray_vault",
    });
    expect(model.accounts.find((a) => a.address === REGISTRY_ID)).toMatchObject({
      kind: "program",
    });
    expect(byType(model, "Vault")).toHaveLength(3);
    expect(byType(model, "Receipt").every((r) => r.kind === "keypair")).toBe(true);
    expect(kinds("wallet")).toBeGreaterThanOrEqual(3);
    expect(kinds("missing")).toBe(1);
  });

  test("verifies every PDA touched by a transaction", () => {
    for (const vault of byType(model, "Vault")) {
      expect(vault.pda).toMatchObject({ status: "verified", method: "transaction" });
      expect(vault.pda?.seeds?.map((s) => s.kind)).toEqual(["const", "account", "arg"]);
      expect(vault.pda?.bump).toBe(vault.pda?.canonicalBump);
    }
  });

  test("flags the injected non-canonical Config and the undecodable account", () => {
    const [nonCanonical, ...rest] = withFinding(model, "pda-noncanonical-bump");
    expect(rest).toHaveLength(0);
    expect(nonCanonical?.typeName).toBe("Config");
    expect(nonCanonical?.pda?.method).toBe("account-data");
    expect(nonCanonical?.pda?.bump).toBeLessThan(nonCanonical?.pda?.canonicalBump ?? 0);
    expect(withFinding(model, "undecodable-account")).toHaveLength(1);
    expect(withFinding(model, "pda-unresolved")).toHaveLength(0);
  });

  test("marks fields checked by has_one and leaves unchecked ones bare", () => {
    const fieldEdges = model.edges.filter((e) => e.kind === "field");
    const owner = fieldEdges.find((e) => e.label === "owner");
    expect(owner?.constrainedBy?.toSorted()).toEqual(["set_delegate", "withdraw"]);
    expect(fieldEdges.find((e) => e.label === "config")?.constrainedBy).toEqual(["set_state"]);
    expect(fieldEdges.find((e) => e.label === "authority")?.constrainedBy).toEqual(["register"]);
    expect(fieldEdges.filter((e) => e.label === "delegate").every((e) => !e.constrainedBy)).toBe(
      true,
    );
    expect(model.edges.some((e) => e.label === "entries[0]")).toBe(true);
  });

  test("recovers the same seeds from account data alone", () => {
    const blind = buildModel(snapshot.state, codecs, []);
    for (const node of blind.accounts.filter((a) => a.kind === "pda")) {
      const informed = model.accounts.find((a) => a.address === node.address);
      expect(node.pda?.status).toBe("verified");
      expect(node.pda?.seeds?.map((s) => s.hex)).toEqual(informed?.pda?.seeds?.map((s) => s.hex));
    }
    // Without transactions, has_one targets fall back to the account-name heuristic.
    const owner = blind.edges.find((e) => e.kind === "field" && e.label === "owner");
    expect(owner?.constrainedBy?.toSorted()).toEqual(["set_delegate", "withdraw"]);
  });

  test("reports upgrade authorities and dangling references", () => {
    const vaultProgram = model.accounts.find((a) => a.address === VAULT_ID);
    expect(typeof vaultProgram?.upgradeAuthority).toBe("string");
    const dangling = withFinding(model, "dangling-reference");
    expect(dangling.map((d) => d.typeName)).toEqual(["Config"]);
    expect(model.edges.filter((e) => e.kind === "programdata")).toHaveLength(2);
  });
});
