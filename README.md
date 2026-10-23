# anchorx-ray

See the on-chain state of your Anchor programs while you test them: every account they own,
the PDAs behind them, how accounts reference each other, and what each transaction changed.

![anchorx-ray graph view](docs/screenshot.png)

Point it at an Anchor workspace and a running cluster (usually `solana-test-validator`), and it:

- **Maps accounts.** Every account owned by your programs, decoded with the IDL and grouped
  by program. Edges follow `Pubkey` fields and PDA seeds. Fields with IDL `has_one`
  evidence are drawn differently to guide code review.
- **Shows shared addresses.** The account inspector groups equal `Pubkey` fields across loaded
  accounts, including nested fields. It shows the field paths and any IDL `has_one` evidence
  to guide a review of whether the equality is required by the on-chain program.
- **Qualifies shared addresses with Codex.** Click *Qualify with Codex* in the inspector to
  review field-pair patterns against local source. One review covers every loaded account
  with that pattern; the result includes instruction scope and source lines.
- **Re-derives PDAs.** Each off-curve account is checked against the IDL's `seeds`: first
  from the instructions that touched it, then from its own data. You see the seeds, the bump,
  and whether that bump is canonical.
- **Decodes transactions.** Instructions and CPIs with named accounts and arguments,
  `emit!`/`emit_cpi!` events, IDL and Anchor error names, balance changes and logs.
- **Watches live.** Subscribes over websocket, highlights accounts as they change, and shows
  field-level diffs next to the transaction that caused them.
- **Snapshots state.** Save the whole state (for example before a test), then diff it
  against another snapshot or the live cluster, field by field.
- **Flags anomalies.** Non-canonical or mismatched bumps, program-owned data that matches no
  IDL type, off-curve accounts no seed template explains, and fields that point at accounts
  that do not exist.

## Requirements

- Node.js 22 or later
- IDLs in the Anchor 0.30+ format (`metadata.spec`, as produced by `anchor build` since 0.30).
  Convert older IDLs with `anchor idl convert`.
- An RPC endpoint with your programs deployed. A local `solana-test-validator` works best: it
  serves transaction history and websocket subscriptions.
- For AI qualification, the Codex CLI must be installed and signed in with ChatGPT using
  `codex login`. This uses the subscription of the person running anchorx-ray.

## Usage

Build anchorx-ray from source (see [Development](#development)), then run it from your Anchor
workspace while the validator is up:

```sh
anchor build
solana-test-validator            # or: anchor localnet / anchor test --detach
node /path/to/anchorx-ray/packages/cli/dist/cli.mjs
```

It reads `target/idl/*.json`, takes program ids and the cluster from `Anchor.toml`, and opens
the UI at <http://127.0.0.1:3000>. The server listens on loopback only.

To switch between clusters in the UI, run one instance per cluster on different ports and link
them with `--peer <label:port>`:

```sh
anchorx-ray ui --cluster mainnet --port 3000 --peer Local:3001
anchorx-ray ui --cluster localnet --port 3001 --peer Mainnet:3000
```

Both instances need access to the workspace IDLs. The local instance also needs a running
validator with the programs and accounts you want to inspect.

```text
anchorx-ray [command] [options]

Commands:
  ui                     Scan, watch live changes and open the web UI (default)
  scan                   Print the account graph as JSON
  timeline               Print recent decoded transactions
  snapshot <name>        Save the current state as a named snapshot
  snapshots              List saved snapshots
  diff <from> [to]       Diff two snapshots; "live" (default for <to>) is the cluster now

Options:
  -w, --workspace <dir>  Anchor workspace root (default: current directory)
      --idl <file>       IDL file to load; repeatable (default: target/idl/*.json)
      --include <names>  Only inspect these programs (names or ids, comma-separated or repeated)
      --exclude <names>  Skip these programs
      --cluster <name>   localnet | devnet | testnet | mainnet | <url>
                         (default: [provider] cluster in Anchor.toml)
      --rpc <url>        RPC URL; overrides --cluster
      --ws <url>         Websocket URL (default: RPC port + 1)
      --tx-limit <n>     Recent transactions to load (default: 100)
      --max-accounts <n> Program accounts loaded with full data; the rest are listed and
                         can be loaded from the UI (default: 500)
  -p, --port <n>         Web UI port (default: 3000)
      --peer <label:port> Link to another local anchorx-ray UI; repeatable
      --no-open          Do not open a browser
      --no-watch         Do not subscribe to live updates
      --snapshot <name>  ui/scan/timeline: read a saved snapshot instead of the cluster
  -o, --out <file>       scan: write JSON to a file instead of stdout
      --json             timeline/snapshots/diff: print JSON
  -h, --help             Show this help
  -v, --version          Show the version

```

A typical test loop:

```sh
anchorx-ray snapshot before
anchor test --skip-local-validator
anchorx-ray diff before          # what the tests changed, account by account
```

Snapshots are JSON files under `.anchorx-ray/snapshots/` in the workspace. They hold raw
account data and transactions, so `--snapshot <name>` can reopen one without a cluster, for
example to share a failing state with a teammate.

### Large programs

anchorx-ray lists every account your programs own but reads only the first 8 bytes of each
(the discriminator), so a program with hundreds of thousands of accounts stays cheap to scan.
Full data is fetched for `--max-accounts` of them, picked round-robin across account types so
a rare type is never crowded out by a common one. The sidebar shows loaded/total per type,
with a button to load more. Pasting an unloaded address into the search box offers to load it.

The canvas folds a type with more than 24 accounts into a stack node, keeping the ones with
findings, the selected account and recently changed accounts visible. Click a stack to expand
it. Edges into a stack are merged and labeled with their count.

`--include`/`--exclude` restrict the scan to some programs of the workspace, by name or id.

Listing uses `getProgramAccounts`. Some public RPC providers restrict or disable it; use a
provider that allows it or a local validator.

## How it works

- **Account types** come from the IDL discriminators, so decoding never guesses by trying
  every layout.
- **PDA seeds** are recovered in two ways. For every decoded instruction, each account the IDL
  marks with `seeds` is re-derived from that instruction's accounts and arguments
  (`method: transaction`). Accounts that no loaded transaction touched are matched against the
  program's seed templates, using values from their own fields and from observed keys and
  arguments (`method: account-data`). A match is exact: the derived address must equal the
  account's address.
- **`has_one` edges** come from the IDL's `relations`. The IDL does not say which account type
  an instruction account has, so types are learned from transactions, falling back to Anchor's
  naming convention (`vault` → `Vault`).
- **Shared addresses** are exact matches between non-default typed `Pubkey` fields in loaded,
  decoded accounts. A match does not establish a required invariant. Missing `has_one` metadata does
  not show that Rust constraints, PDA seeds or handler checks are absent; test a mismatched
  address and inspect the relevant on-chain paths before treating it as a finding.
- **AI qualification** groups matches by program, account type and field path before calling
  Codex. Reviews run in read-only mode, in batches, and are cached by local source content and
  field-pair pattern. Verdicts describe the code path they cover; they are leads for manual
  verification, not proof about the deployed binary. The catalogue's unloaded accounts have
  no field values, so they are not part of the match count.
- **Live diffs** are attributed by slot: an account change is shown on the transactions of the
  same slot that could write that account. When several did, the diff is marked *shared slot*.
- **History** is limited by the RPC node. `solana-test-validator` prunes old slots
  (`--limit-ledger-size`), so on a long-running validator the oldest transactions disappear.

## Findings

| Code | Severity | Meaning |
| --- | --- | --- |
| `pda-noncanonical-bump` | warning | The account is a PDA for these seeds, but not at the canonical bump. |
| `pda-stored-bump-mismatch` | warning | The account's `bump` field differs from the bump that derives its address. |
| `undecodable-account` | warning | Program-owned data whose discriminator or layout matches no IDL account. |
| `pda-unresolved` | info | Off-curve, program-owned account that no seed template reproduces. |
| `dangling-reference` | info | A `Pubkey` field points to an account that does not exist on chain. |
| `program-not-deployed` | info | No executable account at the IDL's address. |

## Development

```sh
pnpm install
pnpm build            # web UI (Vite) + CLI bundle (tsdown) → packages/cli/dist
pnpm check            # oxlint, oxfmt, tsc, unit tests
```

The repository is a pnpm workspace:

- `packages/core`: IDL loading, decoding, PDA resolution, graph, timeline, snapshots, live session
- `packages/cli`: the `anchorx-ray` command and its HTTP/SSE server
- `packages/web`: the React + React Flow UI, laid out with ELK
- `examples/xray-demo`: two Anchor 1.2 programs that exercise PDAs, `has_one`, CPIs,
  events and errors

End-to-end tests start a real `solana-test-validator` with the example programs:

```sh
(cd examples/xray-demo && anchor build)
pnpm test:e2e         # skipped when solana-test-validator or the build is missing
pnpm demo             # seeded validator on :8899 to try the UI against
```

Unit tests run offline on a snapshot recorded by the e2e scenario
(`ANCHORX_RAY_WRITE_FIXTURE=1 pnpm test:e2e` refreshes it). For UI work, run the CLI against
the demo validator and `pnpm --filter @anchorx-ray/web dev`, which proxies `/api` to it.

## License

[AGPL-3.0](LICENSE)
