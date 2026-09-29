import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot, loadWorkspace, Session, type Workspace } from "@anchorx-ray/core";
import { parseCli, USAGE, type CliOptions, type Command } from "./args.js";
import { formatDiff, formatSnapshots, formatSummary, formatTimeline } from "./format.js";
import { openBrowser } from "./open.js";
import { startServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface Context {
  session: Session;
  options: CliOptions;
  workspace: Workspace;
  rpcUrl: string;
}

function version(): string {
  const file = path.join(here, "..", "package.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function warn(text: string): void {
  process.stderr.write(`anchorx-ray: ${text}\n`);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function loadFromSnapshot(session: Session, name: string): void {
  const snapshot = loadSnapshot(session.root, name);
  const known = new Set(session.codecs.ids());
  for (const program of snapshot.programs.filter((p) => !known.has(p.id))) {
    warn(
      `snapshot program ${program.name} (${program.id}) has no IDL loaded; its accounts stay undecoded`,
    );
  }
  session.load(snapshot);
}

/** Loads state from the cluster, or from a snapshot when `--snapshot` is given. */
async function load({ session, options, rpcUrl }: Context): Promise<void> {
  if (options.snapshot) return loadFromSnapshot(session, options.snapshot);
  try {
    await session.refresh();
  } catch (error) {
    const hint = "Is the validator running? Use --rpc or --cluster to point elsewhere.";
    throw new Error(`Cannot load state from ${rpcUrl}: ${(error as Error).message}\n${hint}`, {
      cause: error,
    });
  }
}

async function listen(ctx: Context) {
  const { session, options, workspace, rpcUrl } = ctx;
  const status = {
    rpcUrl,
    cluster: workspace.cluster,
    root: workspace.root,
    warnings: workspace.warnings,
  };
  try {
    return await startServer({
      session,
      status: options.snapshot ? { ...status, snapshot: options.snapshot } : status,
      webDir: path.join(here, "web"),
      port: options.port,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    throw new Error(`Port ${options.port} is already in use; pick another with --port.`, {
      cause: error,
    });
  }
}

async function runUi(ctx: Context): Promise<void> {
  const { session, options } = ctx;
  await load(ctx);
  const server = await listen(ctx);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://127.0.0.1:${port}/`;
  print(formatSummary(session.model()));
  if (options.watch && !options.snapshot) session.startWatch();
  const watching = session.watching ? " (watching for changes)" : "";
  print(`\nanchorx-ray UI: ${url}${watching}\nPress Ctrl+C to stop.`);
  if (options.open) openBrowser(url);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      void session.stopWatch().finally(() => server.close(() => resolve()));
    });
  });
}

async function runScan(ctx: Context): Promise<void> {
  await load(ctx);
  const output = `${json(ctx.session.model())}\n`;
  if (!ctx.options.out) {
    process.stdout.write(output);
    return;
  }
  fs.writeFileSync(ctx.options.out, output);
  print(`${formatSummary(ctx.session.model())}\nWrote ${ctx.options.out}`);
}

async function runDiff(ctx: Context): Promise<void> {
  const [from = "", to = "live"] = ctx.options.positionals;
  if (from === "live" || to === "live") await load(ctx);
  const diff = ctx.session.diff(from, to);
  print(ctx.options.json ? json(diff) : formatDiff(diff));
}

async function runSnapshot(ctx: Context): Promise<void> {
  await load(ctx);
  const saved = ctx.session.saveSnapshot(ctx.options.positionals[0] ?? "");
  const counts = `${saved.accounts} accounts, ${saved.transactions} txs`;
  print(`Saved snapshot "${saved.name}" at slot ${saved.slot} (${counts})`);
}

async function runTimeline(ctx: Context): Promise<void> {
  await load(ctx);
  const timeline = ctx.session.timeline();
  print(ctx.options.json ? json(timeline) : formatTimeline(timeline));
}

async function runSnapshots(ctx: Context): Promise<void> {
  const list = ctx.session.snapshots();
  print(ctx.options.json ? json(list) : formatSnapshots(list));
}

const COMMANDS: Record<Command, (ctx: Context) => Promise<void>> = {
  ui: runUi,
  scan: runScan,
  diff: runDiff,
  snapshot: runSnapshot,
  snapshots: runSnapshots,
  timeline: runTimeline,
};

async function run(options: CliOptions): Promise<void> {
  const workspace = loadWorkspace({
    root: options.workspace,
    idlPaths: options.idl,
    ...(options.cluster ? { cluster: options.cluster } : {}),
  });
  for (const message of workspace.warnings) warn(message);
  const rpcUrl = options.rpc ?? workspace.rpcUrl;
  const session = new Session({
    workspace,
    rpcUrl,
    txLimit: options.txLimit,
    ...(options.ws ? { wsUrl: options.ws } : {}),
  });
  await COMMANDS[options.command]({ session, options, workspace, rpcUrl });
}

/** CLI entry point; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    warn((error as Error).message);
    return 2;
  }
  if (parsed.kind !== "run") {
    print(parsed.kind === "help" ? USAGE : version());
    return 0;
  }
  try {
    await run(parsed.options);
    return 0;
  } catch (error) {
    warn((error as Error).message);
    return 1;
  }
}
