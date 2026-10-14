import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  indexSharedPatterns,
  type QualificationReview,
  type QualificationView,
  type SharedPattern,
  type SharedPatternIndex,
  type XrayModel,
} from "@anchorx-ray/core";
import { checkCodexSubscription, reviewWithCodex } from "./codex-review.js";

const BATCH_SIZE = 8;
const CONCURRENCY = 2;
const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".jsx", ".toml", ".json"]);
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".anchor",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  "test-ledger",
]);

export type ReviewRunner = (
  root: string,
  patterns: SharedPattern[],
  signal?: AbortSignal,
) => Promise<QualificationReview[]>;

function addSourceEntry(
  directory: string,
  entry: Dirent,
  pending: string[],
  result: string[],
): void {
  if (entry.name.startsWith(".") && entry.name !== ".github") return;
  const file = path.join(directory, entry.name);
  if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) pending.push(file);
  if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) result.push(file);
}

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      addSourceEntry(directory, entry, pending, result);
    }
    if (result.length > 20_000) throw new Error("Source tree exceeds 20,000 files");
  }
  return result.toSorted();
}

/** Content fingerprint of local source and IDL data, independent of account count. */
export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of sourceFiles(root)) {
    const size = fs.statSync(file).size;
    bytes += size;
    if (bytes > 128 * 1024 * 1024) {
      throw new Error("Source tree exceeds 128 MiB; use a narrower workspace for AI review");
    }
    hash.update(path.relative(root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function coverage(model: XrayModel): { loadedAccounts: number; catalogAccounts: number } {
  const rows = model.programs.flatMap((program) => program.inventory);
  return {
    loadedAccounts: rows.reduce((sum, row) => sum + row.loaded, 0),
    catalogAccounts: rows.reduce((sum, row) => sum + row.total, 0),
  };
}

/** Keeps verdicts per source version and schema pattern, shared across every account. */
export class QualificationService {
  private readonly root: string;
  private readonly run: ReviewRunner;
  private readonly checkLogin: (signal?: AbortSignal) => Promise<void>;
  private readonly cache = new Map<string, QualificationReview>();
  private indexed?: {
    model: XrayModel;
    index: SharedPatternIndex;
    accounts: Map<string, XrayModel["accounts"][number]>;
    patterns: Map<string, SharedPattern>;
  };
  private fingerprint?: string;
  private controller: AbortController | undefined;
  private active: Promise<void> | undefined;
  private error: string | undefined;
  private reviewedAt?: string;

  constructor(
    root: string,
    run: ReviewRunner = reviewWithCodex,
    checkLogin: (signal?: AbortSignal) => Promise<void> = checkCodexSubscription,
  ) {
    this.root = path.resolve(root);
    this.run = run;
    this.checkLogin = checkLogin;
  }

  private index(model: XrayModel): SharedPatternIndex {
    if (this.indexed?.model !== model) {
      const index = indexSharedPatterns(model);
      this.indexed = {
        model,
        index,
        accounts: new Map(model.accounts.map((account) => [account.address, account])),
        patterns: new Map(index.patterns.map((item) => [item.id, item])),
      };
    }
    return this.indexed.index;
  }

  private cacheKey(id: string): string {
    return `${this.fingerprint}:${id}`;
  }

  private groups(
    index: SharedPatternIndex,
    account: string,
    selected: XrayModel["accounts"][number],
  ) {
    return [...(index.pathsByAccount.get(account)?.keys() ?? [])].map((value) => {
      const ownPaths = index.pathsByAccount.get(account)?.get(value) ?? new Set<string>();
      const ownField = (field: SharedPattern["left"]) =>
        field.program === selected.program &&
        field.typeName === selected.typeName &&
        ownPaths.has(field.path);
      const matched = (index.byValue.get(value) ?? []).flatMap((id) => {
        const pattern = this.indexed!.patterns.get(id);
        if (!pattern) return [];
        if (!ownField(pattern.left) && !ownField(pattern.right)) return [];
        const review = this.fingerprint ? this.cache.get(this.cacheKey(id)) : undefined;
        return [{ ...pattern, ...(review ? { review } : {}) }];
      });
      return { value, patterns: matched };
    });
  }

  private phase(total: number, completed: number): QualificationView["phase"] {
    if (this.active) return "running";
    if (this.error) return "failed";
    if (total > 0 && completed === total) return "complete";
    return "idle";
  }

  view(model: XrayModel, account: string): QualificationView {
    const index = this.index(model);
    const selected = this.indexed!.accounts.get(account);
    if (!selected) throw new Error(`Account ${account} is not in the current model`);
    const total = index.patterns.length;
    const completed = this.fingerprint
      ? index.patterns.filter((pattern) => this.cache.has(this.cacheKey(pattern.id))).length
      : 0;
    return {
      phase: this.phase(total, completed),
      completed,
      total,
      ...coverage(model),
      groups: this.groups(index, account, selected),
      ...(this.error ? { error: this.error } : {}),
      ...(this.reviewedAt ? { reviewedAt: this.reviewedAt } : {}),
    };
  }

  start(model: XrayModel): void {
    if (this.active) return;
    this.error = undefined;
    const index = this.index(model);
    this.fingerprint = sourceFingerprint(this.root);
    const pending = index.patterns.filter((pattern) => !this.cache.has(this.cacheKey(pattern.id)));
    if (pending.length === 0) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.active = this.runPending(pending, signal)
      .catch((error: unknown) => {
        this.error = (error as Error).message;
      })
      .finally(() => {
        this.active = undefined;
        this.controller = undefined;
      });
  }

  private async runPending(patterns: SharedPattern[], signal: AbortSignal): Promise<void> {
    await this.checkLogin(signal);
    const batches: SharedPattern[][] = [];
    const sorted = patterns.toSorted(
      (a, b) => a.left.program.localeCompare(b.left.program) || a.id.localeCompare(b.id),
    );
    for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
      batches.push(sorted.slice(i, i + BATCH_SIZE));
    }
    let next = 0;
    const worker = async () => {
      while (next < batches.length && !signal.aborted) {
        const batch = batches[next++]!;
        const reviews = await this.run(this.root, batch, signal);
        for (const review of reviews) this.cache.set(this.cacheKey(review.id), review);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
      if (sourceFingerprint(this.root) !== this.fingerprint) {
        for (const pattern of patterns) this.cache.delete(this.cacheKey(pattern.id));
        throw new Error("Local source changed during Codex review. Retry qualification.");
      }
      this.reviewedAt = new Date().toISOString();
    } catch (error) {
      this.controller?.abort();
      throw error;
    }
  }

  stop(): void {
    this.controller?.abort();
  }
}
