import { decodeTransaction, type RawTransaction } from "@anchorx-ray/core";
import { describe, expect, test } from "vitest";
import { demoContext, VAULT_ID } from "./helpers.js";

describe("decodeTransaction", () => {
  const { snapshot, codecs, decoded } = demoContext();
  const entries = decoded.map((d) => d.entry);
  const first = (name: string) => entries.find((e) => e.instructions[0]?.name === name);

  test("names instructions, arguments and accounts from the IDL", () => {
    const create = first("create_vault");
    expect(create?.instructions[0]).toMatchObject({
      programName: "xray_vault",
      depth: 0,
      index: "1",
    });
    expect(create?.instructions[0]?.accounts.map((a) => a.name)).toEqual([
      "owner",
      "config",
      "vault",
      "system_program",
    ]);
    expect(create?.instructions[1]).toMatchObject({
      programName: "system",
      name: "Create",
      depth: 1,
      index: "1.1",
    });
    expect(create?.events.map((e) => e.name)).toEqual(["VaultCreated"]);
  });

  test("decodes CPIs into other known programs and emit_cpi events", () => {
    const via = first("deposit_via_registry");
    expect(via?.instructions.find((i) => i.index === "1.1")).toMatchObject({
      programName: "xray_vault",
      name: "deposit",
    });
    const register = first("register");
    expect(register?.events).toEqual([
      expect.objectContaining({ name: "EntryRegistered", via: "cpi" }),
    ]);
  });

  test("resolves custom error codes to IDL error names", () => {
    const failed = entries.filter((e) => !e.success);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({
      code: 6001,
      name: "VaultFrozen",
      msg: "Vault is frozen",
      program: VAULT_ID,
    });
  });

  test("blames the innermost program when a CPI fails", () => {
    const via = snapshot.transactions.find(
      (t) => decodeTransaction(t, codecs).entry.instructions[0]?.name === "deposit_via_registry",
    ) as RawTransaction;
    const registry = via.accountKeys[via.instructions[0]?.programIdIndex ?? 0]?.pubkey;
    const failed: RawTransaction = {
      ...via,
      err: { InstructionError: [0, { Custom: 6001 }] },
      logs: [
        `Program ${registry} invoke [1]`,
        `Program ${VAULT_ID} invoke [2]`,
        `Program ${VAULT_ID} failed: custom program error: 0x1771`,
        `Program ${registry} failed: custom program error: 0x1771`,
      ],
    };
    expect(decodeTransaction(failed, codecs).entry.error).toMatchObject({
      program: VAULT_ID,
      name: "VaultFrozen",
    });
  });

  test("records lamport movements", () => {
    const deposit = first("deposit");
    expect(deposit?.balanceChanges.length).toBeGreaterThan(0);
    for (const change of deposit?.balanceChanges ?? [])
      expect(change.before).not.toBe(change.after);
  });

  test("falls back to raw data for unknown programs and malformed input", () => {
    const tx = snapshot.transactions[0] as RawTransaction;
    const garbled: RawTransaction = {
      ...tx,
      err: { InstructionError: [0, { Custom: 6001 }] },
      instructions: [
        {
          programIdIndex: 0,
          accounts: [],
          data: Buffer.from([1, 2, 3]).toString("base64"),
          stackHeight: 1,
        },
      ],
      logs: ["Program data: !!not-base64!!"],
    };
    const { entry, bindings } = decodeTransaction(garbled, codecs);
    expect(entry.instructions[0]?.name).toBeUndefined();
    expect(entry.instructions[0]?.data).toBe("010203");
    expect(entry.events).toEqual([]);
    expect(bindings).toEqual([]);
    expect(entry.error?.name).toBeUndefined();
  });
});
