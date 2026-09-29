import type { ELK as ElkApi, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { GROUP_HEADER, NODE_HEIGHT, NODE_WIDTH, type VisibleGraph } from "./graph.js";

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
  /** Top-left corner in canvas coordinates (`x`/`y` are relative to the parent group). */
  absolute: Point;
}

export interface Layout {
  boxes: Map<string, Box>;
  /** Orthogonal edge routes in canvas coordinates. */
  routes: Map<string, Point[]>;
}

let elk: Promise<ElkApi> | undefined;

/**
 * Lays out in a Web Worker in the browser, so graphs with thousands of
 * accounts do not freeze the page; falls back to the in-thread build in Node.
 */
function getElk(): Promise<ElkApi> {
  elk ??= (async () => {
    if (typeof Worker !== "undefined") {
      const [{ default: Elk }, { default: workerUrl }] = await Promise.all([
        import("elkjs/lib/elk-api.js"),
        import("elkjs/lib/elk-worker.min.js?url"),
      ]);
      return new Elk({ workerUrl });
    }
    const { default: Elk } = await import("elkjs/lib/elk.bundled.js");
    return new Elk();
  })();
  return elk;
}

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.layered.spacing.edgeNodeBetweenLayers": "28",
  "elk.spacing.nodeNode": "26",
  "elk.spacing.edgeEdge": "10",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.componentComponent": "60",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
};

const GROUP_OPTIONS = {
  "elk.padding": `[top=${GROUP_HEADER + 18},left=22,bottom=22,right=22]`,
};

const leaf = (id: string): ElkNode => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT });

export function toElk(graph: VisibleGraph): ElkNode {
  const children: ElkNode[] = [
    ...graph.groups.map((g) => {
      const members = [
        ...g.children.map((c) => leaf(c.address)),
        ...g.stacks.map((s) => leaf(s.id)),
      ];
      // An empty group still needs room for its header.
      const size =
        members.length === 0 ? { width: NODE_WIDTH + 44, height: GROUP_HEADER + 26 } : {};
      return { id: g.id, layoutOptions: GROUP_OPTIONS, ...size, children: members };
    }),
    ...graph.loose.map((n) => leaf(n.address)),
    ...graph.looseStacks.map((s) => leaf(s.id)),
  ];
  const edges: ElkExtendedEdge[] = graph.edges.map((e) => ({
    id: e.id,
    sources: [e.from],
    targets: [e.to],
  }));
  return { id: "root", layoutOptions: ROOT_OPTIONS, children, edges };
}

type ElkEdgeOut = ElkExtendedEdge & { container?: string };

function collectEdges(node: ElkNode, out: ElkEdgeOut[]): void {
  out.push(...((node.edges ?? []) as ElkEdgeOut[]));
  for (const child of node.children ?? []) collectEdges(child, out);
}

function routeOf(edge: ElkEdgeOut, origin: Point): Point[] | undefined {
  const section = edge.sections?.[0];
  if (!section) return undefined;
  const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  return points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y }));
}

export function fromElk(root: ElkNode): Layout {
  const boxes = new Map<string, Box>();
  const visit = (node: ElkNode, origin: Point) => {
    for (const child of node.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      const absolute = { x: origin.x + x, y: origin.y + y };
      boxes.set(child.id, {
        x,
        y,
        width: child.width ?? NODE_WIDTH,
        height: child.height ?? NODE_HEIGHT,
        absolute,
      });
      visit(child, absolute);
    }
  };
  visit(root, { x: 0, y: 0 });
  const edges: ElkEdgeOut[] = [];
  collectEdges(root, edges);
  const routes = new Map<string, Point[]>();
  for (const edge of edges) {
    // Section coordinates are relative to the edge's container node.
    const origin =
      edge.container && edge.container !== "root" ? boxes.get(edge.container)?.absolute : undefined;
    const route = routeOf(edge, origin ?? { x: 0, y: 0 });
    if (route) routes.set(edge.id, route);
  }
  return { boxes, routes };
}

export async function computeLayout(graph: VisibleGraph): Promise<Layout> {
  return fromElk(await (await getElk()).layout(toElk(graph)));
}

/** SVG path through orthogonal points, with rounded corners. */
export function roundedPath(points: Point[], radius = 8): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M ${first.x} ${first.y}`;
  rest.forEach((point, i) => {
    const prev = points[i] ?? first;
    const next = rest[i + 1];
    if (!next) {
      d += ` L ${point.x} ${point.y}`;
      return;
    }
    const r = Math.min(
      radius,
      Math.hypot(point.x - prev.x, point.y - prev.y) / 2,
      Math.hypot(next.x - point.x, next.y - point.y) / 2,
    );
    const into = {
      x: point.x - Math.sign(point.x - prev.x) * r,
      y: point.y - Math.sign(point.y - prev.y) * r,
    };
    const out = {
      x: point.x + Math.sign(next.x - point.x) * r,
      y: point.y + Math.sign(next.y - point.y) * r,
    };
    d += ` L ${into.x} ${into.y} Q ${point.x} ${point.y} ${out.x} ${out.y}`;
  });
  return d;
}

/** Midpoint of the longest segment: a label spot least likely to sit on a node. */
export function labelPoint(points: Point[]): Point {
  let best = { length: -1, at: points[0] ?? { x: 0, y: 0 } };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > best.length) best = { length, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  return best.at;
}
