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
    expect(run(["scan", "--rpc", "http://x", "-o", "out.json"])).toMatchObject({
      rpc: "http://x",
      out: "out.json",
    });
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
  });
});
