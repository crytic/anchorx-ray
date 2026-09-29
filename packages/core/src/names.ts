// Dependency-free so the web UI can import it without pulling in web3.js.

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
