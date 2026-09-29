/** JSON-safe value produced from decoded Borsh data. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** On-chain account as fetched from RPC, independent of any IDL. */
export interface RawAccount {
  address: string;
  owner: string;
  lamports: number;
  executable: boolean;
  /** Base64-encoded account data. */
  data: string;
  /**
   * Set when `data` holds only a prefix (ProgramData accounts keep their
   * 45-byte header; the program binary is summarized by length and hash).
   */
  truncated?: { length: number; sha256: string };
}

/** Everything fetched from the cluster in one scan. Pure input to analysis. */
export interface RawState {
  slot: number;
  fetchedAt: string;
  /** Accounts owned by the loaded programs, plus the program accounts themselves. */
  accounts: RawAccount[];
  /** Accounts referenced by the above (fields, seeds, programdata), fetched separately. */
  referenced: RawAccount[];
  /** Referenced addresses that do not exist on chain. */
  missing: string[];
}

export type AccountKind =
  | "program"
  | "pda"
  | "keypair"
  | "wallet"
  | "external-program"
  | "external"
  | "sysvar"
  | "missing";

export type SeedKind = "const" | "arg" | "account";

export interface ResolvedSeed {
  kind: SeedKind;
  /** IDL path for arg/account seeds (e.g. `vault_id`, `vault.owner`). */
  path?: string;
  /** Human-readable value: utf8 text, base58 key, or decimal number. */
  display: string;
  hex: string;
  /** Set when the seed bytes are a public key. */
  pubkey?: string;
}

export interface PdaInfo {
  status: "verified" | "unresolved";
  /** Instruction and account name the matching seed template came from. */
  source?: { instruction: string; account: string };
  /** How the seeds were recovered. */
  method?: "transaction" | "account-data";
  seeds?: ResolvedSeed[];
  bump?: number;
  canonicalBump?: number;
}

export type Severity = "info" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export interface AccountNode {
  address: string;
  kind: AccountKind;
  label: string;
  owner: string;
  lamports: number;
  dataLen: number;
  executable: boolean;
  onCurve: boolean;
  /** Program id whose IDL describes this account. */
  program?: string;
  typeName?: string;
  decoded?: Json;
  decodeError?: string;
  pda?: PdaInfo;
  /** Instruction account names this address was passed as (e.g. `owner`, `depositor`). */
  roles?: string[];
  /** Upgrade authority for upgradeable programs (null = immutable). */
  upgradeAuthority?: string | null;
  findings: Finding[];
}

export type EdgeKind = "owner" | "field" | "seed" | "programdata";

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  label: string;
  /** Instructions whose `has_one`/`relations` constraint checks this field. */
  constrainedBy?: string[];
}

export interface ProgramSummary {
  id: string;
  name: string;
  version: string;
  deployed: boolean;
  accountTypes: string[];
  instructions: string[];
  events: string[];
}

export interface XrayModel {
  slot: number;
  fetchedAt: string;
  programs: ProgramSummary[];
  accounts: AccountNode[];
  edges: Edge[];
}
