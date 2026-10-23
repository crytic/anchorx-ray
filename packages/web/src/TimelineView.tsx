import { useMemo, useState } from "react";
import type { DecodedInstruction, TimelineItem } from "./api.js";
import { short, signedSol, when } from "./format.js";
import { AccountChange } from "./AccountChange.js";
import { Address, CopyButton } from "./common.js";
import { JsonTree } from "./JsonTree.js";

interface Props {
  timeline: TimelineItem[];
  selected: string | undefined;
  onSelect: (signature: string) => void;
  fresh: Set<string>;
}

function topLevelNames(item: TimelineItem): string {
  const top = item.instructions.filter((i) => i.depth === 0);
  return top.map((i) => i.name ?? i.programName ?? short(i.programId)).join(", ");
}

function matches(item: TimelineItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.signature,
    item.error?.name ?? "",
    ...item.instructions.flatMap((i) => [
      i.name ?? "",
      i.programName ?? "",
      ...i.accounts.map((a) => a.address),
    ]),
  ];
  return haystack.some((s) => s.toLowerCase().includes(q));
}

function Row({
  item,
  selected,
  fresh,
  onSelect,
}: {
  item: TimelineItem;
  selected: boolean;
  fresh: boolean;
  onSelect: () => void;
}) {
  const programs = [
    ...new Set(
      item.instructions
        .filter((i) => i.depth === 0)
        .map((i) => i.programName ?? short(i.programId)),
    ),
  ];
  return (
    <button
      type="button"
      className={`row${fresh ? " fresh" : ""}`}
      aria-selected={selected}
      onClick={onSelect}
    >
      <div className="row-top">
        <span className={`status ${item.success ? "ok" : "fail"}`} />
        <span className="row-title">{topLevelNames(item)}</span>
        {item.error?.name && <span className="chip bad">{item.error.name}</span>}
        {item.accountDiffs.length > 0 && (
          <span className="chip ok">{item.accountDiffs.length} diff</span>
        )}
      </div>
      <div className="row-sub">
        <span>slot {item.slot}</span>
        <span>{when(item.blockTime)}</span>
        <span>{programs.join(" · ")}</span>
        <span className="mono" style={{ marginLeft: "auto" }}>
          {short(item.signature, 5)}
        </span>
      </div>
    </button>
  );
}

function hasArgs(ix: DecodedInstruction): boolean {
  return typeof ix.args === "object" && ix.args !== null && Object.keys(ix.args).length > 0;
}

function InstructionBody({ ix }: { ix: DecodedInstruction }) {
  return (
    <div style={{ marginLeft: 46, marginTop: 6 }}>
      {hasArgs(ix) && <JsonTree value={ix.args ?? null} />}
      {ix.event && <JsonTree value={ix.event.data} />}
      {ix.data && <div className="mono faint">data 0x{ix.data}</div>}
      {ix.accounts.length > 0 && (
        <div className="ix-accounts">
          {ix.accounts.map((a, i) => (
            <AccountRow key={`${a.address}-${i}`} name={a.name ?? `#${i}`} account={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function Instruction({ ix }: { ix: DecodedInstruction }) {
  const [open, setOpen] = useState(ix.depth === 0);
  const title = ix.event ? `emit ${ix.event.name}` : (ix.name ?? "unknown instruction");
  return (
    <div className="ix" style={{ paddingLeft: 14 + ix.depth * 22 }}>
      <div className="ix-head">
        <span className="ix-index">{ix.index}</span>
        <button className="tree-toggle" type="button" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <span className="ix-name">{title}</span>
        <span className="muted">{ix.programName ?? short(ix.programId)}</span>
      </div>
      {open && <InstructionBody ix={ix} />}
    </div>
  );
}

function AccountRow({
  name,
  account,
}: {
  name: string;
  account: DecodedInstruction["accounts"][number];
}) {
  return (
    <>
      <span className="mono muted">{name}</span>
      <span className="flags">
        {account.writable && <span className="chip">mut</span>}{" "}
        {account.signer && <span className="chip">signer</span>}
      </span>
      <Address address={account.address} />
    </>
  );
}

function Header({ item }: { item: TimelineItem }) {
  return (
    <>
      <h2>
        <span className={`status ${item.success ? "ok" : "fail"}`} />
        {topLevelNames(item)}
      </h2>
      <div className="muted mono" style={{ overflowWrap: "anywhere" }}>
        {item.signature} <CopyButton text={item.signature} />
      </div>
      <div className="toolbar muted" style={{ marginTop: 8 }}>
        <span>slot {item.slot}</span>·<span>{when(item.blockTime)}</span>·
        <span>fee {item.fee} lamports</span>
        {item.computeUnits !== null && <span>· {item.computeUnits.toLocaleString()} CU</span>}
      </div>
    </>
  );
}

function ErrorBox({ error }: { error: NonNullable<TimelineItem["error"]> }) {
  const where = [
    error.code !== undefined ? `code ${error.code}` : undefined,
    error.instruction !== undefined ? `instruction ${error.instruction + 1}` : undefined,
  ].filter(Boolean);
  return (
    <div className="finding warning" style={{ marginTop: 14 }}>
      <span>✕</span>
      <div>
        <div>
          <strong>{error.name ?? "Transaction failed"}</strong>
          {where.length > 0 && <span className="mono muted"> · {where.join(" · ")}</span>}
        </div>
        {error.msg && <div>{error.msg}</div>}
        {!error.name && <code>{error.message}</code>}
      </div>
    </div>
  );
}

function Events({ events }: { events: TimelineItem["events"] }) {
  if (events.length === 0) return null;
  return (
    <>
      <h3>Events</h3>
      <div className="card">
        {events.map((e, i) => (
          <div className="ix" key={`${e.name}-${i}`}>
            <div className="ix-head">
              <span className="ix-name">{e.name}</span>
              <span className="chip">{e.via === "cpi" ? "emit_cpi!" : "emit!"}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              <JsonTree value={e.data} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StateChanges({ diffs }: { diffs: TimelineItem["accountDiffs"] }) {
  if (diffs.length === 0) return null;
  const shared = (
    <span className="chip warn" title="Other transactions in this slot also wrote this account">
      shared slot
    </span>
  );
  return (
    <>
      <h3>State changes (observed live)</h3>
      {diffs.map((d) => (
        <AccountChange key={d.address} diff={d} note={d.sharedSlot ? shared : undefined} />
      ))}
    </>
  );
}

function Balances({ changes }: { changes: TimelineItem["balanceChanges"] }) {
  if (changes.length === 0) return null;
  return (
    <>
      <h3>Balance changes</h3>
      <div className="card">
        <table className="table">
          <tbody>
            {changes.map((b) => (
              <tr key={b.address}>
                <td>
                  <Address address={b.address} />
                </td>
                <td
                  className={`mono ${b.after > b.before ? "after" : "before"}`}
                  style={{ textDecoration: "none", textAlign: "right" }}
                >
                  {signedSol(b.after - b.before)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Logs({ logs, initiallyOpen }: { logs: string[]; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <h3>
        <button className="btn" type="button" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"} logs ({logs.length})
        </button>
      </h3>
      {open && (
        <div className="card">
          <pre className="logs">{logs.join("\n")}</pre>
        </div>
      )}
    </>
  );
}

function Details({ item }: { item: TimelineItem }) {
  return (
    <div className="detail">
      <Header item={item} />
      {item.error && <ErrorBox error={item.error} />}
      <h3>Instructions</h3>
      <div className="card">
        {item.instructions.map((ix) => (
          <Instruction key={ix.index} ix={ix} />
        ))}
      </div>
      <Events events={item.events} />
      <StateChanges diffs={item.accountDiffs} />
      <Balances changes={item.balanceChanges} />
      <Logs logs={item.logs} initiallyOpen={!item.success} />
    </div>
  );
}

export function TimelineView({ timeline, selected, onSelect, fresh }: Props) {
  const [query, setQuery] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const shown = useMemo(
    () => timeline.filter((t) => matches(t, query) && (!failedOnly || !t.success)),
    [timeline, query, failedOnly],
  );
  const current = timeline.find((t) => t.signature === selected) ?? shown[0];
  return (
    <div className="view two">
      <div className="list">
        <div className="list-head">
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Filter by instruction, error, address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={() => setFailedOnly(!failedOnly)}
            />
            failed
          </label>
        </div>
        {shown.length === 0 && <div className="empty">No transactions.</div>}
        {shown.map((item) => (
          <Row
            key={item.signature}
            item={item}
            selected={item.signature === current?.signature}
            fresh={fresh.has(item.signature)}
            onSelect={() => onSelect(item.signature)}
          />
        ))}
      </div>
      {current ? (
        <Details key={current.signature} item={current} />
      ) : (
        <div className="empty">Select a transaction.</div>
      )}
    </div>
  );
}
