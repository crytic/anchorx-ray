import type { ReactNode } from "react";
import type { AccountDiff, Json } from "./api.js";
import { Address } from "./common.js";
import { leaf, signedSol } from "./format.js";

interface Row {
  label: string;
  before: Json | undefined;
  after: Json | undefined;
}

/** Owner, size and decoded-field changes as uniform before/after rows. */
function rowsOf(diff: AccountDiff): Row[] {
  const rows: Row[] = [];
  if (diff.owner) rows.push({ label: "owner", ...diff.owner });
  if (diff.dataLen) rows.push({ label: "data length", ...diff.dataLen });
  for (const f of diff.fields) rows.push({ label: f.path, before: f.before, after: f.after });
  return rows;
}

function ChangeRow({ row }: { row: Row }) {
  return (
    <tr>
      <td className="mono" style={{ width: "30%" }}>
        {row.label}
      </td>
      <td className="mono" style={{ overflowWrap: "anywhere" }}>
        {row.before !== undefined && <span className="before">{leaf(row.before)}</span>}
        {row.before !== undefined && row.after !== undefined && " → "}
        {row.after !== undefined && <span className="after">{leaf(row.after)}</span>}
      </td>
    </tr>
  );
}

/** One account's changes: lamports, owner, size and decoded fields. */
export function AccountChange({ diff, note }: { diff: AccountDiff; note?: ReactNode }) {
  const rows = rowsOf(diff);
  const lamports = diff.lamports && signedSol(diff.lamports.after - diff.lamports.before);
  return (
    <div className="card diff-account">
      <div className="diff-head">
        <span className={`change ${diff.change}`}>{diff.change}</span>
        <strong>{diff.typeName ?? "account"}</strong>
        <Address address={diff.address} name={false} />
        {note}
        {lamports && (
          <span className="mono muted" style={{ marginLeft: "auto" }}>
            {lamports}
          </span>
        )}
      </div>
      {(rows.length > 0 || diff.rawDataChanged) && (
        <table className="table">
          <tbody>
            {rows.map((row) => (
              <ChangeRow key={row.label} row={row} />
            ))}
            {diff.rawDataChanged && (
              <tr>
                <td colSpan={2} className="muted">
                  Raw bytes changed; no decoded field explains it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
