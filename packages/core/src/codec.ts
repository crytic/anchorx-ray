import {
  BorshAccountsCoder,
  BorshEventCoder,
  BorshInstructionCoder,
  LangErrorCode,
  LangErrorMessage,
  type Idl,
  type IdlInstructionAccountItem,
} from "@anchor-lang/core";
import { collectPubkeys, toJson, type PubkeyRef } from "./json.js";
import type { Json } from "./types.js";
import type { LoadedProgram } from "./workspace.js";

/** `EVENT_IX_TAG_LE` from anchor-lang: prefix of the self-CPI that carries an `emit_cpi!` event. */
export const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

export interface DecodedAccount {
  typeName: string;
  /** Raw coder output (BN, PublicKey, ...), used for seed recovery. */
  raw: Record<string, unknown>;
  json: Json;
  pubkeys: PubkeyRef[];
}

export interface DecodedValue {
  name: string;
  raw: Record<string, unknown>;
  json: Json;
}

export interface FlatIxAccount {
  /** Dotted path for accounts nested in composite structs. */
  name: string;
  writable: boolean;
  signer: boolean;
  optional: boolean;
}

const LANG_ERROR_NAMES = new Map<number, string>(
  Object.entries(LangErrorCode).map(([name, code]) => [code as number, name]),
);

function flatten(items: IdlInstructionAccountItem[], prefix: string): FlatIxAccount[] {
  const out: FlatIxAccount[] = [];
  for (const item of items) {
    const name = prefix ? `${prefix}.${item.name}` : item.name;
    if ("accounts" in item) {
      out.push(...flatten(item.accounts, name));
    } else {
      out.push({
        name,
        writable: item.writable ?? false,
        signer: item.signer ?? false,
        optional: item.optional ?? false,
      });
    }
  }
  return out;
}

/** Discriminator-based decoding of accounts, instructions, events and errors for one program. */
export class ProgramCodec {
  readonly id: string;
  readonly name: string;
  readonly idl: Idl;
  private readonly accountCoder: BorshAccountsCoder;
  private readonly ixCoder: BorshInstructionCoder;
  private readonly eventCoder: BorshEventCoder;
  private readonly accountDiscs: { name: string; disc: Buffer }[];
  private readonly ixAccounts = new Map<string, FlatIxAccount[]>();

  constructor(program: LoadedProgram) {
    this.id = program.id;
    this.name = program.name;
    this.idl = program.idl;
    this.accountCoder = new BorshAccountsCoder(program.idl);
    this.ixCoder = new BorshInstructionCoder(program.idl);
    this.eventCoder = new BorshEventCoder(program.idl);
    // Longest discriminator first so custom short discriminators never shadow longer ones.
    this.accountDiscs = (program.idl.accounts ?? [])
      .map((a) => ({ name: a.name, disc: Buffer.from(a.discriminator) }))
      .toSorted((a, b) => b.disc.length - a.disc.length);
    for (const ix of program.idl.instructions)
      this.ixAccounts.set(ix.name, flatten(ix.accounts, ""));
  }

  identifyAccount(data: Buffer): string | undefined {
    return this.accountDiscs.find(({ disc }) => data.subarray(0, disc.length).equals(disc))?.name;
  }

  /** Returns the decoded account, or an error string when the data does not match the IDL. */
  decodeAccount(data: Buffer): DecodedAccount | { typeName?: string; error: string } {
    const typeName = this.identifyAccount(data);
    if (!typeName) return { error: "discriminator matches no IDL account type" };
    try {
      const raw = this.accountCoder.decode(typeName, data) as Record<string, unknown>;
      return { typeName, raw, json: toJson(raw), pubkeys: collectPubkeys(raw) };
    } catch (error) {
      return { typeName, error: `Borsh decode failed: ${(error as Error).message}` };
    }
  }

  decodeInstruction(data: Buffer): DecodedValue | undefined {
    let decoded: { name: string; data: object } | null;
    try {
      decoded = this.ixCoder.decode(data);
    } catch {
      return undefined;
    }
    if (!decoded) return undefined;
    const raw = decoded.data as Record<string, unknown>;
    return { name: decoded.name, raw, json: toJson(raw) };
  }

  instructionAccounts(name: string): FlatIxAccount[] {
    return this.ixAccounts.get(name) ?? [];
  }

  /** Decodes a `Program data:` log payload (base64) emitted by `emit!`. */
  decodeEventLog(base64: string): DecodedValue | undefined {
    const event = this.eventCoder.decode(base64);
    if (!event) return undefined;
    return {
      name: event.name,
      raw: event.data as Record<string, unknown>,
      json: toJson(event.data),
    };
  }

  /** Decodes the payload of an `emit_cpi!` self-invocation. */
  decodeCpiEvent(ixData: Buffer): DecodedValue | undefined {
    if (!ixData.subarray(0, EVENT_IX_TAG.length).equals(EVENT_IX_TAG)) return undefined;
    return this.decodeEventLog(ixData.subarray(EVENT_IX_TAG.length).toString("base64"));
  }

  /** Resolves a custom program error code to its IDL or Anchor framework name. */
  errorName(code: number): { name: string; msg?: string } | undefined {
    const custom = this.idl.errors?.find((e) => e.code === code);
    if (custom)
      return custom.msg === undefined
        ? { name: custom.name }
        : { name: custom.name, msg: custom.msg };
    const lang = LANG_ERROR_NAMES.get(code);
    if (!lang) return undefined;
    const msg = LangErrorMessage.get(code);
    return msg === undefined ? { name: lang } : { name: lang, msg };
  }
}

export class CodecRegistry {
  private readonly byId = new Map<string, ProgramCodec>();

  constructor(programs: LoadedProgram[]) {
    for (const program of programs) this.byId.set(program.id, new ProgramCodec(program));
  }

  get(programId: string): ProgramCodec | undefined {
    return this.byId.get(programId);
  }

  all(): ProgramCodec[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}
