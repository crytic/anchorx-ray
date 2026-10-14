import { useEffect, useState } from "react";
import {
  api,
  type AccountNode,
  type Edge,
  type ObservedChange,
  type PdaInfo,
  type TimelineItem,
  type XrayModel,
} from "./api.js";
import { bytes, KIND_LABEL, leaf, sol, when } from "./format.js";
import { Address, CopyButton, KindSwatch, Section, useNav } from "./common.js";
import { JsonTree } from "./JsonTree.js";
import { SharedAddresses } from "./SharedAddresses.js";

interface Props {
  model: XrayModel;
  account: AccountNode;
  timeline: TimelineItem[];
  /** Bumped whenever a live change arrives, to refetch history. */
  changeTick: number;
  onClose: () => void;
}

function Facts({ account, model }: { account: AccountNode; model: XrayModel }) {
  const program = model.programs.find((p) => p.id === account.address);
  return (
    <dl className="facts">
      <dt>Kind</dt>
      <dd>{KIND_LABEL[account.kind]}</dd>
      {account.owner && (
        <>
          <dt>Owner</dt>
          <dd>
            <Address address={account.owner} />
          </dd>
        </>
      )}
      <dt>Balance</dt>
      <dd>{sol(account.lamports)}</dd>
      <dt>Data</dt>
      <dd>{bytes(account.dataLen)}</dd>
      <dt>On curve</dt>
      <dd>{account.onCurve ? "yes (keypair address)" : "no (PDA address)"}</dd>
      {account.upgradeAuthority !== undefined && (
        <>
          <dt>Upgrade auth.</dt>
          <dd>
            {account.upgradeAuthority ? (
              <Address address={account.upgradeAuthority} />
            ) : (
              "none (immutable)"
            )}
          </dd>
        </>
      )}
      {program && (
        <>
          <dt>IDL</dt>
          <dd>
            {program.name} v{program.version} · {program.instructions.length} instructions ·{" "}
            {program.accountTypes.length} account types
          </dd>
        </>
      )}
    </dl>
  );
}

function SeedRow({ seed, index }: { seed: NonNullable<PdaInfo["seeds"]>[number]; index: number }) {
  return (
    <div className="seed">
      <span className="i">{index}</span>
      <span className="k">{seed.kind}</span>
      <span style={{ minWidth: 0 }}>
        {seed.path && <div className="mono faint">{seed.path}</div>}
        {seed.pubkey ? (
          <Address address={seed.pubkey} />
        ) : (
          <span className="mono">{seed.display}</span>
        )}
      </span>
    </div>
  );
}

function BumpChip({ pda }: { pda: PdaInfo }) {
  const canonical = pda.bump === pda.canonicalBump;
  return (
    <span className={`chip ${canonical ? "ok" : "bad"}`}>
      bump {pda.bump}
      {canonical ? " · canonical" : ` ≠ ${pda.canonicalBump}`}
    </span>
  );
}

function Pda({ pda }: { pda: PdaInfo }) {
  if (pda.status === "unresolved") {
    return (
      <Section title="PDA">
        <div className="muted">Off-curve, but no IDL seed template reproduces this address.</div>
      </Section>
    );
  }
  const method = pda.method === "transaction" ? "a transaction" : "account data";
  return (
    <Section title="PDA seeds" right={<BumpChip pda={pda} />}>
      <div className="muted" style={{ marginBottom: 8 }}>
        Verified from {method} · seeds of{" "}
        <span className="mono">
          {pda.source?.instruction}.{pda.source?.account}
        </span>
      </div>
      <div className="seeds">
        {pda.seeds?.map((seed, i) => (
          <SeedRow key={seed.hex + i} seed={seed} index={i} />
        ))}
      </div>
    </Section>
  );
}

function References({ title, edges, side }: { title: string; edges: Edge[]; side: "from" | "to" }) {
  if (edges.length === 0) return null;
  return (
    <Section title={title}>
      <div className="ref-list">
        {edges.map((edge) => (
          <div className="ref" key={edge.id}>
            <span className="label mono" title={edge.label}>
              {edge.label}
            </span>
            <span>
              <Address address={side === "to" ? edge.to : edge.from} />
              {edge.constrainedBy && (
                <span
                  className="chip ok"
                  title={`has_one in ${edge.constrainedBy.join(", ")}`}
                  style={{ marginLeft: 6 }}
                >
                  has_one
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Live changes of one account; the parent re-keys it on every change to refetch. */
function History({ address }: { address: string }) {
  const [history, setHistory] = useState<ObservedChange[]>([]);
  useEffect(() => {
    let live = true;
    void api.history(address).then(
      (h) => live && setHistory(h),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [address]);
  if (history.length === 0) return null;
  return (
    <Section title={`Live changes (${history.length})`}>
      {history.map((change) => (
        <div key={`${change.slot}-${change.at}`} style={{ marginBottom: 8 }}>
          <div className="faint">
            slot {change.slot} · {when(change.at)} · {change.diff.change}
          </div>
          {change.diff.lamports && (
            <div className="mono">
              lamports <span className="before">{change.diff.lamports.before}</span> →{" "}
              <span className="after">{change.diff.lamports.after}</span>
            </div>
          )}
          {change.diff.fields.map((f) => (
            <div className="mono" key={f.path}>
              {f.path} <span className="before">{leaf(f.before)}</span> →{" "}
              <span className="after">{leaf(f.after)}</span>
            </div>
          ))}
        </div>
      ))}
    </Section>
  );
}

function Transactions({ address, timeline }: { address: string; timeline: TimelineItem[] }) {
  const nav = useNav();
  const related = timeline.filter((t) =>
    t.instructions.some((ix) => ix.accounts.some((a) => a.address === address)),
  );
  if (related.length === 0) return null;
  return (
    <Section title={`Transactions (${related.length})`}>
      {related.slice(0, 12).map((t) => {
        const top =
          t.instructions.find(
            (i) => i.depth === 0 && i.accounts.some((a) => a.address === address),
          ) ?? t.instructions[0];
        const role = top?.accounts.find((a) => a.address === address)?.name;
        return (
          <button
            key={t.signature}
            className="row"
            type="button"
            style={{ padding: "6px 0" }}
            onClick={() => nav.selectTransaction(t.signature)}
          >
            <div className="row-top">
              <span className={`status ${t.success ? "ok" : "fail"}`} />
              <span className="row-title">{top?.name ?? "unknown"}</span>
              {role && <span className="chip">{role}</span>}
              <span className="faint" style={{ marginLeft: "auto" }}>
                slot {t.slot}
              </span>
            </div>
          </button>
        );
      })}
    </Section>
  );
}

export function Inspector({ model, account, timeline, changeTick, onClose }: Props) {
  const outgoing = model.edges.filter((e) => e.from === account.address && e.kind !== "owner");
  const incoming = model.edges.filter((e) => e.to === account.address && e.kind !== "owner");
  return (
    <aside className="inspector">
      <div className="panel-head">
        <div className="panel-title">
          <KindSwatch kind={account.kind} />
          {account.label}
          <button className="close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="mono muted" style={{ marginTop: 4, overflowWrap: "anywhere" }}>
          {account.address} <CopyButton text={account.address} />
        </div>
      </div>
      {account.findings.length > 0 && (
        <Section title="Findings">
          {account.findings.map((f) => (
            <div key={f.code + f.message} className={`finding ${f.severity}`}>
              <span>{f.severity === "warning" ? "⚠" : "ⓘ"}</span>
              <div>
                <div>{f.message}</div>
                <code>{f.code}</code>
              </div>
            </div>
          ))}
        </Section>
      )}
      <Section title="Account">
        <Facts account={account} model={model} />
      </Section>
      {account.pda && <Pda pda={account.pda} />}
      <SharedAddresses model={model} account={account} />
      {account.decoded !== undefined && (
        <Section title={`Data · ${account.typeName}`}>
          <JsonTree value={account.decoded} />
        </Section>
      )}
      {account.decodeError && (
        <Section title="Data">
          <div className="muted">{account.decodeError}</div>
        </Section>
      )}
      <References title="References" edges={outgoing} side="to" />
      <References title="Referenced by" edges={incoming} side="from" />
      <History key={`${account.address}#${changeTick}`} address={account.address} />
      <Transactions address={account.address} timeline={timeline} />
    </aside>
  );
}
