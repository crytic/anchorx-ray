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
import type { AccountNode, Edge, XrayModel } from "./api.js";
import {
  groupId,
  visibleGraph,
  type Filters,
  type GraphGroup,
  type Stack,
  type VisibleGraph,
} from "./graph.js";
import { computeLayout, type Box, type Layout } from "./layout.js";
import { KIND_HEX } from "./common.js";
import { EDGE_HEX, EDGE_STYLE } from "./edgeStyle.js";
import { Legend, Sidebar } from "./Sidebar.js";
import { edgeTypes, type RoutedData, type RoutedFlowEdge } from "./RoutedEdge.js";
import {
  nodeTypes,
  type AccountData,
  type AccountFlowNode,
  type ProgramFlowNode,
  type StackFlowNode,
} from "./nodes.js";

interface Props {
  model: XrayModel;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  selected: string | undefined;
  onSelect: (address: string | undefined) => void;
  flashes: Map<string, number>;
  onLoadMore: (program: string, typeName: string | null) => void;
  onLoadAddress: (address: string) => void;
}

const LARGE_GRAPH = 300;

const nodeCount = (graph: VisibleGraph) =>
  graph.loose.length + graph.groups.reduce((n, g) => n + g.children.length, 0);

/** Layout only depends on which nodes and edges exist, not on their contents. */
const members = (ids: string[]) => ids.join(",");

function structureKey(graph: VisibleGraph): string {
  const groups = graph.groups.map(
    (g) =>
      `${g.id}(${members([...g.children.map((c) => c.address), ...g.stacks.map((st) => st.id)])})`,
  );
  const loose = [...graph.loose.map((n) => n.address), ...graph.looseStacks.map((st) => st.id)];
  return [...groups, ...loose, ...graph.edges.map((e) => e.id)].join("|");
}

function stackNodes(stacks: Stack[], layout: Layout, parentId?: string): StackFlowNode[] {
  return stacks.flatMap((stack) => {
    const box = layout.boxes.get(stack.id);
    if (!box) return [];
    const node: StackFlowNode = {
      id: stack.id,
      type: "stack",
      position: { x: box.x, y: box.y },
      data: { stack },
      zIndex: 1,
    };
    if (parentId) node.parentId = parentId;
    return [node];
  });
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
    data: {
      program: group.program,
      account: group.node,
      count: group.children.length + group.stacks.reduce((n, st) => n + st.count, 0),
      dim: false,
    },
    zIndex: 0,
  };
  const children = group.children.flatMap((child) => {
    const childBox = layout.boxes.get(child.address);
    return childBox ? [accountNode(child, childBox, graph, flashes, group.id)] : [];
  });
  // Parents must precede their children in React Flow's node array.
  return [header, ...children, ...stackNodes(group.stacks, layout, group.id)];
}

function flowNodes(graph: VisibleGraph, layout: Layout, flashes: Map<string, number>): FlowNode[] {
  const loose = graph.loose.flatMap((account) => {
    const box = layout.boxes.get(account.address);
    return box ? [accountNode(account, box, graph, flashes)] : [];
  });
  const groups = graph.groups.flatMap((g) => groupNodes(g, graph, layout, flashes));
  return [...groups, ...loose, ...stackNodes(graph.looseStacks, layout)];
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

type DrawnEdge = VisibleGraph["edges"][number];

function edgeText(edge: DrawnEdge): string {
  const base = edge.constrainedBy ? `${edge.label} · has_one` : edge.label;
  return edge.count > 1 ? `${base} ×${edge.count}` : base;
}

function flowEdge(edge: DrawnEdge, layout: Layout, focus: Set<string> | undefined): RoutedFlowEdge {
  const touches = focus !== undefined && (focus.has(edge.from) || focus.has(edge.to));
  const text = edgeText(edge);
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

function flowEdges(
  edges: DrawnEdge[],
  layout: Layout,
  selected: string | undefined,
): RoutedFlowEdge[] {
  const focus = selected ? new Set([selected, groupId(selected)]) : undefined;
  return edges.map((edge) => flowEdge(edge, layout, focus));
}

const PIN_MS = 30_000;

/** Minimap fill per node type (SVG attributes cannot read CSS variables). */
function minimapColor(node: FlowNode): string {
  if (node.type === "program") return "transparent";
  if (node.type === "stack") return KIND_HEX[(node.data as StackFlowNode["data"]).stack.kind];
  return KIND_HEX[(node.data as AccountData).account.kind];
}

function Canvas({ model, filters, onFilters, selected, onSelect, flashes }: Props) {
  const pinned = useMemo(() => {
    const cutoff = Date.now() - PIN_MS;
    const recent = [...flashes].filter(([, at]) => at > cutoff).map(([address]) => address);
    return new Set(selected ? [selected, ...recent] : recent);
  }, [selected, flashes]);
  const graph = useMemo(() => visibleGraph(model, filters, pinned), [model, filters, pinned]);
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
  const pending = layout?.key !== key;
  return (
    <>
      {pending && (
        <div className="layout-pending">
          Laying out {nodeCount(graph).toLocaleString()} accounts…
        </div>
      )}
      <ReactFlow
        // Large programs: only mount what is on screen.
        onlyRenderVisibleElements={nodes.length > LARGE_GRAPH}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        nodesDraggable
        minZoom={0.1}
        onNodeClick={(_, node) => {
          if (node.type === "stack")
            onFilters({ ...filters, expanded: new Set(filters.expanded).add(node.id) });
          else onSelect(node.type === "program" ? node.id.slice(6) : node.id);
        }}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          // SVG presentation attributes cannot resolve CSS variables.
          nodeColor={minimapColor}
          nodeStrokeColor={(n) => (n.type === "program" ? KIND_HEX.program : "transparent")}
          nodeStrokeWidth={3}
        />
      </ReactFlow>
    </>
  );
}

export function GraphView(props: Props) {
  return (
    <>
      <Sidebar
        model={props.model}
        filters={props.filters}
        onFilters={props.onFilters}
        onLoadMore={props.onLoadMore}
        onLoadAddress={props.onLoadAddress}
      />
      <div className="canvas">
        <ReactFlowProvider>
          <Canvas {...props} />
        </ReactFlowProvider>
        <Legend />
      </div>
    </>
  );
}
