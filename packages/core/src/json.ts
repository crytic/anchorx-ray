import { BN } from "./anchor.js";
import { PublicKey } from "@solana/web3.js";
import type { Json } from "./types.js";

/** A public key found inside decoded data, with its location. */
export interface PubkeyRef {
  path: string;
  pubkey: string;
}

function objectLeaf(value: unknown): Json | undefined {
  if (BN.isBN(value)) return (value as BN).toString(10);
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return undefined;
}

function leafToJson(value: unknown): Json | undefined {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    default:
      return objectLeaf(value);
  }
}

/**
 * Converts values produced by the Anchor Borsh coder into plain JSON.
 *
 * Integers wider than 32 bits (BN) become decimal strings so no precision is
 * lost; keys become base58; byte buffers become `0x`-prefixed hex.
 */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  const leaf = leafToJson(value);
  if (leaf !== undefined) return leaf;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJson(inner)]));
  }
  return String(value);
}

function isContainer(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  return !BN.isBN(value) && !(value instanceof Uint8Array);
}

/** Lists every PublicKey nested in a decoded value, with a dotted/indexed path. */
export function collectPubkeys(value: unknown, path = ""): PubkeyRef[] {
  if (value instanceof PublicKey) return [{ path, pubkey: value.toBase58() }];
  if (!isContainer(value)) return [];
  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [`${path}[${i}]`, item])
    : Object.entries(value).map(([key, item]) => [path ? `${path}.${key}` : key, item]);
  return children.flatMap(([childPath, item]) => collectPubkeys(item, childPath));
}
