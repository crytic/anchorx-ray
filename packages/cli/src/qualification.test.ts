import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QualificationReview, SharedAddress, XrayModel } from "@anchorx-ray/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QualificationService, sourceFingerprint, type ReviewRunner } from "./qualification.js";

const roots: string[] = [];

function sourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xray-qualification-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "program.rs"), "pub fn use_account() {}\n");
  return root;
}

function model(values = ["value-one"]): XrayModel {
  const accounts = values.flatMap((value, i) => [
    { address: `vault-${i}`, typeName: "Vault", path: "owner", value },
    { address: `registry-${i}`, typeName: "Registry", path: "authority", value },
  ]);
  const sharedAddresses: SharedAddress[] = values.map((value, i) => ({
    value,
    occurrences: [
      { account: `vault-${i}`, path: "owner" },
      { account: `registry-${i}`, path: "authority" },
    ],
  }));
  return {
    slot: 1,
    fetchedAt: "2026-01-01T00:00:00Z",
    programs: [
      {
        id: "program-a",
        name: "program-a",
        version: "1",
        deployed: true,
        accountTypes: ["Vault", "Registry"],
        instructions: [],
        events: [],
        inventory: [{ typeName: "Vault", total: 1_000_000, loaded: values.length }],
      },
    ],
    accounts: accounts.map((item) => ({
      address: item.address,
      typeName: item.typeName,
      program: "program-a",
      kind: "pda",
      label: item.typeName,
      owner: "program-a",
      lamports: 0,
      dataLen: 0,
      executable: false,
      onCurve: false,
      findings: [],
    })),
    edges: [],
    sharedAddresses,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("qualification service", () => {
  test("deduplicates requests and reuses verdicts for new matching accounts", async () => {
    const root = sourceRoot();
    const calls: string[][] = [];
    const run = async (
      _root: string,
      patterns: { id: string }[],
    ): Promise<QualificationReview[]> => {
      calls.push(patterns.map((item) => item.id));
      return patterns.map((item) => ({
        id: item.id,
        verdict: "inconclusive",
        summary: "Need more evidence",
        scope: "all",
        evidence: [],
      }));
    };
    const service = new QualificationService(root, run, async () => undefined);
    const first = model();
    service.start(first);
    service.start(first);
    await vi.waitFor(() => expect(service.view(first, "vault-0").phase).toBe("complete"));
    expect(calls).toHaveLength(1);
    expect(service.view(first, "vault-0").groups[0]?.patterns[0]?.review?.summary).toBe(
      "Need more evidence",
    );

    const expanded = model(["value-one", "value-two"]);
    service.start(expanded);
    expect(service.view(expanded, "vault-1").phase).toBe("complete");
    expect(calls).toHaveLength(1);
    expect(service.view(expanded, "vault-1").groups[0]?.patterns[0]?.matchedValues).toBe(2);
  });

  test("qualifies many distinct patterns in bounded parallel batches", async () => {
    const root = sourceRoot();
    const current = model(Array.from({ length: 21 }, (_, index) => `value-${index}`));
    current.sharedAddresses = current.sharedAddresses.map((shared, index) => ({
      ...shared,
      occurrences: shared.occurrences.map((occurrence) => ({
        ...occurrence,
        path: `${occurrence.path}-${index}`,
      })),
    }));
    const calls: number[] = [];
    const run: ReviewRunner = async (_root, patterns) => {
      calls.push(patterns.length);
      return patterns.map((pattern) => ({
        id: pattern.id,
        verdict: "inconclusive",
        summary: "Need more evidence",
        scope: "all",
        evidence: [],
      }));
    };
    const service = new QualificationService(root, run, async () => undefined);
    service.start(current);
    await vi.waitFor(() => expect(service.view(current, "vault-0").phase).toBe("complete"));
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls)).toBeLessThanOrEqual(8);
    expect(calls.reduce((sum, count) => sum + count, 0)).toBe(21);
  });

  test("source changes invalidate cached verdicts", async () => {
    const root = sourceRoot();
    let calls = 0;
    const run = async (
      _root: string,
      patterns: { id: string }[],
    ): Promise<QualificationReview[]> => {
      calls += 1;
      return patterns.map((item) => ({
        id: item.id,
        verdict: "inconclusive",
        summary: "unknown",
        scope: "all",
        evidence: [],
      }));
    };
    const service = new QualificationService(root, run, async () => undefined);
    const current = model();
    const before = sourceFingerprint(root);
    service.start(current);
    await vi.waitFor(() => expect(service.view(current, "vault-0").phase).toBe("complete"));
    fs.writeFileSync(path.join(root, "program.rs"), "pub fn use_account() { check(); }\n");
    expect(sourceFingerprint(root)).not.toBe(before);
    service.start(current);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(service.view(current, "vault-0").phase).toBe("complete"));
  });

  test("reports an unavailable ChatGPT sign-in without calling the model", async () => {
    const root = sourceRoot();
    const run = vi.fn<() => Promise<QualificationReview[]>>(async () => []);
    const service = new QualificationService(root, run, async () => {
      throw new Error("Run codex login");
    });
    const current = model();
    service.start(current);
    await vi.waitFor(() => expect(service.view(current, "vault-0").phase).toBe("failed"));
    expect(service.view(current, "vault-0").error).toContain("codex login");
    expect(run).not.toHaveBeenCalled();
  });

  test("discards a review if the source changes while Codex reads it", async () => {
    const root = sourceRoot();
    const run = async (
      _root: string,
      patterns: { id: string }[],
    ): Promise<QualificationReview[]> => {
      fs.writeFileSync(path.join(root, "program.rs"), "pub fn changed() {}\n");
      return patterns.map((item) => ({
        id: item.id,
        verdict: "enforced",
        summary: "old code",
        scope: "old",
        evidence: [],
      }));
    };
    const service = new QualificationService(root, run, async () => undefined);
    const current = model();
    service.start(current);
    await vi.waitFor(() => expect(service.view(current, "vault-0").phase).toBe("failed"));
    expect(service.view(current, "vault-0").completed).toBe(0);
    expect(service.view(current, "vault-0").error).toContain("changed during Codex review");
  });
});
