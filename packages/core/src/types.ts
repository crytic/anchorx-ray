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
  /**
   * Every account the programs own, with its type, from a discriminator-only
   * scan. `accounts` holds full data for a capped subset of these.
   */
  catalog?: CatalogEntry[];
}

export interface CatalogEntry {
  address: string;
  program: string;
  /** IDL account type from the discriminator; null when none matches. */
  typeName: string | null;
}

export interface InventoryRow {
  program: string;
  typeName: string | null;
  total: number;
  loaded: number;
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
  /** Unresolved only because the seed search hit its budget. */
  incomplete?: boolean;
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

/** One typed Pubkey field containing an address shared with another field. */
export interface SharedAddressOccurrence {
  account: string;
  path: string;
  /** Instructions whose IDL declares a has_one relation for this field. */
  hasOneIn?: string[];
}

export interface SharedAddress {
  value: string;
  occurrences: SharedAddressOccurrence[];
}

/** One field position in an account schema, independent of a concrete account. */
export interface SharedField {
  program: string;
  typeName: string;
  path: string;
}

export interface SharedPatternExample {
  value: string;
  left: SharedAddressOccurrence;
  right: SharedAddressOccurrence;
}

/** Equal Pubkey fields grouped by schema so one code review covers many accounts. */
export interface SharedPattern {
  id: string;
  left: SharedField;
  right: SharedField;
  matchedValues: number;
  examples: SharedPatternExample[];
}

export type QualificationVerdict = "enforced" | "potential_gap" | "independent" | "inconclusive";

export interface QualificationEvidence {
  path: string;
  line: number;
  note: string;
}

export interface QualificationReview {
  id: string;
  verdict: QualificationVerdict;
  summary: string;
  scope: string;
  evidence: QualificationEvidence[];
}

export interface QualificationView {
  phase: "idle" | "running" | "complete" | "failed";
  completed: number;
  total: number;
  loadedAccounts: number;
  catalogAccounts: number;
  groups: { value: string; patterns: (SharedPattern & { review?: QualificationReview })[] }[];
  error?: string;
  reviewedAt?: string;
}

export interface ProgramSummary {
  id: string;
  name: string;
  version: string;
  deployed: boolean;
  accountTypes: string[];
  instructions: string[];
  events: string[];
  /** Accounts on chain vs. loaded, per account type. */
  inventory: { typeName: string | null; total: number; loaded: number }[];
}

export interface XrayModel {
  slot: number;
  fetchedAt: string;
  programs: ProgramSummary[];
  accounts: AccountNode[];
  edges: Edge[];
  /** Equal Pubkey fields among accounts whose data was loaded and decoded. */
  sharedAddresses: SharedAddress[];
}
