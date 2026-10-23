import type { AccountKind, Json } from "./api.js";

export const short = (address: string, n = 4) =>
  address.length <= n * 2 + 1 ? address : `${address.slice(0, n)}…${address.slice(-n)}`;

export function sol(lamports: number): string {
  const value = lamports / 1e9;
  if (value === 0) return "0 SOL";
  if (Math.abs(value) < 0.0001) return `${lamports.toLocaleString()} lamports`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;
}

export function signedSol(delta: number): string {
  return `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${sol(Math.abs(delta))}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KiB`;
}

export function when(iso: string | number | null): string {
  if (iso === null) return "—";
  const date = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
  return date.toLocaleTimeString(undefined, { hour12: false });
}

export const KIND_LABEL: Record<AccountKind, string> = {
  program: "Program",
  pda: "PDA",
  keypair: "Keypair account",
  wallet: "Wallet",
  "external-program": "External program",
  external: "External account",
  sysvar: "Sysvar",
  missing: "Not on chain",
};

/** Renders a JSON leaf compactly for tables and diffs. */
export function leaf(value: Json | undefined): string {
  if (value === undefined) return "∅";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeAddress(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}
