import { useEffect, useState } from "react";
import {
  api,
  type AccountNode,
  type QualificationReview,
  type QualificationView,
  type SharedAddress,
  type SharedAddressOccurrence,
  type XrayModel,
} from "./api.js";
import { Address, Section } from "./common.js";
import { short } from "./format.js";

function Occurrence({
  occurrence,
  selected,
}: {
  occurrence: SharedAddressOccurrence;
  selected: string;
}) {
  return (
    <div className="shared-occurrence">
      <span>
        {occurrence.account === selected ? (
          "This account"
        ) : (
          <Address address={occurrence.account} />
        )}
      </span>
      <span className="mono shared-path" title={occurrence.path}>
        {occurrence.path}
      </span>
      {occurrence.hasOneIn && (
        <span className="chip ok" title={`IDL has_one in ${occurrence.hasOneIn.join(", ")}`}>
          has_one
        </span>
      )}
    </div>
  );
}

const VERDICT_LABELS: Record<QualificationReview["verdict"], string> = {
  enforced: "Required by code",
  potential_gap: "Potential missing check",
  independent: "Independent fields",
  inconclusive: "Inconclusive",
};

function PatternReview({
  pattern,
}: {
  pattern: QualificationView["groups"][number]["patterns"][number];
}) {
  const { left, right, review } = pattern;
  return (
    <div className="qualification-review">
      <div className="mono shared-path">
        {left.typeName}.{left.path} ↔ {right.typeName}.{right.path}
      </div>
      <div className="faint">{pattern.matchedValues} matching address value(s) loaded</div>
      {review ? (
        <>
          <span className={`chip qualification-${review.verdict}`}>
            {VERDICT_LABELS[review.verdict]}
          </span>
          <div>{review.summary}</div>
          <details className="qualification-evidence">
            <summary>Scope and source ({review.evidence.length})</summary>
            <div>{review.scope}</div>
            {review.evidence.map((source) => (
              <div key={`${source.path}:${source.line}`}>
                <div className="mono">
                  {source.path}:{source.line}
                </div>
                <div className="muted">{source.note}</div>
              </div>
            ))}
          </details>
        </>
      ) : (
        <div className="faint">Awaiting Codex review</div>
      )}
    </div>
  );
}

function SharedGroup({
  group,
  selected,
  patterns,
}: {
  group: SharedAddress;
  selected: string;
  patterns: QualificationView["groups"][number]["patterns"];
}) {
  const own = group.occurrences.filter((item) => item.account === selected);
  const others = group.occurrences.filter((item) => item.account !== selected);
  const peerCount = new Set(others.map((item) => item.account)).size;
  return (
    <details className="shared-group">
      <summary>
        <span className="mono" title={group.value}>
          {short(group.value, 6)}
        </span>
        <span className="shared-path" title={own.map((item) => item.path).join(", ")}>
          {own.map((item) => item.path).join(", ")}
        </span>
        <span className="faint">
          {peerCount ? `${peerCount} other account(s)` : "same account"}
        </span>
      </summary>
      <div className="shared-detail">
        <Address address={group.value} full />
        {own
          .concat(others)
          .slice(0, 20)
          .map((item) => (
            <Occurrence
              key={`${item.account}:${item.path}`}
              occurrence={item}
              selected={selected}
            />
          ))}
        {group.occurrences.length > 20 && (
          <div className="faint">{group.occurrences.length - 20} more occurrences</div>
        )}
        {patterns.map((pattern) => (
          <PatternReview key={pattern.id} pattern={pattern} />
        ))}
      </div>
    </details>
  );
}

function useQualification(account: string, revision: string, enabled: boolean) {
  const key = `${account}:${revision}`;
  const [response, setResponse] = useState<{ key: string; value: QualificationView }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [loading, setLoading] = useState(false);
  const qualification = response?.key === key ? response.value : undefined;
  const error = failure?.key === key ? failure.message : undefined;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void api.qualification(account).then(
      (value) => {
        if (current) setResponse({ key, value });
      },
      (cause: Error) => {
        if (current) setFailure({ key, message: cause.message });
      },
    );
    return () => {
      current = false;
    };
  }, [account, enabled, key]);
  useEffect(() => {
    if (qualification?.phase !== "running") return;
    const timer = setInterval(() => {
      void api.qualification(account).then(
        (value) => setResponse({ key, value }),
        (cause: Error) => {
          setFailure({ key, message: cause.message });
        },
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [account, key, qualification?.phase]);
  const qualify = async () => {
    setLoading(true);
    setFailure(undefined);
    try {
      setResponse({ key, value: await api.qualify(account) });
    } catch (cause) {
      setFailure({ key, message: (cause as Error).message });
    } finally {
      setLoading(false);
    }
  };
  return { qualification, error, loading, qualify };
}

function QualificationButton({ state }: { state: ReturnType<typeof useQualification> }) {
  const { qualification, loading, qualify } = state;
  return (
    <button
      className="btn"
      type="button"
      disabled={loading || qualification?.phase === "running"}
      onClick={() => {
        void qualify();
      }}
    >
      {qualification?.phase === "complete" ? "Check source changes" : "Qualify with Codex"}
    </button>
  );
}

function QualificationProgress({ view }: { view: QualificationView | undefined }) {
  if (!view) return null;
  return (
    <span className="faint">
      <span>
        {view.completed}/{view.total} patterns reviewed
      </span>
      <span>
        {" "}
        · {view.loadedAccounts}/{view.catalogAccounts} accounts loaded
      </span>
    </span>
  );
}

function QualificationStatus({ state }: { state: ReturnType<typeof useQualification> }) {
  const { qualification, error } = state;
  const message = error ?? qualification?.error;
  return (
    <>
      <div className="qualification-controls">
        <QualificationButton state={state} />
        <QualificationProgress view={qualification} />
      </div>
      {message && <div className="finding warning">{message}</div>}
      {qualification?.phase === "running" && (
        <div className="faint shared-note">Codex is reviewing the source in read-only mode…</div>
      )}
    </>
  );
}

/** Exact typed address matches are observations; intent needs an on-chain code review. */
export function SharedAddresses({ model, account }: { model: XrayModel; account: AccountNode }) {
  const groups = model.sharedAddresses.filter((group) =>
    group.occurrences.some((item) => item.account === account.address),
  );
  const revision = `${model.slot}:${model.fetchedAt}:${model.accounts.length}`;
  const state = useQualification(account.address, revision, groups.length > 0);
  if (!account.decoded) return null;
  return (
    <Section title={`Shared addresses (${groups.length})`}>
      <p className="muted shared-note">
        Exact non-default Pubkey matches among loaded accounts. Codex can review each field-pair
        pattern once in local source code, then apply that review to every matching account.
        Matching test values alone do not prove a required equality.
      </p>
      {groups.length > 0 && <QualificationStatus state={state} />}
      {groups.length === 0 ? (
        <div className="faint">No matching Pubkey fields in loaded accounts.</div>
      ) : (
        <div className="shared-list">
          {groups.map((group) => (
            <SharedGroup
              key={group.value}
              group={group}
              selected={account.address}
              patterns={
                state.qualification?.groups.find((item) => item.value === group.value)?.patterns ??
                []
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}
