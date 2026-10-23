import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace, Session, type Snapshot } from "@anchorx-ray/core";
import { expect, test } from "vitest";
import { formatDiff, formatSnapshots, formatSummary, formatTimeline } from "./format.js";

const fixtures = fileURLToPath(new URL("../../core/test/fixtures", import.meta.url));

function session(): Session {
  const workspace = loadWorkspace({
    root: fixtures,
    idlPaths: ["xray_vault.json", "xray_registry.json"].map((f) => path.join(fixtures, f)),
  });
  const s = new Session({ workspace, rpcUrl: "http://127.0.0.1:1", txLimit: 0 });
  s.load(
    JSON.parse(fs.readFileSync(path.join(fixtures, "demo-snapshot.json"), "utf8")) as Snapshot,
  );
  return s;
}

test("summarizes programs and warning findings", () => {
  const text = formatSummary(session().model());
  expect(text).toMatch(/xray_vault \w+ \(\d+ accounts\)/);
  expect(text).toContain("canonical bump is");
  expect(text).toContain("discriminator matches no IDL account type");
});

test("prints a timeline with failures, CPIs and events", () => {
  const text = formatTimeline(session().timeline());
  expect(text).toMatch(/^FAIL slot \d+ .* xray_vault\.deposit$/m);
  expect(text).toContain("error: VaultFrozen (Vault is frozen)");
  expect(text).toContain("↳ xray_vault.deposit");
  expect(text).toContain("event EntryRegistered");
  expect(formatTimeline([])).toMatch(/No transactions/);
});

test("prints diffs and snapshot lists", () => {
  const diff = formatDiff({
    from: { slot: 1, fetchedAt: "" },
    to: { slot: 2, fetchedAt: "" },
    accounts: [
      {
        address: "A",
        change: "modified",
        typeName: "Vault",
        lamports: { before: 2_000_000_000, after: 1_500_000_000 },
        fields: [{ path: "total_deposits", before: "1", after: "2" }],
        rawDataChanged: false,
      },
    ],
  });
  expect(diff).toBe(
    'slot 1 → 2: 1 account(s) changed\n~ Vault A\n    lamports -0.5 SOL\n    total_deposits: "1" → "2"',
  );
  expect(formatSnapshots([])).toMatch(/No snapshots yet/);
});
