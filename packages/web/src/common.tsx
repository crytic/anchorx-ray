import { createContext, useContext, useState, type ReactNode } from "react";
import { KNOWN_ADDRESSES } from "@anchorx-ray/core/names";
import type { AccountKind, AccountNode } from "./api.js";
import { short } from "./format.js";

export const KIND_COLOR: Record<AccountKind, string> = {
  program: "var(--k-program)",
  pda: "var(--k-pda)",
  keypair: "var(--k-keypair)",
  wallet: "var(--k-wallet)",
  "external-program": "var(--k-external)",
  external: "var(--k-external)",
  sysvar: "var(--k-sysvar)",
  missing: "var(--k-missing)",
};

/** Same palette as hex, for SVG attributes (minimap) that cannot use CSS variables. */
export const KIND_HEX: Record<AccountKind, string> = {
  program: "#a78bfa",
  pda: "#fbbf24",
  keypair: "#60a5fa",
  wallet: "#34d399",
  "external-program": "#94a3b8",
  external: "#94a3b8",
  sysvar: "#22d3ee",
  missing: "#f87171",
};

export interface Navigation {
  lookup(address: string): AccountNode | undefined;
  selectAccount(address: string): void;
  selectTransaction(signature: string): void;
}

export const NavContext = createContext<Navigation>({
  lookup: () => undefined,
  selectAccount: () => undefined,
  selectTransaction: () => undefined,
});

export const useNav = () => useContext(NavContext);

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <button className="copy" type="button" title="Copy" onClick={copy}>
      {done ? "✓" : "⧉"}
    </button>
  );
}

const displayName = (address: string, node: AccountNode | undefined) =>
  node?.label ?? KNOWN_ADDRESSES[address];

interface AddressProps {
  address: string;
  full?: boolean;
  /** Show the account label (or well-known program name) next to the key. */
  name?: boolean;
}

/** An address that links to its account when the model knows it. */
export function Address({ address, full = false, name = true }: AddressProps) {
  const nav = useNav();
  const node = nav.lookup(address);
  const text = short(address, full ? address.length : 6);
  const label = name ? displayName(address, node) : undefined;
  const link = (
    <button className="addr-link" type="button" onClick={() => nav.selectAccount(address)}>
      {text}
    </button>
  );
  return (
    <span className="addr" title={address}>
      {node ? link : <span>{text}</span>}
      {label && <span className="addr-name">{label}</span>}
      <CopyButton text={address} />
    </span>
  );
}

export function KindSwatch({ kind }: { kind: AccountKind }) {
  return <span className="swatch" style={{ background: KIND_COLOR[kind] }} />;
}

export function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="block">
      <div style={{ display: "flex", alignItems: "center" }}>
        <h4 className="section-title">{title}</h4>
        {right && <div style={{ marginLeft: "auto" }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}
