import type { EdgeKind } from "./api.js";

export const EDGE_STYLE: Record<EdgeKind, { stroke: string; dash?: string }> = {
  field: { stroke: "var(--e-field)" },
  seed: { stroke: "var(--e-seed)", dash: "2 4" },
  owner: { stroke: "var(--e-owner)", dash: "6 4" },
  programdata: { stroke: "var(--e-owner)", dash: "6 4" },
};

export const EDGE_HEX: Record<EdgeKind | "constrained", string> = {
  field: "#7c879f",
  constrained: "#34d399",
  seed: "#f59e0b",
  owner: "#a78bfa",
  programdata: "#a78bfa",
};

export const EDGE_LABEL: Record<EdgeKind, string> = {
  field: "Pubkey fields",
  seed: "PDA seeds",
  owner: "Owner",
  programdata: "Program data",
};
