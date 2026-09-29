import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  subscribe,
  type SessionEvent,
  type SnapshotSummary,
  type Status,
  type TimelineItem,
  type XrayModel,
} from "./api.js";

export interface ServerState {
  status: Status | undefined;
  model: XrayModel | undefined;
  timeline: TimelineItem[];
  snapshots: SnapshotSummary[];
  connected: boolean;
  error: string | undefined;
  busy: boolean;
  /** Last time each account changed live, to flash it on the canvas. */
  flashes: Map<string, number>;
  /** Signatures that arrived live, to highlight them in the timeline. */
  fresh: Set<string>;
  /** Increments on every live account change. */
  changeTick: number;
  dismissError: () => void;
  refresh: () => void;
  reloadSnapshots: () => void;
  loadMore: (program: string, typeName: string | null, count: number) => void;
  loadAddress: (address: string) => void;
}

function upsert(list: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const rest = list.filter((t) => t.signature !== item.signature);
  return [item, ...rest].toSorted((a, b) => b.slot - a.slot);
}

/** Loads the session from the CLI server and keeps it current through the event stream. */
export function useServer(): ServerState {
  const [status, setStatus] = useState<Status>();
  const [model, setModel] = useState<XrayModel>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [flashes, setFlashes] = useState(() => new Map<string, number>());
  const [fresh, setFresh] = useState(() => new Set<string>());
  const [changeTick, setChangeTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fail = useCallback((e: unknown) => setError((e as Error).message), []);
  const loadTimeline = useCallback(() => api.timeline().then(setTimeline, fail), [fail]);
  const reloadSnapshots = useCallback(() => void api.snapshots().then(setSnapshots, fail), [fail]);

  useEffect(() => {
    api.status().then(setStatus, fail);
    api.model().then(setModel, fail);
    void loadTimeline();
    reloadSnapshots();
  }, [fail, loadTimeline, reloadSnapshots]);

  useEffect(() => {
    const onEvent = (event: SessionEvent) => {
      switch (event.type) {
        case "model":
          return setModel(event.model);
        case "account":
          setFlashes((prev) => new Map(prev).set(event.change.diff.address, Date.now()));
          setChangeTick((t) => t + 1);
          // Account diffs are joined to transactions server-side; refetch once they settle.
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void loadTimeline(), 400);
          return undefined;
        case "transaction":
          setTimeline((prev) => upsert(prev, event.item));
          return setFresh((prev) => new Set(prev).add(event.item.signature));
        case "status":
          setStatus((prev) => prev && { ...prev, watching: event.watching });
          return event.error ? setError(event.error) : undefined;
      }
    };
    return subscribe(onEvent, setConnected);
  }, [loadTimeline]);

  const refresh = useCallback(() => {
    setBusy(true);
    api
      .refresh()
      .then(setModel)
      .then(loadTimeline)
      .catch(fail)
      .finally(() => setBusy(false));
  }, [fail, loadTimeline]);

  const withBusy = useCallback(
    (work: () => Promise<XrayModel>) => {
      setBusy(true);
      work()
        .then(setModel, fail)
        .finally(() => setBusy(false));
    },
    [fail],
  );
  const loadMore = useCallback(
    (program: string, typeName: string | null, count: number) =>
      withBusy(() => api.loadMore(program, typeName, count)),
    [withBusy],
  );
  const loadAddress = useCallback(
    (address: string) => withBusy(() => api.loadAddresses([address])),
    [withBusy],
  );

  return {
    status,
    model,
    timeline,
    snapshots,
    connected,
    error,
    busy,
    flashes,
    fresh,
    changeTick,
    dismissError: () => setError(undefined),
    refresh,
    reloadSnapshots,
    loadMore,
    loadAddress,
  };
}
