import { useState } from "react";
import type { Json } from "./api.js";
import { looksLikeAddress } from "./format.js";
import { Address } from "./common.js";

function stringLeaf(value: string) {
  if (looksLikeAddress(value)) return <Address address={value} />;
  if (/^-?\d+$/.test(value)) return <span className="v-num">{value}</span>;
  return <span className="v-str">{JSON.stringify(value)}</span>;
}

function Leaf({ value }: { value: Json }) {
  if (typeof value === "string") return stringLeaf(value);
  if (typeof value === "number") return <span className="v-num">{value}</span>;
  const variant = unitVariant(value);
  if (variant) return <span className="v-bool">{variant}</span>;
  if (value === null || typeof value === "boolean")
    return <span className={value === null ? "v-null" : "v-bool"}>{String(value)}</span>;
  return <span className="v-str">{JSON.stringify(value)}</span>;
}

const isEmptyObject = (value: Json | undefined) =>
  typeof value === "object" && value !== null && Object.keys(value).length === 0;

/** Anchor decodes a fieldless enum variant as `{ Variant: {} }`. */
function unitVariant(value: Json): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const [key] = keys;
  return keys.length === 1 && key !== undefined && isEmptyObject(value[key]) ? key : undefined;
}

function isBranch(value: Json): value is Json[] | { [key: string]: Json } {
  return typeof value === "object" && value !== null && unitVariant(value) === undefined;
}

function summary(value: Json[] | { [key: string]: Json }): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  const keys = Object.keys(value);
  // Anchor enums decode as `{ variant: {...} }`.
  return keys.length === 1 ? `${keys[0]}` : `{${keys.length}}`;
}

function Node({ name, value, depth }: { name: string; value: Json; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const indent = { paddingLeft: depth * 14 };
  if (!isBranch(value)) {
    return (
      <div className="tree-row" style={indent}>
        <span style={{ width: 12 }} />
        <span className="tree-key">{name}:</span>
        <Leaf value={value} />
      </div>
    );
  }
  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  return (
    <>
      <div className="tree-row" style={indent}>
        <button className="tree-toggle" type="button" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <span className="tree-key">{name}:</span>
        <span className="faint">{summary(value)}</span>
      </div>
      {open && entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} />)}
    </>
  );
}

/** Collapsible view of decoded data; addresses link to their accounts. */
export function JsonTree({ value }: { value: Json }) {
  if (!isBranch(value)) return <Leaf value={value} />;
  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  if (entries.length === 0) return <span className="faint">(empty)</span>;
  return (
    <div className="tree">
      {entries.map(([k, v]) => (
        <Node key={k} name={k} value={v} depth={0} />
      ))}
    </div>
  );
}
