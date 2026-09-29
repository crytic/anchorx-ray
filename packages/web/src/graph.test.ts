import { describe, expect, test } from "vitest";
import type { AccountNode, Edge, EdgeKind, XrayModel } from "./api.js";
import { defaultFilters, groupId, neighbours, visibleGraph } from "./graph.js";
import { computeLayout, labelPoint, roundedPath } from "./layout.js";

const PROGRAM = "Prog111111111111111111111111111111111111111";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

function account(address: string, patch: Partial<AccountNode> = {}): AccountNode {
  return {
    address,
    kind: "external",
    label: address,
    owner: LOADER,
    lamports: 1,
    dataLen: 8,
    executable: false,
    onCurve: false,
    findings: [],
    ...patch,
  };
}

const owned = (address: string, patch: Partial<AccountNode> = {}) =>
  account(address, { kind: "pda", owner: PROGRAM, program: PROGRAM, ...patch });

function edge(kind: Edge["kind"], from: string, to: string, label = "f"): Edge {
  return { id: `${kind}:${from}:${to}:${label}`, kind, from, to, label };
}

const model: XrayModel = {
  slot: 1,
  fetchedAt: "",
  programs: [
    {
      id: PROGRAM,
      name: "prog",
      version: "0.1.0",
      deployed: true,
      accountTypes: [],
      instructions: [],
      events: [],
    },
  ],
  accounts: [
    account(PROGRAM, { kind: "program", executable: true }),
    owned("A", { typeName: "Vault" }),
    owned("B", { kind: "keypair", findings: [{ severity: "warning", code: "x", message: "m" }] }),
    account("W", { kind: "wallet", owner: "11111111111111111111111111111111" }),
    account("PD"),
  ],
  edges: [
    edge("owner", "A", PROGRAM, "owner"),
    edge("field", "A", "W", "owner"),
    edge("field", "B", "A", "vault"),
    edge("seed", "A", "W", "seed[1]"),
    edge("field", "B", PROGRAM, "program"),
    edge("programdata", PROGRAM, "PD", "programdata"),
  ],
};

describe("visibleGraph", () => {
  test("groups program-owned accounts and maps program endpoints to the group", () => {
    const graph = visibleGraph(model, defaultFilters());
    expect(graph.groups).toHaveLength(1);
    expect(graph.groups[0]?.children.map((c) => c.address)).toEqual(["A", "B"]);
    expect(graph.loose.map((n) => n.address)).toEqual(["W"]);
    expect(graph.edges.map((e) => [e.kind, e.from, e.to])).toEqual([
      ["field", "A", "W"],
      ["field", "B", "A"],
      ["seed", "A", "W"],
      ["field", "B", groupId(PROGRAM)],
    ]);
  });

  test("shows ProgramData nodes only with their edges", () => {
    const graph = visibleGraph(model, {
      ...defaultFilters(),
      edgeKinds: new Set<EdgeKind>(["programdata"]),
    });
    expect(graph.loose.map((n) => n.address)).toEqual(["W", "PD"]);
    expect(graph.edges).toEqual([expect.objectContaining({ from: groupId(PROGRAM), to: "PD" })]);
  });

  test("hides kinds and programs, and dims instead of hiding on search", () => {
    const hidden = visibleGraph(model, { ...defaultFilters(), hiddenKinds: new Set(["wallet"]) });
    expect(hidden.loose).toEqual([]);
    expect(hidden.edges.some((e) => e.to === "W")).toBe(false);
    const noProgram = visibleGraph(model, {
      ...defaultFilters(),
      hiddenPrograms: new Set([PROGRAM]),
    });
    expect(noProgram.groups).toEqual([]);
    expect(noProgram.edges).toEqual([]);
    const searched = visibleGraph(model, { ...defaultFilters(), search: "vault" });
    expect([...searched.matches]).toEqual(["A"]);
    const findings = visibleGraph(model, { ...defaultFilters(), findingsOnly: true });
    expect([...findings.matches]).toEqual(["B"]);
  });

  test("lists neighbours in both directions", () => {
    expect([...neighbours(model, "A")].toSorted()).toEqual(["B", PROGRAM, "W"].toSorted());
  });
});

describe("layout", () => {
  test("places every node and routes every edge", async () => {
    const graph = visibleGraph(model, defaultFilters());
    const layout = await computeLayout(graph);
    for (const id of [groupId(PROGRAM), "A", "B", "W"]) expect(layout.boxes.has(id)).toBe(true);
    const group = layout.boxes.get(groupId(PROGRAM));
    const child = layout.boxes.get("A");
    expect(child?.absolute.x).toBe((group?.absolute.x ?? 0) + (child?.x ?? 0));
    for (const e of graph.edges) expect(layout.routes.get(e.id)?.length).toBeGreaterThanOrEqual(2);
  });

  test("rounds orthogonal corners and labels the longest segment", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 20 },
    ];
    expect(roundedPath(points)).toBe("M 0 0 L 92 0 Q 100 0 100 8 L 100 20");
    expect(roundedPath([])).toBe("");
    expect(labelPoint(points)).toEqual({ x: 50, y: 0 });
  });
});
