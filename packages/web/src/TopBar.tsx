import type { Status, XrayModel } from "./api.js";

export type View = "graph" | "timeline" | "snapshots";

const VIEWS: View[] = ["graph", "timeline", "snapshots"];

interface Props {
  status: Status | undefined;
  model: XrayModel | undefined;
  view: View;
  counts: Record<View, number>;
  connected: boolean;
  busy: boolean;
  onView: (view: View) => void;
  onRefresh: () => void;
}

function connection(status: Status | undefined, connected: boolean): { dot: string; text: string } {
  if (status?.snapshot) return { dot: "offline", text: `snapshot “${status.snapshot}”` };
  if (!connected) return { dot: "", text: "disconnected" };
  return status?.watching ? { dot: "live", text: "live" } : { dot: "", text: "not watching" };
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2 2l8 8M10 2L2 10" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      anchorx-ray
    </div>
  );
}

function ClusterSwitch({ status }: { status: Status | undefined }) {
  if (!status?.peers?.length) return null;
  const label = status.cluster === "localnet" ? "Local" : status.cluster;
  return (
    <label className="cluster-switch">
      Cluster
      <select
        aria-label="Cluster"
        value="current"
        onChange={(event) => {
          const port = Number(event.target.value);
          if (Number.isInteger(port) && port > 0) {
            window.location.assign(`http://127.0.0.1:${port}/`);
          }
        }}
      >
        <option value="current">{label}</option>
        {status.peers.map((peer) => (
          <option key={peer.port} value={peer.port}>
            {peer.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TopBar({ status, model, view, counts, connected, busy, onView, onRefresh }: Props) {
  const conn = connection(status, connected);
  return (
    <header className="topbar">
      <Brand />
      <nav className="tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            className="tab"
            role="tab"
            type="button"
            aria-selected={view === v}
            onClick={() => onView(v)}
          >
            {v[0]?.toUpperCase()}
            {v.slice(1)}
            <span className="count">{counts[v]}</span>
          </button>
        ))}
      </nav>
      <ClusterSwitch status={status} />
      <div className="spacer" />
      <div className="conn">
        <span className={`dot ${conn.dot}`} />
        {conn.text}
        {model && <span className="faint">· slot {model.slot}</span>}
        {status && <span className="faint mono">· {status.rpcUrl}</span>}
      </div>
      <button
        className="btn"
        type="button"
        disabled={Boolean(status?.snapshot) || busy}
        onClick={onRefresh}
      >
        {busy ? "Scanning…" : "Rescan"}
      </button>
    </header>
  );
}
