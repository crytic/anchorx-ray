import { describe, expect, test } from "vitest";
import { parseCli } from "./args.js";

const run = (argv: string[]) => {
  const parsed = parseCli(argv);
  if (parsed.kind !== "run") throw new Error(`expected run, got ${parsed.kind}`);
  return parsed.options;
};

describe("parseCli", () => {
  test("defaults to the UI with watch and browser enabled", () => {
    expect(run([])).toMatchObject({
      command: "ui",
      open: true,
      watch: true,
      port: 3000,
      txLimit: 100,
      idl: [],
    });
  });

  test("parses commands, repeatable IDLs and negated flags", () => {
    const options = run([
      "diff",
      "a",
      "b",
      "--idl",
      "x.json",
      "--idl",
      "y.json",
      "--no-open",
      "--no-watch",
      "-p",
      "0",
    ]);
    expect(options).toMatchObject({
      command: "diff",
      positionals: ["a", "b"],
      idl: ["x.json", "y.json"],
      open: false,
      watch: false,
      port: 0,
    });
    expect(run(["--include", "a,b", "--include", "c", "--exclude", "d"])).toMatchObject({
      include: ["a", "b", "c"],
      exclude: ["d"],
    });
    expect(run(["scan", "--rpc", "http://x", "-o", "out.json"])).toMatchObject({
      rpc: "http://x",
      out: "out.json",
    });
    expect(run(["ui", "--peer", "Local:3001", "--peer", "Devnet:3002"]).peers).toEqual([
      { label: "Local", port: 3001 },
      { label: "Devnet", port: 3002 },
    ]);
  });

  test("handles help and version", () => {
    expect(parseCli(["-h"])).toEqual({ kind: "help" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
  });

  test("rejects unknown commands, bad arity and bad numbers", () => {
    expect(() => parseCli(["explode"])).toThrow(/Unknown command/);
    expect(() => parseCli(["snapshot"])).toThrow(/takes 1 argument/);
    expect(() => parseCli(["diff", "a", "b", "c"])).toThrow(/takes 1-2 argument/);
    expect(() => parseCli(["--tx-limit=-3"])).toThrow(/non-negative integer/);
    expect(() => parseCli(["--port", "abc"])).toThrow(/non-negative integer/);
    expect(() => parseCli(["--bogus"])).toThrow(/Unknown option/);
    expect(() => parseCli(["--peer", "Local:0"])).toThrow(/--peer must be/);
    expect(() => parseCli(["--peer", "Local:65536"])).toThrow(/--peer must be/);
    expect(() => parseCli(["--peer", "Local"])).toThrow(/--peer must be/);
    expect(() => parseCli(["--peer", "Local:3001", "--peer", "Devnet:3001"])).toThrow(/unique/);
    expect(() => parseCli(["--peer", "Self:3000"])).toThrow(/differ/);
  });
});
