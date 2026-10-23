import { parseArgs } from "node:util";

export const COMMANDS = ["ui", "scan", "timeline", "snapshot", "snapshots", "diff"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  positionals: string[];
  workspace: string;
  idl: string[];
  include: string[];
  exclude: string[];
  cluster?: string;
  rpc?: string;
  ws?: string;
  txLimit: number;
  maxAccounts: number;
  port: number;
  peers: { label: string; port: number }[];
  open: boolean;
  watch: boolean;
  snapshot?: string;
  out?: string;
  json: boolean;
}

export type ParsedCli =
  | { kind: "run"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" };

export const USAGE = `Usage: anchorx-ray [command] [options]

Commands:
  ui                     Scan, watch live changes and open the web UI (default)
  scan                   Print the account graph as JSON
  timeline               Print recent decoded transactions
  snapshot <name>        Save the current state as a named snapshot
  snapshots              List saved snapshots
  diff <from> [to]       Diff two snapshots; "live" (default for <to>) is the cluster now

Options:
  -w, --workspace <dir>  Anchor workspace root (default: current directory)
      --idl <file>       IDL file to load; repeatable (default: target/idl/*.json)
      --include <names>  Only inspect these programs (names or ids, comma-separated or repeated)
      --exclude <names>  Skip these programs
      --cluster <name>   localnet | devnet | testnet | mainnet | <url>
                         (default: [provider] cluster in Anchor.toml)
      --rpc <url>        RPC URL; overrides --cluster
      --ws <url>         Websocket URL (default: RPC port + 1)
      --tx-limit <n>     Recent transactions to load (default: 100)
      --max-accounts <n> Program accounts loaded with full data; the rest are listed and
                         can be loaded from the UI (default: 500)
  -p, --port <n>         Web UI port (default: 3000)
      --peer <label:port> Link to another local anchorx-ray UI; repeatable
      --no-open          Do not open a browser
      --no-watch         Do not subscribe to live updates
      --snapshot <name>  ui/scan/timeline: read a saved snapshot instead of the cluster
  -o, --out <file>       scan: write JSON to a file instead of stdout
      --json             timeline/snapshots/diff: print JSON
  -h, --help             Show this help
  -v, --version          Show the version
`;

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  return n;
}

/** `--include a,b --include c` → ["a", "b", "c"]. */
function splitList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePeers(values: string[] | undefined): { label: string; port: number }[] {
  const peers = (values ?? []).map((value) => {
    const separator = value.lastIndexOf(":");
    const label = value.slice(0, separator).trim();
    const port = Number(value.slice(separator + 1));
    if (separator < 1 || !label || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--peer must be <label:port> with port 1-65535, got "${value}"`);
    }
    return { label, port };
  });
  if (new Set(peers.map((peer) => peer.port)).size !== peers.length) {
    throw new Error("--peer ports must be unique");
  }
  return peers;
}

function commandOf(positionals: string[]): { command: Command; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { command: "ui", rest };
  if (!(COMMANDS as readonly string[]).includes(first)) {
    throw new Error(`Unknown command "${first}". Run anchorx-ray --help.`);
  }
  return { command: first as Command, rest };
}

function checkArity(command: Command, rest: string[]): void {
  const arity: Record<Command, [number, number]> = {
    ui: [0, 0],
    scan: [0, 0],
    timeline: [0, 0],
    snapshot: [1, 1],
    snapshots: [0, 0],
    diff: [1, 2],
  };
  const [min, max] = arity[command];
  if (rest.length < min || rest.length > max) {
    throw new Error(
      `"${command}" takes ${min === max ? min : `${min}-${max}`} argument(s). Run anchorx-ray --help.`,
    );
  }
}

/** Parses argv (without the node and script entries). Throws with a usage hint on bad input. */
export function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      workspace: { type: "string", short: "w" },
      idl: { type: "string", multiple: true },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      cluster: { type: "string" },
      rpc: { type: "string" },
      ws: { type: "string" },
      "tx-limit": { type: "string" },
      "max-accounts": { type: "string" },
      port: { type: "string", short: "p" },
      peer: { type: "string", multiple: true },
      open: { type: "boolean", default: true },
      watch: { type: "boolean", default: true },
      snapshot: { type: "string" },
      out: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const { command, rest } = commandOf(positionals);
  checkArity(command, rest);
  const options: CliOptions = {
    command,
    positionals: rest,
    workspace: values.workspace ?? process.cwd(),
    idl: values.idl ?? [],
    include: splitList(values.include),
    exclude: splitList(values.exclude),
    txLimit: positiveInt(values["tx-limit"], "tx-limit", 100),
    maxAccounts: positiveInt(values["max-accounts"], "max-accounts", 500),
    port: positiveInt(values.port, "port", 3000),
    peers: parsePeers(values.peer),
    open: values.open,
    watch: values.watch,
    json: values.json,
  };
  if (options.peers.some((peer) => peer.port === options.port)) {
    throw new Error("--peer port must differ from --port");
  }
  for (const key of ["cluster", "rpc", "ws", "snapshot", "out"] as const) {
    const value = values[key];
    if (value !== undefined) options[key] = value;
  }
  return { kind: "run", options };
}
