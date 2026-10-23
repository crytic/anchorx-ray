import type { AccountKind, EdgeKind, ProgramSummary, XrayModel } from "./api.js";
import { KindSwatch } from "./common.js";
import { EDGE_LABEL, EDGE_STYLE } from "./edgeStyle.js";
import { KIND_LABEL, looksLikeAddress } from "./format.js";
import type { Filters } from "./graph.js";

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

interface SidebarProps {
  model: XrayModel;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  onLoadMore: (program: string, typeName: string | null) => void;
  onLoadAddress: (address: string) => void;
}

/** Accounts fetched per "load more" click; the server caps a request at 2000. */
export const LOAD_STEP = 200;

function Inventory({
  program,
  onLoadMore,
}: {
  program: ProgramSummary;
  onLoadMore: SidebarProps["onLoadMore"];
}) {
  if (program.inventory.length === 0) return null;
  return (
    <div className="inventory">
      {program.inventory.map((row) => {
        const left = row.total - row.loaded;
        return (
          <div className="inv-row" key={row.typeName ?? "?"}>
            <span className="inv-type">{row.typeName ?? "unknown type"}</span>
            <span className="n">
              {left > 0
                ? `${row.loaded.toLocaleString()} / ${row.total.toLocaleString()}`
                : row.total.toLocaleString()}
            </span>
            {left > 0 && (
              <button
                className="btn tiny"
                type="button"
                title={`Load ${Math.min(LOAD_STEP, left)} more`}
                onClick={() => onLoadMore(program.id, row.typeName)}
              >
                +{Math.min(LOAD_STEP, left)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Search({ model, filters, onFilters, onLoadAddress }: Omit<SidebarProps, "onLoadMore">) {
  const query = filters.search.trim();
  const unknownAddress =
    looksLikeAddress(query) && !model.accounts.some((a) => a.address === query);
  return (
    <div>
      <input
        className="input"
        style={{ width: "100%" }}
        placeholder="Search address, type, label…"
        value={filters.search}
        onChange={(e) => onFilters({ ...filters, search: e.target.value })}
      />
      {unknownAddress && (
        <button
          className="btn tiny"
          type="button"
          style={{ marginTop: 6 }}
          onClick={() => onLoadAddress(query)}
        >
          Load this address
        </button>
      )}
    </div>
  );
}

export function Sidebar({ model, filters, onFilters, onLoadMore, onLoadAddress }: SidebarProps) {
  const kinds = [...new Set(model.accounts.map((a) => a.kind))].filter((k) => k !== "program");
  const count = (kind: AccountKind) => model.accounts.filter((a) => a.kind === kind).length;
  const findings = model.accounts.reduce((n, a) => n + a.findings.length, 0);
  return (
    <aside className="sidebar">
      <Search model={model} filters={filters} onFilters={onFilters} onLoadAddress={onLoadAddress} />
      <div>
        <h4 className="section-title">Programs</h4>
        {model.programs.map((p) => (
          <div key={p.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={!filters.hiddenPrograms.has(p.id)}
                onChange={() =>
                  onFilters({ ...filters, hiddenPrograms: toggle(filters.hiddenPrograms, p.id) })
                }
              />
              <KindSwatch kind="program" />
              {p.name}
            </label>
            <Inventory program={p} onLoadMore={onLoadMore} />
          </div>
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
        {filters.expanded.size > 0 && (
          <button
            className="btn tiny"
            type="button"
            style={{ marginTop: 6 }}
            onClick={() => onFilters({ ...filters, expanded: new Set() })}
          >
            Fold large types again
          </button>
        )}
      </div>
    </aside>
  );
}

export function Legend() {
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
