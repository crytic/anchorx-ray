import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { AccountNode, ProgramSummary } from "./api.js";
import type { Stack } from "./graph.js";
import { bytes, short, sol } from "./format.js";
import { KIND_COLOR } from "./common.js";

export type AccountData = { account: AccountNode; dim: boolean; flash: number };
export type ProgramData = {
  program: ProgramSummary;
  account: AccountNode | undefined;
  count: number;
  dim: boolean;
};

export type AccountFlowNode = Node<AccountData, "account">;
export type StackFlowNode = Node<{ stack: Stack }, "stack">;
export type ProgramFlowNode = Node<ProgramData, "program">;

const KIND_TAG: Record<AccountNode["kind"], string> = {
  program: "program",
  pda: "pda",
  keypair: "keypair",
  wallet: "wallet",
  "external-program": "program",
  external: "external",
  sysvar: "sysvar",
  missing: "missing",
};

function FindingChips({ account }: { account: AccountNode }) {
  const warnings = account.findings.filter((f) => f.severity === "warning").length;
  const infos = account.findings.length - warnings;
  return (
    <>
      {warnings > 0 && <span className="chip warn">⚠ {warnings}</span>}
      {infos > 0 && <span className="chip info">ⓘ {infos}</span>}
    </>
  );
}

function PdaChip({ account }: { account: AccountNode }) {
  if (!account.pda) return null;
  if (account.pda.status === "unresolved") return <span className="chip">seeds ?</span>;
  const canonical = account.pda.bump === account.pda.canonicalBump;
  return <span className={`chip ${canonical ? "ok" : "bad"}`}>seeds ✓</span>;
}

export function AccountNodeView({ data, selected }: NodeProps<AccountFlowNode>) {
  const { account, dim, flash } = data;
  const classes = [
    "acct",
    selected && "selected",
    dim && "dim",
    account.kind === "missing" && "missing",
  ];
  return (
    <div
      // Re-keying restarts the flash animation on every observed change.
      key={flash}
      className={[...classes, flash > 0 && "flash"].filter(Boolean).join(" ")}
      style={{ ["--kind" as string]: KIND_COLOR[account.kind] }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="acct-head">
        <span className="acct-title">{account.label}</span>
        <span className="acct-kind">{KIND_TAG[account.kind]}</span>
      </div>
      <div className="acct-addr mono">{short(account.address, 6)}</div>
      <div className="acct-foot">
        <span className="acct-size">
          {account.kind === "missing"
            ? "referenced, not on chain"
            : `${sol(account.lamports)}${account.dataLen > 0 ? ` · ${bytes(account.dataLen)}` : ""}`}
        </span>
        <PdaChip account={account} />
        <FindingChips account={account} />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function authorityText(account: AccountNode | undefined): string {
  if (!account) return "";
  if (account.upgradeAuthority === null) return "immutable";
  if (account.upgradeAuthority) return `upgrade authority ${short(account.upgradeAuthority)}`;
  return "";
}

const noun = (n: number) => `${n.toLocaleString()} account${n === 1 ? "" : "s"}`;

function accountCount(program: ProgramSummary, shown: number): string {
  const total = program.inventory.reduce((n, r) => n + r.total, 0);
  return total > shown ? `${shown.toLocaleString()} of ${noun(total)}` : noun(shown);
}

export function ProgramGroupView({ data, selected }: NodeProps<ProgramFlowNode>) {
  const { program, account, count, dim } = data;
  return (
    <div className={`group${selected ? " selected" : ""}`} style={{ opacity: dim ? 0.5 : 1 }}>
      <Handle type="target" position={Position.Left} />
      <div className="group-head">
        <div style={{ minWidth: 0 }}>
          <div className="group-name">{program.name}</div>
          <div className="group-meta mono">{short(program.id, 6)}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }} className="group-meta">
          <div>
            {program.deployed ? (
              accountCount(program, count)
            ) : (
              <span className="chip bad">not deployed</span>
            )}
          </div>
          <div>{authorityText(account)}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** Accounts folded because their type has too many to draw; click to expand. */
export function StackNodeView({ data }: NodeProps<StackFlowNode>) {
  const { stack } = data;
  return (
    <div
      className="acct stack"
      style={{ ["--kind" as string]: KIND_COLOR[stack.kind] }}
      title="Click to show them all"
    >
      <Handle type="target" position={Position.Left} />
      <div className="acct-head">
        <span className="acct-title">
          {stack.label} ×{stack.count.toLocaleString()}
        </span>
        <span className="acct-kind">more</span>
      </div>
      <div className="acct-addr">folded · click to expand</div>
      <div className="acct-foot">
        <span className="acct-size" />
        {stack.warnings > 0 && <span className="chip warn">⚠ {stack.warnings}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = {
  account: AccountNodeView,
  program: ProgramGroupView,
  stack: StackNodeView,
};
