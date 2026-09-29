import { EventEmitter } from "node:events";
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { buildModel, referencedAddresses } from "./analyze.js";
import { CodecRegistry } from "./codec.js";
import { diffAccount, diffStates, type AccountDiff, type StateDiff } from "./diff.js";
import {
  fetchMany,
  fetchRecentTransactions,
  fetchState,
  fetchTransaction,
  toRawAccount,
} from "./rpc.js";
import {
  LIVE,
  listSnapshots,
  loadSnapshot,
  saveSnapshot,
  SNAPSHOT_FORMAT,
  type Snapshot,
  type SnapshotSummary,
} from "./snapshot.js";
import {
  decodeTransaction,
  type DecodedTransaction,
  type RawTransaction,
  type TimelineEntry,
} from "./tx.js";
import type { RawAccount, RawState, XrayModel } from "./types.js";
import type { Workspace } from "./workspace.js";

export interface SessionOptions {
  workspace: Workspace;
  rpcUrl: string;
  /** Defaults to the RPC URL with port + 1 (the solana-test-validator convention). */
  wsUrl?: string;
  /** How many recent transactions to load on each full scan. */
  txLimit: number;
  commitment?: Commitment;
}

/** A change to one account observed through a websocket notification. */
export interface ObservedChange {
  slot: number;
  at: string;
  diff: AccountDiff;
}

export interface TimelineItem extends TimelineEntry {
  /**
   * Account changes observed live in the same slot for accounts this transaction
   * could write. `sharedSlot` is set when other transactions in that slot also
   * wrote the account, so the change cannot be attributed to this one alone.
   */
  accountDiffs: (AccountDiff & { sharedSlot: boolean })[];
}

export type SessionEvent =
  | { type: "model"; model: XrayModel }
  | { type: "account"; change: ObservedChange }
  | { type: "transaction"; item: TimelineItem }
  | { type: "status"; watching: boolean; error?: string };

const HISTORY_LIMIT = 50;
const REBUILD_DELAY_MS = 250;
const TX_RETRIES = 6;

export function defaultWsUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.port) url.port = String(Number(url.port) + 1);
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live view of a workspace's programs on a cluster: state, timeline, watch and snapshots. */
export class Session extends EventEmitter<{ event: [SessionEvent] }> {
  readonly codecs: CodecRegistry;
  readonly connection: Connection;
  private readonly options: SessionOptions;
  private state: RawState = { slot: 0, fetchedAt: "", accounts: [], referenced: [], missing: [] };
  private readonly txs = new Map<string, DecodedTransaction & { raw: RawTransaction }>();
  private readonly history = new Map<string, ObservedChange[]>();
  private cachedModel: XrayModel | undefined;
  private subscriptions: { account: number; logs: number }[] = [];
  private rebuildTimer: NodeJS.Timeout | undefined;
  private pending: { account: RawAccount; programId: string; slot: number }[] | undefined;
  private fetchingReferences = false;

  constructor(options: SessionOptions) {
    super();
    this.options = options;
    this.codecs = new CodecRegistry(options.workspace.programs);
    this.connection = new Connection(options.rpcUrl, {
      commitment: options.commitment ?? "confirmed",
      wsEndpoint: options.wsUrl ?? defaultWsUrl(options.rpcUrl),
    });
  }

  get root(): string {
    return this.options.workspace.root;
  }

  /** Re-fetches all state and recent transactions from the cluster. */
  async refresh(): Promise<XrayModel> {
    const ids = this.codecs.ids();
    // Notifications that land while fetching are replayed onto the new state.
    this.pending = [];
    try {
      const [state, txs] = await Promise.all([
        fetchState(this.connection, this.codecs),
        fetchRecentTransactions(this.connection, ids, this.options.txLimit),
      ]);
      this.state = state;
      for (const update of this.pending.filter((u) => u.slot > state.slot)) {
        this.applyAccount(update.account, update.programId);
      }
      for (const raw of txs) this.addTransaction(raw);
    } finally {
      this.pending = undefined;
    }
    return this.rebuild();
  }

  /** Replaces live state with a saved snapshot (offline inspection). */
  load(snapshot: Snapshot): XrayModel {
    this.state = snapshot.state;
    this.txs.clear();
    for (const raw of snapshot.transactions) this.addTransaction(raw);
    return this.rebuild();
  }

  get watching(): boolean {
    return this.subscriptions.length > 0;
  }

  model(): XrayModel {
    return this.cachedModel ?? this.rebuild();
  }

  rawState(): RawState {
    return this.state;
  }

  timeline(): TimelineItem[] {
    const items = [...this.txs.values()].map((tx) => this.withDiffs(tx.entry));
    return items.toSorted((a, b) => b.slot - a.slot);
  }

  accountHistory(address: string): ObservedChange[] {
    return this.history.get(address) ?? [];
  }

  private addTransaction(raw: RawTransaction): DecodedTransaction {
    const decoded = { ...decodeTransaction(raw, this.codecs), raw };
    this.txs.set(raw.signature, decoded);
    return decoded;
  }

  private rebuild(): XrayModel {
    const bindings = [...this.txs.values()].flatMap((tx) => tx.bindings);
    this.cachedModel = buildModel(this.state, this.codecs, bindings);
    this.emit("event", { type: "model", model: this.cachedModel });
    return this.cachedModel;
  }

  private withDiffs(entry: TimelineEntry): TimelineItem {
    const accountDiffs: TimelineItem["accountDiffs"] = [];
    for (const address of entry.writable) {
      for (const change of this.history.get(address) ?? []) {
        if (change.slot !== entry.slot) continue;
        const writers = [...this.txs.values()].filter(
          (tx) => tx.entry.slot === entry.slot && tx.entry.writable.includes(address),
        );
        accountDiffs.push({ ...change.diff, sharedSlot: writers.length > 1 });
      }
    }
    return { ...entry, accountDiffs };
  }

  /** Subscribes to account and log notifications for every loaded program. */
  startWatch(): void {
    if (this.subscriptions.length > 0) return;
    for (const id of this.codecs.ids()) {
      const key = new PublicKey(id);
      this.subscriptions.push({
        account: this.connection.onProgramAccountChange(
          key,
          ({ accountId, accountInfo }, { slot }) =>
            this.onAccount(toRawAccount(accountId.toBase58(), accountInfo), id, slot),
        ),
        logs: this.connection.onLogs(key, ({ signature }) => void this.onLogs(signature)),
      });
    }
    this.emit("event", { type: "status", watching: true });
  }

  async stopWatch(): Promise<void> {
    const subs = this.subscriptions;
    this.subscriptions = [];
    clearTimeout(this.rebuildTimer);
    await Promise.all(
      subs.flatMap(({ account, logs }) => [
        this.connection.removeProgramAccountChangeListener(account),
        this.connection.removeOnLogsListener(logs),
      ]),
    );
    this.emit("event", { type: "status", watching: false });
  }

  /** Applies a notification to the cached state and returns what changed. */
  private applyAccount(next: RawAccount, programId: string): AccountDiff | undefined {
    const accounts = this.state.accounts;
    const index = accounts.findIndex((a) => a.address === next.address);
    // A closed account is reassigned away from the program; treat it as removed.
    const after = next.owner === programId ? next : undefined;
    const diff = diffAccount(accounts[index], after, this.codecs);
    if (index < 0) {
      if (after) accounts.push(after);
    } else if (after) accounts[index] = after;
    else accounts.splice(index, 1);
    return diff;
  }

  private onAccount(next: RawAccount, programId: string, slot: number): void {
    this.pending?.push({ account: next, programId, slot });
    const diff = this.applyAccount(next, programId);
    this.state.slot = Math.max(this.state.slot, slot);
    if (!diff) return;
    const change: ObservedChange = { slot, at: new Date().toISOString(), diff };
    const list = [change, ...(this.history.get(next.address) ?? [])].slice(0, HISTORY_LIMIT);
    this.history.set(next.address, list);
    this.emit("event", { type: "account", change });
    this.scheduleRebuild();
  }

  private async onLogs(signature: string): Promise<void> {
    if (this.txs.has(signature)) return;
    for (let attempt = 0; attempt < TX_RETRIES; attempt++) {
      try {
        const raw = await fetchTransaction(this.connection, signature);
        if (raw) {
          const decoded = this.addTransaction(raw);
          this.emit("event", { type: "transaction", item: this.withDiffs(decoded.entry) });
          this.scheduleRebuild();
          return;
        }
      } catch (error) {
        this.reportError(`getTransaction ${signature}`, error);
      }
      await sleep(250 * (attempt + 1));
    }
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => void this.rebuildWithReferences(), REBUILD_DELAY_MS);
  }

  private reportError(context: string, error: unknown): void {
    const message = `${context}: ${(error as Error).message}`;
    this.emit("event", { type: "status", watching: this.watching, error: message });
  }

  /** Fetches newly referenced accounts (e.g. a new owner wallet) before rebuilding. */
  private async rebuildWithReferences(): Promise<void> {
    if (this.fetchingReferences) return this.scheduleRebuild();
    this.fetchingReferences = true;
    try {
      const known = new Set([
        ...this.state.referenced.map((a) => a.address),
        ...this.state.missing,
      ]);
      const wanted = referencedAddresses(this.state.accounts, this.codecs).filter(
        (a) => !known.has(a),
      );
      const { found, missing } = await fetchMany(this.connection, wanted);
      this.state.referenced.push(...found);
      this.state.missing.push(...missing);
    } catch (error) {
      this.reportError("refresh references", error);
    } finally {
      this.fetchingReferences = false;
    }
    try {
      this.rebuild();
    } catch (error) {
      this.reportError("rebuild model", error);
    }
  }

  snapshots(): SnapshotSummary[] {
    return listSnapshots(this.root);
  }

  saveSnapshot(name: string): SnapshotSummary {
    const snapshot: Snapshot = {
      format: SNAPSHOT_FORMAT,
      name,
      createdAt: new Date().toISOString(),
      rpcUrl: this.options.rpcUrl,
      programs: this.codecs.all().map((c) => ({ id: c.id, name: c.name })),
      state: this.state,
      transactions: [...this.txs.values()].map((tx) => tx.raw),
    };
    saveSnapshot(this.root, snapshot);
    return {
      name,
      createdAt: snapshot.createdAt,
      slot: this.state.slot,
      accounts: this.state.accounts.length + this.state.referenced.length,
      transactions: snapshot.transactions.length,
    };
  }

  /** Diffs two snapshots by name; `live` stands for the current state. */
  diff(from: string, to: string): StateDiff {
    const stateOf = (name: string) =>
      name === LIVE ? this.state : loadSnapshot(this.root, name).state;
    return diffStates(stateOf(from), stateOf(to), this.codecs);
  }
}
