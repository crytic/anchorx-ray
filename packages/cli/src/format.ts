import type { SnapshotSummary, StateDiff, TimelineItem, XrayModel } from "@anchorx-ray/core";

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

function sol(lamports: number): string {
  return `${(lamports / 1e9).toFixed(9).replace(/\.?0+$/, "")} SOL`;
}

function signed(delta: number): string {
  return `${delta >= 0 ? "+" : "-"}${sol(Math.abs(delta))}`;
}

export function formatSummary(model: XrayModel): string {
  const lines = [
    `slot ${model.slot} · ${model.accounts.length} accounts · ${model.edges.length} edges`,
  ];
  for (const program of model.programs) {
    const owned = model.accounts.filter((a) => a.program === program.id).length;
    const state = program.deployed ? `${owned} accounts` : "not deployed";
    lines.push(`  ${program.name} ${program.id} (${state})`);
  }
  const findings = model.accounts.flatMap((a) => a.findings.map((f) => ({ a, f })));
  const warnings = findings.filter(({ f }) => f.severity === "warning");
  for (const { a, f } of warnings) lines.push(`  ! ${a.label} ${short(a.address)}: ${f.message}`);
  if (findings.length > warnings.length) {
    lines.push(
      `  ${findings.length - warnings.length} informational finding(s); see the UI or scan output`,
    );
  }
  return lines.join("\n");
}

function txHeadline(item: TimelineItem): string {
  const top = item.instructions.filter((i) => i.depth === 0);
  const names = top
    .map((i) => `${i.programName ?? short(i.programId)}.${i.name ?? "?"}`)
    .join(", ");
  const status = item.success ? "ok  " : "FAIL";
  return `${status} slot ${item.slot} ${short(item.signature)} ${names}`;
}

function errorLine(error: NonNullable<TimelineItem["error"]>): string {
  const msg = error.msg ? ` (${error.msg})` : "";
  return `     error: ${error.name ?? error.message}${msg}`;
}

function change(before: unknown, after: unknown): string {
  return `${JSON.stringify(before)} → ${JSON.stringify(after)}`;
}

function txDetails(item: TimelineItem): string[] {
  const cpis = item.instructions.filter((i) => i.depth > 0 && i.name);
  return [
    ...(item.error ? [errorLine(item.error)] : []),
    ...cpis.map(
      (ix) => `     ${"  ".repeat(ix.depth)}↳ ${ix.programName ?? short(ix.programId)}.${ix.name}`,
    ),
    ...item.events.map((event) => `     event ${event.name} ${JSON.stringify(event.data)}`),
    ...item.accountDiffs.map((diff) => {
      const fields = diff.fields.map((f) => `${f.path}: ${change(f.before, f.after)}`);
      return `     ${diff.typeName ?? "account"} ${short(diff.address)} ${fields.join("; ")}`;
    }),
  ];
}

export function formatTimeline(items: TimelineItem[]): string {
  if (items.length === 0) return "No transactions found for the loaded programs.";
  return items.flatMap((item) => [txHeadline(item), ...txDetails(item)]).join("\n");
}

export function formatDiff(diff: StateDiff): string {
  const lines = [
    `slot ${diff.from.slot} → ${diff.to.slot}: ${diff.accounts.length} account(s) changed`,
  ];
  for (const account of diff.accounts) {
    const sign = { added: "+", removed: "-", modified: "~" }[account.change];
    lines.push(`${sign} ${account.typeName ?? "account"} ${account.address}`);
    if (account.lamports) {
      lines.push(`    lamports ${signed(account.lamports.after - account.lamports.before)}`);
    }
    if (account.owner) lines.push(`    owner ${account.owner.before} → ${account.owner.after}`);
    for (const field of account.fields) {
      lines.push(
        `    ${field.path}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`,
      );
    }
    if (account.rawDataChanged) lines.push("    raw data changed (not decodable)");
  }
  return lines.join("\n");
}

export function formatSnapshots(list: SnapshotSummary[]): string {
  if (list.length === 0) return "No snapshots yet. Save one with: anchorx-ray snapshot <name>";
  return list
    .map(
      (s) =>
        `${s.name}\t${s.createdAt}\tslot ${s.slot}\t${s.accounts} accounts\t${s.transactions} txs`,
    )
    .join("\n");
}
