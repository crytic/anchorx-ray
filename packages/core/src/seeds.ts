import type { Idl, IdlType } from "@anchor-lang/core";
import { BN } from "./anchor.js";
import { PublicKey } from "@solana/web3.js";

const INT_WIDTH: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  u256: 32,
  i256: 32,
};

/** A candidate seed value: the bytes fed to the hash plus how to show it. */
export interface SeedBytes {
  bytes: Buffer;
  display: string;
  pubkey?: string;
}

function toBn(value: unknown): BN | undefined {
  if (BN.isBN(value)) return value as BN;
  if (typeof value === "number") return Number.isInteger(value) ? new BN(value) : undefined;
  if (typeof value === "bigint") return new BN(value.toString());
  if (typeof value === "string" && /^-?\d+$/.test(value)) return new BN(value);
  return undefined;
}

/** Whether `bn` is representable in `bits` bits, signed or unsigned. */
function fits(bn: BN, bits: number, signed: boolean): boolean {
  if (!signed) return !bn.isNeg() && bn.bitLength() <= bits;
  // Two's complement range: -2^(bits-1) .. 2^(bits-1) - 1.
  const magnitude = bn.isNeg() ? bn.neg().subn(1) : bn;
  return magnitude.bitLength() < bits;
}

function intBytes(value: unknown, type: string, width: number): SeedBytes | undefined {
  const bn = toBn(value);
  const signed = type.startsWith("i");
  // Guessed values can come from any instruction; skip ones that cannot be this type.
  if (!bn || !fits(bn, width * 8, signed)) return undefined;
  const encoded = signed ? bn.toTwos(width * 8) : bn;
  return { bytes: encoded.toArrayLike(Buffer, "le", width), display: bn.toString(10) };
}

function keyBytes(value: PublicKey | string): SeedBytes | undefined {
  try {
    const key = typeof value === "string" ? new PublicKey(value) : value;
    return { bytes: key.toBuffer(), display: key.toBase58(), pubkey: key.toBase58() };
  } catch {
    return undefined;
  }
}

function plainBytes(value: unknown): SeedBytes | undefined {
  if (typeof value === "string") return { bytes: Buffer.from(value, "utf8"), display: value };
  if (typeof value === "boolean") {
    return { bytes: Buffer.from([value ? 1 : 0]), display: String(value) };
  }
  const isByteList = Array.isArray(value) && value.every((v) => typeof v === "number");
  if (!(value instanceof Uint8Array) && !isByteList) return undefined;
  const bytes = Buffer.from(value as Uint8Array | number[]);
  return { bytes, display: `0x${bytes.toString("hex")}` };
}

/**
 * Serializes a decoded value the way Anchor programs conventionally turn it
 * into seed bytes: integers little-endian at their declared width, keys as 32
 * bytes, strings as UTF-8, byte arrays verbatim.
 */
export function seedBytesFor(value: unknown, type: IdlType | undefined): SeedBytes | undefined {
  if (value instanceof PublicKey) return keyBytes(value);
  if (type === "pubkey") return typeof value === "string" ? keyBytes(value) : undefined;
  const width = typeof type === "string" ? INT_WIDTH[type] : undefined;
  if (width !== undefined) return intBytes(value, type as string, width);
  return plainBytes(value);
}

/** Renders constant seed bytes as text when printable, hex otherwise. */
export function displayConst(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  const printable = /^[\x20-\x7e]+$/.test(text) && Buffer.from(text, "utf8").equals(bytes);
  if (printable) return `"${text}"`;
  if (bytes.length === 32) return new PublicKey(bytes).toBase58();
  return `0x${bytes.toString("hex")}`;
}

/** Walks a dotted path through a decoded object. */
export function getPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function fieldsOf(idl: Idl, typeName: string) {
  const def = idl.types?.find((t) => t.name === typeName);
  if (def?.type.kind !== "struct") return undefined;
  const fields = def.type.fields;
  if (!fields || fields.length === 0 || typeof fields[0] !== "object" || !("name" in fields[0])) {
    return undefined;
  }
  return fields as { name: string; type: IdlType }[];
}

/** Resolves the IDL type at `segments` inside struct type `typeName`. */
export function typeAtPath(idl: Idl, typeName: string, segments: string[]): IdlType | undefined {
  let current: IdlType = { defined: { name: typeName } };
  for (const segment of segments) {
    if (typeof current !== "object" || !("defined" in current)) return undefined;
    const field: { name: string; type: IdlType } | undefined = fieldsOf(
      idl,
      current.defined.name,
    )?.find((f) => f.name === segment);
    if (!field) return undefined;
    current = field.type;
  }
  return current;
}

/** Resolves the IDL type of instruction argument path `path` (e.g. `params.amount`). */
export function argTypeAtPath(idl: Idl, instruction: string, path: string): IdlType | undefined {
  const [head, ...rest] = path.split(".");
  const arg = idl.instructions
    .find((ix) => ix.name === instruction)
    ?.args.find((a) => a.name === head);
  if (!arg) return undefined;
  if (rest.length === 0) return arg.type;
  if (typeof arg.type !== "object" || !("defined" in arg.type)) return undefined;
  return typeAtPath(idl, arg.type.defined.name, rest);
}
