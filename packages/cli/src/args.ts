import { parseArgs } from "node:util";

export const COMMANDS = ["ui", "scan", "timeline", "snapshot", "snapshots", "diff"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CliOptions {
  command: Command;
  positionals: string[];
  workspace: string;
  idl: string[];
  cluster?: string;
  rpc?: string;
  ws?: string;
  txLimit: number;
  port: number;
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
      --cluster <name>   localnet | devnet | testnet | mainnet | <url>
                         (default: [provider] cluster in Anchor.toml)
      --rpc <url>        RPC URL; overrides --cluster
      --ws <url>         Websocket URL (default: RPC port + 1)
      --tx-limit <n>     Recent transactions to load (default: 100)
  -p, --port <n>         Web UI port (default: 3000)
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
      cluster: { type: "string" },
      rpc: { type: "string" },
      ws: { type: "string" },
      "tx-limit": { type: "string" },
      port: { type: "string", short: "p" },
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
    txLimit: positiveInt(values["tx-limit"], "tx-limit", 100),
    port: positiveInt(values.port, "port", 3000),
    open: values.open,
    watch: values.watch,
    json: values.json,
  };
  for (const key of ["cluster", "rpc", "ws", "snapshot", "out"] as const) {
    const value = values[key];
    if (value !== undefined) options[key] = value;
  }
  return { kind: "run", options };
}
