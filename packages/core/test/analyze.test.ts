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

  test("groups equal typed addresses across accounts and repeated fields", () => {
    const owner = model.sharedAddresses.find(
      (group) => group.value === "YdS6tCzHnjVxeuRGkvFThRydMBvesjsKQUHWN4TXcr8",
    );
    expect(owner?.occurrences.map((item) => item.path)).toEqual([
      "authority",
      "owner",
      "depositor",
      "owner",
    ]);
    expect(owner?.occurrences.find((item) => item.path === "authority")?.hasOneIn).toEqual([
      "register",
    ]);
    const admin = model.sharedAddresses.find(
      (group) => group.value === "DCYZPbER4kaYM8CMzwvcDJvfhVcigoarWUJTPNkqpmsv",
    );
    expect(admin?.occurrences.some((item) => item.path === "treasury")).toBe(true);
    expect(admin?.occurrences.some((item) => item.path === "admin")).toBe(true);
    expect(
      model.sharedAddresses.some((group) => group.value === "11111111111111111111111111111111"),
    ).toBe(false);
  });

  test("keeps shared fields when their target account was not fetched", () => {
    const sharedValue = "YdS6tCzHnjVxeuRGkvFThRydMBvesjsKQUHWN4TXcr8";
    const state = {
      ...snapshot.state,
      referenced: snapshot.state.referenced.filter((account) => account.address !== sharedValue),
    };
    const partial = buildModel(state, codecs, bindings);
    expect(partial.accounts.some((account) => account.address === sharedValue)).toBe(false);
    expect(partial.edges.some((edge) => edge.kind === "field" && edge.to === sharedValue)).toBe(
      false,
    );
    expect(
      partial.sharedAddresses.find((group) => group.value === sharedValue)?.occurrences,
    ).toHaveLength(4);
  });

  test("reports two matching fields inside one decoded account", () => {
    const configAddress = "CKh8uev6UG7JS1usmKce9dD7DGkcYEozGzjeykWKTuE1";
    const config = snapshot.state.accounts.find((account) => account.address === configAddress);
    if (!config) throw new Error("recorded Config account missing");
    const state = {
      ...snapshot.state,
      accounts: [config],
      referenced: [],
      missing: [],
      catalog: [],
    };
    const isolated = buildModel(state, codecs, []);
    expect(isolated.sharedAddresses).toEqual([
      {
        value: "DCYZPbER4kaYM8CMzwvcDJvfhVcigoarWUJTPNkqpmsv",
        occurrences: [
          { account: configAddress, path: "admin", hasOneIn: ["set_state"] },
          { account: configAddress, path: "treasury" },
        ],
      },
    ]);
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

  test("names wallets by their instruction roles and missing accounts by the referencing field", () => {
    const wallets = model.accounts.filter((a) => a.kind === "wallet");
    expect(wallets.map((w) => w.label).toSorted()).toEqual([
      "admin",
      "depositor · owner",
      "owner · authority",
    ]);
    expect(model.accounts.find((a) => a.kind === "missing")?.label).toBe("Config.treasury");
    const admin = wallets.find((w) => w.label === "admin");
    expect(admin?.roles).toEqual(["admin"]);
  });

  test("reports upgrade authorities and dangling references", () => {
    const vaultProgram = model.accounts.find((a) => a.address === VAULT_ID);
    expect(typeof vaultProgram?.upgradeAuthority).toBe("string");
    const dangling = withFinding(model, "dangling-reference");
    expect(dangling.map((d) => d.typeName)).toEqual(["Config"]);
    expect(model.edges.filter((e) => e.kind === "programdata")).toHaveLength(2);
  });
});
