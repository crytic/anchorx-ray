import type {
  ObservedChange,
  SessionEvent,
  SnapshotSummary,
  StateDiff,
  TimelineItem,
  XrayModel,
} from "@anchorx-ray/core";

export type {
  AccountDiff,
  AccountKind,
  AccountNode,
  DecodedInstruction,
  Edge,
  EdgeKind,
  FieldChange,
  Finding,
  Json,
  ObservedChange,
  PdaInfo,
  ProgramSummary,
  SessionEvent,
  SnapshotSummary,
  StateDiff,
  TimelineItem,
  XrayModel,
} from "@anchorx-ray/core";

export interface Status {
  rpcUrl: string;
  cluster: string;
  root: string;
  snapshot?: string;
  warnings: string[];
  watching: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json()) as T | { error: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? res.statusText;
    throw new Error(`${init?.method ?? "GET"} ${path}: ${message}`);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  status: () => request<Status>("/api/status"),
  model: () => request<XrayModel>("/api/model"),
  timeline: () => request<TimelineItem[]>("/api/timeline"),
  history: (address: string) =>
    request<ObservedChange[]>(`/api/history?address=${encodeURIComponent(address)}`),
  snapshots: () => request<SnapshotSummary[]>("/api/snapshots"),
  saveSnapshot: (name: string) => post<SnapshotSummary>("/api/snapshots", { name }),
  diff: (from: string, to: string) =>
    request<StateDiff>(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  refresh: () => post<XrayModel>("/api/refresh"),
};

/** Subscribes to the server's event stream; returns an unsubscribe function. */
export function subscribe(onEvent: (event: SessionEvent) => void, onOpen: (open: boolean) => void) {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => onOpen(true));
  source.addEventListener("error", () => onOpen(false));
  source.addEventListener("message", (message) => {
    onEvent(JSON.parse(message.data as string) as SessionEvent);
  });
  return () => source.close();
}
