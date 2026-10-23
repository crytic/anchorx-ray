import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { labelPoint, roundedPath, type Point } from "./layout.js";

export type RoutedData = {
  route: Point[] | undefined;
  /** Where source/target sat when the route was computed. */
  anchors: { source: Point; target: Point } | undefined;
  text: string | undefined;
};

export type RoutedFlowEdge = Edge<RoutedData, "routed">;

const same = (a: Point | undefined, b: Point | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

function useRouteIsCurrent(source: string, target: string, data: RoutedData | undefined): boolean {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!data?.route || !data.anchors) return false;
  return (
    same(sourceNode?.internals.positionAbsolute, data.anchors.source) &&
    same(targetNode?.internals.positionAbsolute, data.anchors.target)
  );
}

function geometry(route: Point[] | undefined, props: EdgeProps<RoutedFlowEdge>) {
  if (route) return { path: roundedPath(route), label: labelPoint(route) };
  const [path, x, y] = getBezierPath(props);
  return { path, label: { x, y } };
}

/** Draws the ELK route; falls back to a bezier once the user drags an endpoint. */
export function RoutedEdge(props: EdgeProps<RoutedFlowEdge>) {
  const { data, source, target, style, markerEnd } = props;
  const current = useRouteIsCurrent(source, target, data);
  const { path, label } = geometry(current ? data?.route : undefined, props);
  return (
    <>
      <BaseEdge path={path} {...(style ? { style } : {})} {...(markerEnd ? { markerEnd } : {})} />
      {data?.text && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {data.text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { routed: RoutedEdge };
