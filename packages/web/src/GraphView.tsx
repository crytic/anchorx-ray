import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node as FlowNode,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { AccountKind, AccountNode, Edge, EdgeKind, XrayModel } from "./api.js";
import {
  groupId,
  visibleGraph,
  type Filters,
  type GraphGroup,
  type VisibleGraph,
} from "./graph.js";
import { computeLayout, type Box, type Layout } from "./layout.js";
import { KIND_LABEL } from "./format.js";
import { KIND_HEX, KindSwatch } from "./common.js";
import { edgeTypes, type RoutedData, type RoutedFlowEdge } from "./RoutedEdge.js";
import {
  nodeTypes,
  type AccountData,
  type AccountFlowNode,
  type ProgramFlowNode,
} from "./nodes.js";

interface Props {
  model: XrayModel;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  selected: string | undefined;
  onSelect: (address: string | undefined) => void;
  flashes: Map<string, number>;
}

const EDGE_STYLE: Record<EdgeKind, { stroke: string; dash?: string }> = {
  field: { stroke: "var(--e-field)" },
  seed: { stroke: "var(--e-seed)", dash: "2 4" },
  owner: { stroke: "var(--e-owner)", dash: "6 4" },
  programdata: { stroke: "var(--e-owner)", dash: "6 4" },
};

const EDGE_HEX: Record<EdgeKind | "constrained", string> = {
  field: "#7c879f",
  constrained: "#34d399",
  seed: "#f59e0b",
  owner: "#a78bfa",
  programdata: "#a78bfa",
};

const EDGE_LABEL: Record<EdgeKind, string> = {
  field: "Pubkey fields",
  seed: "PDA seeds",
  owner: "Owner",
  programdata: "Program data",
};

/** Layout only depends on which nodes and edges exist, not on their contents. */
function structureKey(graph: VisibleGraph): string {
  const groups = graph.groups.map((g) => `${g.id}(${g.children.map((c) => c.address).join(",")})`);
  return [...groups, ...graph.loose.map((n) => n.address), ...graph.edges.map((e) => e.id)].join(
    "|",
  );
}

function accountNode(
  account: AccountNode,
  box: Box,
  graph: VisibleGraph,
  flashes: Map<string, number>,
  parentId?: string,
): AccountFlowNode {
  const node: AccountFlowNode = {
    id: account.address,
    type: "account",
    position: { x: box.x, y: box.y },
    data: {
      account,
      dim: !graph.matches.has(account.address),
      flash: flashes.get(account.address) ?? 0,
    },
    zIndex: 1,
  };
  if (parentId) node.parentId = parentId;
  return node;
}

function groupNodes(
  group: GraphGroup,
  graph: VisibleGraph,
  layout: Layout,
  flashes: Map<string, number>,
): FlowNode[] {
  const box = layout.boxes.get(group.id);
  if (!box) return [];
  const header: ProgramFlowNode = {
    id: group.id,
    type: "program",
    position: { x: box.x, y: box.y },
    style: { width: box.width, height: box.height },
    data: { program: group.program, account: group.node, count: group.children.length, dim: false },
    zIndex: 0,
  };
  const children = group.children.flatMap((child) => {
    const childBox = layout.boxes.get(child.address);
    return childBox ? [accountNode(child, childBox, graph, flashes, group.id)] : [];
  });
  // Parents must precede their children in React Flow's node array.
  return [header, ...children];
}

function flowNodes(graph: VisibleGraph, layout: Layout, flashes: Map<string, number>): FlowNode[] {
  const loose = graph.loose.flatMap((account) => {
    const box = layout.boxes.get(account.address);
    return box ? [accountNode(account, box, graph, flashes)] : [];
  });
  return [...graph.groups.flatMap((g) => groupNodes(g, graph, layout, flashes)), ...loose];
}

function edgeStyle(edge: Edge, touches: boolean, dimmed: boolean) {
  return {
    stroke: edge.constrainedBy ? "var(--e-constrained)" : EDGE_STYLE[edge.kind].stroke,
    strokeWidth: touches ? 2.2 : 1.4,
    strokeDasharray: EDGE_STYLE[edge.kind].dash,
    opacity: dimmed ? 0.18 : 0.9,
  };
}

function anchorsOf(edge: Edge, layout: Layout): RoutedData["anchors"] {
  const source = layout.boxes.get(edge.from);
  const target = layout.boxes.get(edge.to);
  return source && target ? { source: source.absolute, target: target.absolute } : undefined;
}

function flowEdge(edge: Edge, layout: Layout, focus: Set<string> | undefined): RoutedFlowEdge {
  const touches = focus !== undefined && (focus.has(edge.from) || focus.has(edge.to));
  const text = edge.constrainedBy ? `${edge.label} · has_one` : edge.label;
  const color = EDGE_HEX[edge.constrainedBy ? "constrained" : edge.kind];
  return {
    id: edge.id,
    type: "routed",
    source: edge.from,
    target: edge.to,
    zIndex: touches ? 3 : 2,
    data: {
      route: layout.routes.get(edge.id),
      anchors: anchorsOf(edge, layout),
      text: touches ? text : undefined,
    },
    style: edgeStyle(edge, touches, focus !== undefined && !touches),
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  };
}

function flowEdges(edges: Edge[], layout: Layout, selected: string | undefined): RoutedFlowEdge[] {
  const focus = selected ? new Set([selected, groupId(selected)]) : undefined;
  return edges.map((edge) => flowEdge(edge, layout, focus));
}

function Canvas({ model, filters, selected, onSelect, flashes }: Omit<Props, "onFilters">) {
  const graph = useMemo(() => visibleGraph(model, filters), [model, filters]);
  const key = structureKey(graph);
  const [layout, setLayout] = useState<{ key: string; boxes: Layout } | undefined>();
  const flow = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    void computeLayout(graph).then((boxes) => {
      if (!cancelled) setLayout({ key, boxes });
    });
    return () => {
      cancelled = true;
    };
    // Re-layout only when the structure changes; `graph` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const derived = useMemo(
    () => (layout ? flowNodes(graph, layout.boxes, flashes) : []),
    [graph, layout, flashes],
  );
  // Controlled nodes: React Flow writes measurements and drags back through onNodesChange.
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [placedKey, setPlacedKey] = useState<string>();
  useEffect(() => {
    const sameLayout = layout?.key === placedKey;
    setNodes((prev) => {
      if (!sameLayout) return derived;
      // Same structure: keep positions the user dragged to, refresh the data.
      const moved = new Map(prev.map((n) => [n.id, n.position]));
      return derived.map((n) => ({ ...n, position: moved.get(n.id) ?? n.position }));
    });
    setPlacedKey(layout?.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived]);
  const edges = useMemo(
    () => (layout ? flowEdges(graph.edges, layout.boxes, selected) : []),
    [graph.edges, layout, selected],
  );

  // Frame the whole graph whenever the layout changes.
  useEffect(() => {
    if (!layout) return;
    const timer = setTimeout(() => void flow.fitView({ padding: 0.1 }), 60);
    return () => clearTimeout(timer);
  }, [layout, flow]);

  // Pan to a newly selected account, keeping the zoom unless it is too small to read.
  useEffect(() => {
    if (!selected) return;
    // Wait for the canvas to resize when the inspector opens.
    const timer = setTimeout(() => {
      const node = flow.getInternalNode(selected) ?? flow.getInternalNode(groupId(selected));
      if (!node) return;
      const { x, y } = node.internals.positionAbsolute;
      const width = node.measured.width ?? 0;
      const height = node.measured.height ?? 0;
      const zoom = Math.max(flow.getZoom(), 0.8);
      void flow.setCenter(x + width / 2, y + Math.min(height, 200) / 2, { zoom, duration: 400 });
    }, 60);
    return () => clearTimeout(timer);
  }, [selected, flow]);

  if (graph.groups.length === 0 && graph.loose.length === 0) {
    return <div className="empty">No accounts match the current filters.</div>;
  }
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      nodesDraggable
      minZoom={0.1}
      onNodeClick={(_, node) => onSelect(node.type === "program" ? node.id.slice(6) : node.id)}
      onPaneClick={() => onSelect(undefined)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1} color="var(--border)" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        // SVG presentation attributes cannot resolve CSS variables.
        nodeColor={(n) =>
          n.type === "program" ? "transparent" : KIND_HEX[(n.data as AccountData).account.kind]
        }
        nodeStrokeColor={(n) => (n.type === "program" ? KIND_HEX.program : "transparent")}
        nodeStrokeWidth={3}
      />
    </ReactFlow>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function Sidebar({ model, filters, onFilters }: Pick<Props, "model" | "filters" | "onFilters">) {
  const kinds = [...new Set(model.accounts.map((a) => a.kind))].filter((k) => k !== "program");
  const count = (kind: AccountKind) => model.accounts.filter((a) => a.kind === kind).length;
  const findings = model.accounts.reduce((n, a) => n + a.findings.length, 0);
  return (
    <aside className="sidebar">
      <input
        className="input"
        placeholder="Search address, type, label…"
        value={filters.search}
        onChange={(e) => onFilters({ ...filters, search: e.target.value })}
      />
      <div>
        <h4 className="section-title">Programs</h4>
        {model.programs.map((p) => (
          <label className="check" key={p.id}>
            <input
              type="checkbox"
              checked={!filters.hiddenPrograms.has(p.id)}
              onChange={() =>
                onFilters({ ...filters, hiddenPrograms: toggle(filters.hiddenPrograms, p.id) })
              }
            />
            <KindSwatch kind="program" />
            {p.name}
            <span className="n">{model.accounts.filter((a) => a.program === p.id).length}</span>
          </label>
        ))}
      </div>
      <div>
        <h4 className="section-title">Accounts</h4>
        {kinds.map((kind) => (
          <label className="check" key={kind}>
            <input
              type="checkbox"
              checked={!filters.hiddenKinds.has(kind)}
              onChange={() =>
                onFilters({ ...filters, hiddenKinds: toggle(filters.hiddenKinds, kind) })
              }
            />
            <KindSwatch kind={kind} />
            {KIND_LABEL[kind]}
            <span className="n">{count(kind)}</span>
          </label>
        ))}
      </div>
      <div>
        <h4 className="section-title">Edges</h4>
        {(["field", "seed", "programdata"] as EdgeKind[]).map((kind) => (
          <label className="check" key={kind}>
            <input
              type="checkbox"
              checked={filters.edgeKinds.has(kind)}
              onChange={() => onFilters({ ...filters, edgeKinds: toggle(filters.edgeKinds, kind) })}
            />
            <span
              className="line-swatch"
              style={{
                borderColor: EDGE_STYLE[kind].stroke,
                borderTopStyle: EDGE_STYLE[kind].dash ? "dashed" : "solid",
              }}
            />
            {EDGE_LABEL[kind]}
          </label>
        ))}
      </div>
      <div>
        <h4 className="section-title">Findings</h4>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.findingsOnly}
            onChange={() => onFilters({ ...filters, findingsOnly: !filters.findingsOnly })}
          />
          Highlight accounts with findings
          <span className="n">{findings}</span>
        </label>
      </div>
    </aside>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="line-swatch" style={{ borderColor: "var(--e-field)" }} /> field
      </span>
      <span>
        <i className="line-swatch" style={{ borderColor: "var(--e-constrained)" }} /> field checked
        by has_one
      </span>
      <span>
        <i
          className="line-swatch"
          style={{ borderColor: "var(--e-seed)", borderTopStyle: "dashed" }}
        />{" "}
        PDA seed
      </span>
    </div>
  );
}

export function GraphView(props: Props) {
  return (
    <>
      <Sidebar model={props.model} filters={props.filters} onFilters={props.onFilters} />
      <div className="canvas">
        <ReactFlowProvider>
          <Canvas {...props} />
        </ReactFlowProvider>
        <Legend />
      </div>
    </>
  );
}
