import {
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";
import type { CodecRegistry, ProgramCodec } from "./codec.js";
import type { InstructionScope } from "./pda.js";
import type { Json } from "./types.js";

export interface RawTxInstruction {
  programIdIndex: number;
  accounts: number[];
  /** Base64 instruction data. */
  data: string;
  /** 1 for top-level instructions, 2+ for CPIs. */
  stackHeight: number;
}

/** Transaction as fetched from RPC, flattened to JSON so it can be stored and replayed. */
export interface RawTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: Json;
  fee: number;
  computeUnits: number | null;
  accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
  /** Top-level and inner instructions in execution order. */
  instructions: RawTxInstruction[];
  logs: string[];
  preBalances: number[];
  postBalances: number[];
}

export interface DecodedInstruction {
  /** Position such as `1` (top-level) or `1.2` (second CPI of the first instruction). */
  index: string;
  depth: number;
  programId: string;
  programName?: string;
  name?: string;
  args?: Json;
  accounts: { name?: string; address: string; signer: boolean; writable: boolean }[];
  /** Set for `emit_cpi!` self-invocations, which carry an event instead of an instruction. */
  event?: { name: string; data: Json };
  /** Hex of undecoded data (first 64 bytes). */
  data?: string;
}

export interface TxEvent {
  program: string;
  name: string;
  data: Json;
  via: "log" | "cpi";
}

export interface TxError {
  message: string;
  instruction?: number;
  program?: string;
  code?: number;
  name?: string;
  msg?: string;
}

export interface BalanceChange {
  address: string;
  before: number;
  after: number;
}

export interface TimelineEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  fee: number;
  computeUnits: number | null;
  success: boolean;
  error?: TxError;
  signers: string[];
  instructions: DecodedInstruction[];
  events: TxEvent[];
  logs: string[];
  balanceChanges: BalanceChange[];
  /** Writable accounts, i.e. those the transaction could have modified. */
  writable: string[];
}

/** An instruction of a known program, with decoded names bound for PDA verification. */
export interface InstructionBinding {
  slot: number;
  programId: string;
  instruction: string;
  scope: InstructionScope;
}

export interface DecodedTransaction {
  entry: TimelineEntry;
  bindings: InstructionBinding[];
}

function systemInstructionName(ix: TransactionInstruction): string | undefined {
  try {
    return SystemInstruction.decodeInstructionType(ix);
  } catch {
    return undefined;
  }
}

/** Tracks the invoke stack in program logs to attribute `Program data:` lines. */
function eventsFromLogs(logs: string[], codecs: CodecRegistry): TxEvent[] {
  const stack: string[] = [];
  const events: TxEvent[] = [];
  for (const line of logs) {
    const invoked = /^Program (\w+) invoke \[\d+\]$/.exec(line)?.[1];
    if (invoked) stack.push(invoked);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else events.push(...eventFromLine(line, stack.at(-1), codecs));
  }
  return events;
}

function eventFromLine(
  line: string,
  program: string | undefined,
  codecs: CodecRegistry,
): TxEvent[] {
  const payload = /^Program data: (.+)$/.exec(line)?.[1];
  const event = payload && program ? codecs.get(program)?.decodeEventLog(payload) : undefined;
  return event && program ? [{ program, name: event.name, data: event.json, via: "log" }] : [];
}

/** The program named by the last `failed` log line: the innermost failing CPI. */
function failingProgram(logs: string[]): string | undefined {
  const failed = logs.findLast((l) => / failed: /.test(l));
  return failed ? /^Program (\w+) failed/.exec(failed)?.[1] : undefined;
}

function customCode(detail: unknown): number | undefined {
  const code = (detail as { Custom?: unknown } | null)?.Custom;
  return typeof code === "number" ? code : undefined;
}

function parseError(raw: RawTransaction, topLevel: DecodedInstruction[], codecs: CodecRegistry) {
  if (raw.err === null) return undefined;
  const error: TxError = { message: JSON.stringify(raw.err) };
  const ixErr = (raw.err as { InstructionError?: [number, unknown] }).InstructionError;
  if (!ixErr) return error;
  const [index, detail] = ixErr;
  error.instruction = index;
  const program = failingProgram(raw.logs) ?? topLevel[index]?.programId;
  if (!program) return error;
  error.program = program;
  const code = customCode(detail);
  if (code === undefined) return error;
  error.code = code;
  return { ...error, ...codecs.get(program)?.errorName(code) };
}

function systemName(data: Buffer, metas: RawTransaction["accountKeys"]): string | undefined {
  return systemInstructionName(
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: metas.map((m) => ({
        pubkey: new PublicKey(m.pubkey),
        isSigner: m.signer,
        isWritable: m.writable,
      })),
      data,
    }),
  );
}

/** Names accounts and args of an instruction of a program with an IDL. */
function decodeWithCodec(
  decoded: DecodedInstruction,
  data: Buffer,
  codec: ProgramCodec,
  slot: number,
): InstructionBinding | undefined {
  decoded.programName = codec.name;
  const cpiEvent = codec.decodeCpiEvent(data);
  if (cpiEvent) {
    decoded.event = { name: cpiEvent.name, data: cpiEvent.json };
    return undefined;
  }
  const value = codec.decodeInstruction(data);
  if (!value) return undefined;
  decoded.name = value.name;
  decoded.args = value.json;
  const names = codec.instructionAccounts(value.name);
  const scope: InstructionScope = { accounts: new Map(), args: value.raw };
  decoded.accounts.forEach((account, i) => {
    const name = names[i]?.name;
    if (name === undefined) return;
    account.name = name;
    scope.accounts.set(name, account.address);
  });
  return { slot, programId: codec.id, instruction: value.name, scope };
}

function decodeOne(
  raw: RawTransaction,
  ix: RawTxInstruction,
  index: string,
  codecs: CodecRegistry,
) {
  const unknown = { pubkey: "unknown", signer: false, writable: false };
  const programId = raw.accountKeys[ix.programIdIndex]?.pubkey ?? "unknown";
  const data = Buffer.from(ix.data, "base64");
  const metas = ix.accounts.map((i) => raw.accountKeys[i] ?? unknown);
  const decoded: DecodedInstruction = {
    index,
    depth: ix.stackHeight - 1,
    programId,
    accounts: metas.map((m) => ({ address: m.pubkey, signer: m.signer, writable: m.writable })),
  };
  const codec = codecs.get(programId);
  const binding = codec ? decodeWithCodec(decoded, data, codec, raw.slot) : undefined;
  if (programId === SystemProgram.programId.toBase58()) {
    decoded.programName = "system";
    const name = systemName(data, metas);
    if (name) decoded.name = name;
  }
  if (!decoded.name && !decoded.event) decoded.data = data.subarray(0, 64).toString("hex");
  return { decoded, binding };
}

/** Numbers instructions `1`, `1.1`, `1.2`, `2`, ... in execution order. */
function instructionIndexes(instructions: RawTxInstruction[]): string[] {
  let top = 0;
  let inner = 0;
  return instructions.map((ix) => {
    if (ix.stackHeight > 1) return `${top}.${++inner}`;
    inner = 0;
    return `${++top}`;
  });
}

function balanceChanges(raw: RawTransaction): BalanceChange[] {
  return raw.accountKeys.flatMap((key, i) => {
    const before = raw.preBalances[i] ?? 0;
    const after = raw.postBalances[i] ?? 0;
    return before === after ? [] : [{ address: key.pubkey, before, after }];
  });
}

/** Decodes instructions, CPI events, log events and errors of a transaction. */
export function decodeTransaction(raw: RawTransaction, codecs: CodecRegistry): DecodedTransaction {
  const indexes = instructionIndexes(raw.instructions);
  const results = raw.instructions.map((ix, i) => decodeOne(raw, ix, indexes[i] ?? "?", codecs));
  const instructions = results.map((r) => r.decoded);
  const bindings = results.flatMap((r) => (r.binding ? [r.binding] : []));
  const cpiEvents = instructions.flatMap((i): TxEvent[] =>
    i.event ? [{ program: i.programId, ...i.event, via: "cpi" }] : [],
  );
  const error = parseError(
    raw,
    instructions.filter((i) => i.depth === 0),
    codecs,
  );
  const entry: TimelineEntry = {
    signature: raw.signature,
    slot: raw.slot,
    blockTime: raw.blockTime,
    fee: raw.fee,
    computeUnits: raw.computeUnits,
    success: raw.err === null,
    signers: raw.accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
    instructions,
    events: [...cpiEvents, ...eventsFromLogs(raw.logs, codecs)],
    logs: raw.logs,
    balanceChanges: balanceChanges(raw),
    writable: raw.accountKeys.filter((k) => k.writable).map((k) => k.pubkey),
  };
  if (error) entry.error = error;
  return { entry, bindings };
}
