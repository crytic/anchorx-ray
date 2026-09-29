import { useEffect, useState } from "react";
import { AccountChange } from "./AccountChange.js";
import { api, type SnapshotSummary, type StateDiff } from "./api.js";
import { when } from "./format.js";

interface Props {
  snapshots: SnapshotSummary[];
  offline: boolean;
  onSaved: () => void;
}

const LIVE = "live";

function SaveForm({
  onSaved,
  onError,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const save = () => {
    api.saveSnapshot(name.trim()).then(
      () => {
        setName("");
        onSaved();
      },
      (e: Error) => onError(e.message),
    );
  };
  return (
    <div className="list-head">
      <input
        className="input"
        style={{ flex: 1 }}
        placeholder="snapshot name, e.g. before-liquidation"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) save();
        }}
      />
      <button className="btn primary" type="button" disabled={!name.trim()} onClick={save}>
        Save
      </button>
    </div>
  );
}

function SnapshotRow({
  snapshot,
  selected,
  onSelect,
}: {
  snapshot: SnapshotSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="row" aria-selected={selected} onClick={onSelect}>
      <div className="row-top">
        <span className="row-title">{snapshot.name}</span>
        <span className="faint" style={{ marginLeft: "auto" }}>
          {when(snapshot.createdAt)}
        </span>
      </div>
      <div className="row-sub">
        <span>slot {snapshot.slot}</span>
        <span>{snapshot.accounts} accounts</span>
        <span>{snapshot.transactions} txs</span>
      </div>
    </button>
  );
}

/** Fetches and shows the diff between two states; re-keyed by the parent to refetch. */
function DiffPanel({ from, to }: { from: string; to: string }) {
  const [diff, setDiff] = useState<StateDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.diff(from, to).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [from, to]);
  if (error)
    return (
      <div className="finding warning" style={{ marginTop: 12 }}>
        {error}
      </div>
    );
  if (!diff) return <div className="empty">Comparing…</div>;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="muted" style={{ marginBottom: 12 }}>
        slot {diff.from.slot} → {diff.to.slot} · {diff.accounts.length} account(s) changed
      </div>
      {diff.accounts.map((d) => (
        <AccountChange key={d.address} diff={d} />
      ))}
      {diff.accounts.length === 0 && <div className="empty">No differences.</div>}
    </div>
  );
}

function Picker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}

interface Selection {
  from: string | undefined;
  to: string;
  options: string[];
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}

function Comparison({ selection, version }: { selection: Selection; version: number }) {
  const { from, to, options } = selection;
  if (!from) return <div className="empty">Save a snapshot to compare states.</div>;
  return (
    <>
      <div className="toolbar">
        <strong>Compare</strong>
        <Picker value={from} options={options} onChange={selection.onFrom} />→
        <Picker value={to} options={options} onChange={selection.onTo} />
      </div>
      <DiffPanel key={`${from}→${to}#${version}`} from={from} to={to} />
    </>
  );
}

type Picked = { from?: string; to?: string };

function selectionOf(
  snapshots: SnapshotSummary[],
  offline: boolean,
  picked: Picked,
  setPicked: (p: Picked) => void,
): Selection {
  const newest = snapshots.at(-1)?.name;
  // Offline there is no live state; default to comparing the newest snapshot with itself.
  const defaultTo = offline ? (newest ?? LIVE) : LIVE;
  return {
    from: picked.from ?? newest,
    to: picked.to ?? defaultTo,
    options: [...snapshots.map((s) => s.name), ...(offline ? [] : [LIVE])],
    onFrom: (from) => setPicked({ ...picked, from }),
    onTo: (to) => setPicked({ ...picked, to }),
  };
}

export function SnapshotsView({ snapshots, offline, onSaved }: Props) {
  const [picked, setPicked] = useState<Picked>({});
  const [error, setError] = useState<string>();
  const selection = selectionOf(snapshots, offline, picked, setPicked);
  const saved = () => {
    setError(undefined);
    onSaved();
  };
  return (
    <div className="view two">
      <div className="list">
        <SaveForm onSaved={saved} onError={setError} />
        {snapshots.length === 0 && (
          <div className="empty">
            Snapshots capture every account and recent transaction.
            <br />
            Save one before running a test, then diff it against live state.
          </div>
        )}
        {snapshots.toReversed().map((s) => (
          <SnapshotRow
            key={s.name}
            snapshot={s}
            selected={s.name === selection.from}
            onSelect={() => selection.onFrom(s.name)}
          />
        ))}
      </div>
      <div className="detail">
        {error && <div className="finding warning">{error}</div>}
        <Comparison selection={selection} version={snapshots.length} />
      </div>
    </div>
  );
}
