import { PublicKey } from "@solana/web3.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";

/** Names for well-known programs and sysvars so the graph shows words, not keys. */
export const KNOWN_ADDRESSES: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System Program",
  [UPGRADEABLE_LOADER]: "BPF Upgradeable Loader",
  BPFLoader2111111111111111111111111111111111: "BPF Loader 2",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token Program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022 Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  SysvarRent111111111111111111111111111111111: "Rent Sysvar",
  SysvarC1ock11111111111111111111111111111111: "Clock Sysvar",
  Sysvar1nstructions1111111111111111111111111: "Instructions Sysvar",
};

export function isOnCurve(address: string): boolean {
  return PublicKey.isOnCurve(new PublicKey(address).toBytes());
}

/** Reads the ProgramData address out of an upgradeable-loader Program account. */
export function programDataAddress(data: Buffer): string | undefined {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) return undefined;
  return new PublicKey(data.subarray(4, 36)).toBase58();
}

/** Reads the upgrade authority out of a ProgramData account (null when immutable). */
export function upgradeAuthority(data: Buffer): string | null | undefined {
  if (data.length < 13 || data.readUInt32LE(0) !== 3) return undefined;
  if (data[12] === 0) return null;
  if (data.length < 45) return undefined;
  return new PublicKey(data.subarray(13, 45)).toBase58();
}
