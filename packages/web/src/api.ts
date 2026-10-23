import type {
  ObservedChange,
  SessionEvent,
  SnapshotSummary,
  StateDiff,
  TimelineItem,
  QualificationView,
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
  QualificationEvidence,
  QualificationReview,
  QualificationVerdict,
  QualificationView,
  SharedAddress,
  SharedAddressOccurrence,
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
  peers?: { label: string; port: number }[];
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
  qualification: (account: string) =>
    request<QualificationView>(`/api/qualification?account=${encodeURIComponent(account)}`),
  qualify: (account: string) => post<QualificationView>("/api/qualification", { account }),
  timeline: () => request<TimelineItem[]>("/api/timeline"),
  history: (address: string) =>
    request<ObservedChange[]>(`/api/history?address=${encodeURIComponent(address)}`),
  snapshots: () => request<SnapshotSummary[]>("/api/snapshots"),
  saveSnapshot: (name: string) => post<SnapshotSummary>("/api/snapshots", { name }),
  diff: (from: string, to: string) =>
    request<StateDiff>(`/api/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  refresh: () => post<XrayModel>("/api/refresh"),
  loadMore: (program: string, typeName: string | null, count: number) =>
    post<XrayModel>("/api/load", { program, typeName, count }),
  loadAddresses: (addresses: string[]) => post<XrayModel>("/api/load", { addresses }),
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
