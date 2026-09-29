import { PublicKey } from "@solana/web3.js";

export { KNOWN_ADDRESSES, SYSTEM_PROGRAM, SYSVAR_OWNER, UPGRADEABLE_LOADER } from "./names.js";

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
