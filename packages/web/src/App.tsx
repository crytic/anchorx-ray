import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavContext, type Navigation } from "./common.js";
import { GraphView } from "./GraphView.js";
import { defaultFilters } from "./graph.js";
import { Inspector } from "./Inspector.js";
import { LOAD_STEP } from "./Sidebar.js";
import { SnapshotsView } from "./SnapshotsView.js";
import { TimelineView } from "./TimelineView.js";
import { TopBar, type View } from "./TopBar.js";
import { useServer, type ServerState } from "./useServer.js";

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-banner" role="alert">
      {message}{" "}
      <button className="btn" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}

interface GraphPaneProps {
  server: ServerState;
  selected: string | undefined;
  onSelect: (address: string | undefined) => void;
}

function GraphPane({ server, selected, onSelect }: GraphPaneProps) {
  const [filters, setFilters] = useState(defaultFilters);
  const model = server.model;
  if (!model) return null;
  const account = selected ? model.accounts.find((a) => a.address === selected) : undefined;
  return (
    <div
      className="view"
      style={{ gridTemplateColumns: account ? "240px 1fr 400px" : "240px 1fr" }}
    >
      <GraphView
        model={model}
        filters={filters}
        onFilters={setFilters}
        selected={selected}
        onSelect={onSelect}
        flashes={server.flashes}
        onLoadMore={(program, typeName) => server.loadMore(program, typeName, LOAD_STEP)}
        onLoadAddress={server.loadAddress}
      />
      {account && (
        <Inspector
          model={model}
          account={account}
          timeline={server.timeline}
          changeTick={server.changeTick}
          onClose={() => onSelect(undefined)}
        />
      )}
    </div>
  );
}

export function App() {
  const server = useServer();
  const [view, setView] = useState<View>("graph");
  const [account, setAccount] = useState<string>();
  const [transaction, setTransaction] = useState<string>();
  useEscape(useCallback(() => setAccount(undefined), []));

  const model = server.model;
  const nav: Navigation = useMemo(() => {
    const byAddress = new Map(model?.accounts.map((a) => [a.address, a]));
    return {
      lookup: (address) => byAddress.get(address),
      selectAccount: (address) => {
        setAccount(address);
        setView("graph");
      },
      selectTransaction: (signature) => {
        setTransaction(signature);
        setView("timeline");
      },
    };
  }, [model]);

  const counts = {
    graph: model?.accounts.length ?? 0,
    timeline: server.timeline.length,
    snapshots: server.snapshots.length,
  };
  const panes: Record<View, ReactNode> = {
    graph: <GraphPane server={server} selected={account} onSelect={setAccount} />,
    timeline: (
      <TimelineView
        timeline={server.timeline}
        selected={transaction}
        onSelect={setTransaction}
        fresh={server.fresh}
      />
    ),
    snapshots: (
      <SnapshotsView
        snapshots={server.snapshots}
        liveTick={server.changeTick}
        offline={Boolean(server.status?.snapshot)}
        onSaved={server.reloadSnapshots}
      />
    ),
  };
  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        <div>
          <TopBar
            status={server.status}
            model={model}
            view={view}
            counts={counts}
            connected={server.connected}
            busy={server.busy}
            onView={setView}
            onRefresh={server.refresh}
          />
          {server.error && <ErrorBanner message={server.error} onDismiss={server.dismissError} />}
        </div>
        {model ? panes[view] : <div className="empty">Loading account graph…</div>}
      </div>
    </NavContext.Provider>
  );
}
