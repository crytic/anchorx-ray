import { describe, expect, test } from "vitest";
import {
  indexSharedPatterns,
  type AccountNode,
  type SharedAddress,
  type XrayModel,
} from "@anchorx-ray/core";

function account(address: string, typeName: string): AccountNode {
  return {
    address,
    typeName,
    program: "program-a",
    kind: "pda",
    label: typeName,
    owner: "program-a",
    lamports: 0,
    dataLen: 0,
    executable: false,
    onCurve: false,
    findings: [],
  };
}

function model(accounts: AccountNode[], sharedAddresses: SharedAddress[]): XrayModel {
  return {
    slot: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
    programs: [],
    accounts,
    edges: [],
    sharedAddresses,
  };
}

describe("shared field patterns", () => {
  test("thousands of equal fields of one type make one review item", () => {
    const accounts = Array.from({ length: 10_000 }, (_, i) => account(`account-${i}`, "Vault"));
    const sharedAddresses = [
      {
        value: "shared-authority",
        occurrences: accounts.map(({ address }) => ({ account: address, path: "owner" })),
      },
    ];
    const index = indexSharedPatterns(model(accounts, sharedAddresses));
    expect(index.patterns).toHaveLength(1);
    expect(index.patterns[0]).toMatchObject({
      left: { typeName: "Vault", path: "owner" },
      right: { typeName: "Vault", path: "owner" },
      matchedValues: 1,
    });
    expect([...index.pathsByAccount.get("account-9999")!.keys()]).toEqual(["shared-authority"]);
  });

  test("reuses one pattern across different equal address values", () => {
    const accounts = [
      account("a1", "Vault"),
      account("b1", "Registry"),
      account("a2", "Vault"),
      account("b2", "Registry"),
    ];
    const sharedAddresses = ["first", "second"].map((value, i) => ({
      value,
      occurrences: [
        { account: `a${i + 1}`, path: "owner" },
        { account: `b${i + 1}`, path: "authority" },
      ],
    }));
    const index = indexSharedPatterns(model(accounts, sharedAddresses));
    expect(index.patterns).toHaveLength(1);
    expect(index.patterns[0]?.matchedValues).toBe(2);
    expect(index.patterns[0]?.examples.map((item) => item.value)).toEqual(["first", "second"]);
  });

  test("normalizes array positions but retains concrete example paths", () => {
    const accounts = [account("a", "Route")];
    const index = indexSharedPatterns(
      model(accounts, [
        {
          value: "shared",
          occurrences: [
            { account: "a", path: "entries[0].mint" },
            { account: "a", path: "entries[1].mint" },
          ],
        },
      ]),
    );
    expect(index.patterns).toHaveLength(1);
    expect(index.patterns[0]?.left.path).toBe("entries[].mint");
    expect(index.patterns[0]?.examples[0]?.right.path).toBe("entries[1].mint");
    expect(index.pathsByAccount.get("a")?.get("shared")).toEqual(new Set(["entries[].mint"]));
  });
});
