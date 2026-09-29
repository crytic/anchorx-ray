import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BN } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import {
  clusterToRpcUrl,
  filterPrograms,
  collectPubkeys,
  seedBytesFor,
  toJson,
  typeAtPath,
  diffAccount,
  diffJson,
  loadSnapshot,
  loadWorkspace,
  parseIdl,
  resolveFromInstruction,
  saveSnapshot,
  CodecRegistry,
  SNAPSHOT_FORMAT,
  type RawAccount,
} from "@anchorx-ray/core";
import { describe, expect, test } from "vitest";
import { demoSnapshot, fixtureIdl, fixturePrograms } from "./helpers.js";

const KEY = new PublicKey("6PLfEPyKqpNThbdTSCBVuUBAjUpZCoh3DzdTDeLsbGh4");

describe("json", () => {
  test("normalizes coder output without losing precision", () => {
    const value = {
      a: new BN("18446744073709551615"),
      k: KEY,
      b: Buffer.from([1, 255]),
      n: [1, null],
      big: 5n,
    };
    expect(toJson(value)).toEqual({
      a: "18446744073709551615",
      k: KEY.toBase58(),
      b: "0x01ff",
      n: [1, null],
      big: "5",
    });
    expect(toJson(Number.NaN)).toBe("NaN");
  });

  test("finds nested keys with their paths", () => {
    const refs = collectPubkeys({ owner: KEY, list: [KEY], nested: { opt: KEY, n: new BN(3) } });
    expect(refs.map((r) => r.path)).toEqual(["owner", "list[0]", "nested.opt"]);
  });
});

describe("seed serialization", () => {
  test("encodes integers little-endian at the declared width", () => {
    expect(seedBytesFor(new BN(1), "u64")?.bytes.toString("hex")).toBe("0100000000000000");
    expect(seedBytesFor(-1, "i16")?.bytes.toString("hex")).toBe("ffff");
    expect(seedBytesFor("258", "u32")?.bytes.toString("hex")).toBe("02010000");
    expect(seedBytesFor(1.5, "u8")).toBeUndefined();
    // Values guessed from other instructions may not fit the seed's type.
    expect(seedBytesFor(new BN(1000), "u8")).toBeUndefined();
    expect(seedBytesFor(-1, "u64")).toBeUndefined();
    expect(seedBytesFor(127, "i8")?.bytes.toString("hex")).toBe("7f");
    expect(seedBytesFor(-128, "i8")?.bytes.toString("hex")).toBe("80");
    expect(seedBytesFor(128, "i8")).toBeUndefined();
    expect(seedBytesFor(-129, "i8")).toBeUndefined();
  });

  test("encodes keys, strings, bools and bytes", () => {
    expect(seedBytesFor(KEY.toBase58(), "pubkey")?.pubkey).toBe(KEY.toBase58());
    expect(seedBytesFor("not a key", "pubkey")).toBeUndefined();
    expect(seedBytesFor("vault", "string")?.bytes.toString()).toBe("vault");
    expect(seedBytesFor(true, "bool")?.bytes).toEqual(Buffer.from([1]));
    expect(seedBytesFor([1, 2], { array: ["u8", 2] })?.display).toBe("0x0102");
    expect(seedBytesFor({}, undefined)).toBeUndefined();
  });

  test("resolves field types through the IDL", () => {
    const idl = fixtureIdl("xray_vault");
    expect(typeAtPath(idl, "Vault", ["vault_id"])).toBe("u64");
    expect(typeAtPath(idl, "Vault", ["missing"])).toBeUndefined();
    expect(typeAtPath(idl, "Vault", ["owner", "deeper"])).toBeUndefined();
  });
});

describe("PDA resolution", () => {
  test("resolves seeds relative to the composite struct holding the PDA", () => {
    const codecs = new CodecRegistry(fixturePrograms());
    const codec = codecs.get(KEY.toBase58());
    if (!codec) throw new Error("vault codec missing");
    const innerOwner = PublicKey.unique();
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), innerOwner.toBuffer()],
      KEY,
    );
    const template = {
      declaringProgram: KEY.toBase58(),
      instruction: "nested",
      account: "inner.vault",
      seeds: [
        { kind: "const" as const, value: [...Buffer.from("vault")] },
        { kind: "account" as const, path: "owner" },
      ],
    };
    const scope = {
      accounts: new Map([
        ["inner.vault", expected.toBase58()],
        ["inner.owner", innerOwner.toBase58()],
        ["owner", PublicKey.unique().toBase58()],
      ]),
      args: {},
    };
    const matches = resolveFromInstruction([template], scope, {
      codec,
      accountData: () => undefined,
    });
    expect(matches.map((m) => m.address)).toEqual([expected.toBase58()]);
  });
});

describe("workspace", () => {
  test("filters programs by name or id", () => {
    const programs = fixturePrograms();
    const names = (list: typeof programs) => list.map((p) => p.name);
    expect(names(filterPrograms(programs, ["xray_vault"]))).toEqual(["xray_vault"]);
    expect(names(filterPrograms(programs, [], [KEY.toBase58()]))).toEqual(["xray_registry"]);
    expect(names(filterPrograms(programs))).toEqual(["xray_registry", "xray_vault"]);
    expect(() => filterPrograms(programs, ["nope"])).toThrow(/--include: unknown program nope/);
    expect(() => filterPrograms(programs, [], ["xray_vault", "xray_registry"])).toThrow(
      /No program left/,
    );
  });

  test("rejects legacy and non-IDL JSON with actionable messages", () => {
    expect(() => parseIdl({ version: "0.1.0", name: "old", instructions: [] }, "old.json")).toThrow(
      /anchor idl convert/,
    );
    expect(() => parseIdl({ foo: 1 }, "x.json")).toThrow(/not an Anchor IDL/);
    expect(() => parseIdl([], "x.json")).toThrow(/not an Anchor IDL/);
    expect(() => parseIdl(null, "x.json")).toThrow(/JSON object/);
  });

  test("maps cluster names to RPC URLs", () => {
    expect(clusterToRpcUrl("Localnet")).toBe("http://127.0.0.1:8899");
    expect(clusterToRpcUrl("https://rpc.example")).toBe("https://rpc.example");
    expect(() => clusterToRpcUrl("moon")).toThrow(/Unknown cluster/);
  });

  test("prefers Anchor.toml program ids over IDL addresses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xray-ws-"));
    fs.mkdirSync(path.join(root, "target", "idl"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "target", "idl", "xray_vault.json"),
      JSON.stringify(fixtureIdl("xray_vault")),
    );
    const override = "11111111111111111111111111111112";
    fs.writeFileSync(
      path.join(root, "Anchor.toml"),
      `[provider]\ncluster = "devnet"\n[programs.devnet]\nxray_vault = "${override}"\n`,
    );
    const ws = loadWorkspace({ root });
    expect(ws.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(ws.programs[0]?.id).toBe(override);
    expect(ws.programs[0]?.idl.address).toBe(override);
    expect(ws.warnings[0]).toMatch(/differs from Anchor.toml/);
    expect(() => loadWorkspace({ root: os.tmpdir(), idlPaths: [] })).toThrow(/No IDL found/);
    expect(() => loadWorkspace({ root, idlPaths: [path.join(root, "nope.json")] })).toThrow(
      /Cannot read IDL/,
    );
    fs.rmSync(root, { recursive: true });
  });
});

describe("diff", () => {
  test("reports leaf changes in nested JSON", () => {
    expect(
      diffJson({ a: 1, b: [1, 2], c: { d: "x" } }, { a: 1, b: [1], c: { d: "y" }, e: true }),
    ).toEqual([
      { path: "b[1]", before: 2, after: undefined },
      { path: "c.d", before: "x", after: "y" },
      { path: "e", before: undefined, after: true },
    ]);
    expect(diffJson(1, 2)).toEqual([{ path: "(root)", before: 1, after: 2 }]);
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
    expect(diffJson(undefined, { a: { b: 1 }, c: [2] })).toEqual([
      { path: "a.b", before: undefined, after: 1 },
      { path: "c[0]", before: undefined, after: 2 },
    ]);
    expect(diffJson({ a: 1 }, undefined)).toEqual([{ path: "a", before: 1, after: undefined }]);
  });

  test("classifies added, removed, modified and unchanged accounts", () => {
    const codecs = new CodecRegistry(fixturePrograms());
    const base: RawAccount = {
      address: "A",
      owner: "Z",
      lamports: 1,
      executable: false,
      data: "AAAA",
    };
    expect(diffAccount(undefined, base, codecs)?.change).toBe("added");
    expect(diffAccount(base, undefined, codecs)?.change).toBe("removed");
    expect(diffAccount(base, { ...base }, codecs)).toBeUndefined();
    expect(diffAccount(base, { ...base, lamports: 2 }, codecs)?.lamports).toEqual({
      before: 1,
      after: 2,
    });
    const hashed = { ...base, truncated: { length: 9, sha256: "aa" } };
    expect(
      diffAccount(hashed, { ...hashed, truncated: { length: 9, sha256: "bb" } }, codecs)
        ?.rawDataChanged,
    ).toBe(true);
  });
});

describe("snapshots", () => {
  test("round-trips and validates names and format", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xray-snap-"));
    const snapshot = { ...demoSnapshot(), name: "round-trip" };
    saveSnapshot(root, snapshot);
    expect(loadSnapshot(root, "round-trip").state.slot).toBe(snapshot.state.slot);
    expect(() => saveSnapshot(root, { ...snapshot, name: "../escape" })).toThrow(
      /Invalid snapshot name/,
    );
    expect(() => loadSnapshot(root, "absent")).toThrow(/not found/);
    fs.writeFileSync(
      path.join(root, ".anchorx-ray", "snapshots", "bad.json"),
      JSON.stringify({ format: "other" }),
    );
    expect(() => loadSnapshot(root, "bad")).toThrow(new RegExp(SNAPSHOT_FORMAT));
    fs.rmSync(root, { recursive: true });
  });
});
