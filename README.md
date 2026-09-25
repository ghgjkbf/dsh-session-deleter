# dsh-session-deleter

Delete what the harness gives no API for deleting: a whole stored Session — and
a Session's contents — from the DSH web UI. Deletion is a **move to a private
recycle bin**; bytes leave the disk only on an explicit, separately confirmed
permanent delete.

## Why this exists

`@deepseek-ai/dsh-session-persistence-jsonl` offers `create`/`open`/`flush`/
`stat`/`list` and nothing else, so the UI can archive a Session but never remove
one. The sidebar keeps its row until the next Workspace write prunes the id, the
`subagent/catalog` is append-only so a child cannot be dropped by appending, and
no client-side service exposes a delete. This plugin adds the missing operation
without touching the harness.

## What it does

Three operations, reachable from the UI:

- **Delete a whole Session** — moves the Session's entire directory (every log
  generation) into the recycle bin. Reversible.
- **Restore** — moves a held directory back to its original path. It refuses to
  overwrite an occupied path rather than guessing.
- **Delete permanently** — the only irreversible step, and the only one that
  reclaims disk space. Requires a second, explicit click (or `confirm: true`).

## Where it appears in the UI

| Surface | Slot | Position |
| --- | --- | --- |
| Sidebar foot, beside Settings | `sidebar.footer.action` | `order: 20` — always visible, no hover needed |
| Session picker dialog | `shell.overlay` | opened by the footer entry |
| A Session's "..." menu | `sidebar.workspaces.session.menu.item` | `order: 500`, after the shipped pin/rename/fork/archive rows |
| Confirmation dialog | `shell.overlay` | frame-wide floating layer |
| Management page | `settings.section` | `order: 50` in Settings |
| Management page (same body) | `shell.overlay` | `order: 5` — the in-plugin manage overlay, see below |

The sidebar-foot entry is the primary door and it does not depend on hover:
DSH only draws a Session row's "..." trigger while the pointer is over a
*non-current* row, so a reader who never hovers sees no sign the plugin exists.
The picker it opens lists every deletable session itself, and a running or
current session is shown but not deletable.

The management page renders in two places from one component. The shell owns the
Settings panel and exposes **no client service** that opens it: `layout.selectPanel(id)`
only addresses a main panel registered in the `sidebar.panellist` slot (whose
shipped occupants are `plugins` and `dsh-market`), and selecting an unregistered
key throws. So the in-plugin entries that promise "manage" — the picker's
「管理回收站」 and the dialog's 「打开管理页」 — open the manage overlay, which
renders the same body. A best-effort `selectPanel("settings")` is still attempted
first, purely as a courtesy for a build where that key does exist.

Both dialogs are dry runs first: the plan shows the directory, the size, the log
generations, what else is affected, and what residue stays behind — before
anything moves.

## Design commitments

**Reversible by default.** A first request never removes bytes. `rename` into
the recycle bin is atomic on one filesystem and is the whole of the destructive
work.

**Nothing the backend cannot read afterwards.** Rewrites re-emit one checksummed
Zstandard frame per durable batch. The `.jsonl.zstd` artifact is a
*concatenation of independently decodable frames*, not one stream — so a single
recompressed stream would decode to the right bytes yet stop matching the
backend's structural scanner on the next append.

**Multi-generation aware.** Session directories legitimately hold a `v3` log, a
`v4` log, or both. Nothing here hardcodes a filename.

**Refuses what it cannot safely do.** A running Session's log is open for
writing, so it is refused rather than deleted under its writer. The Session
issuing the request cannot delete itself. A Session id is a path segment, so
traversal-shaped ids are rejected before reaching the filesystem.

## Host routes

Served on the harness web server under `/session-deleter`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Roots in effect and the current Session id |
| GET | `/inventory` | Every stored Session, with bytes, generations, titles |
| GET | `/plan?sessionId=…` | Dry run: consequences, residue, blockers |
| POST | `/delete` | `{sessionId, force?}` → move into the recycle bin |
| GET | `/trash` | Held entries, orphan detection, size |
| POST | `/restore` | `{id}` → move back |
| POST | `/purge` | `{id, confirm: true}` → remove bytes |
| GET | `/ledger?limit=` | Append-only operation log |

## Configuration

Optional, supplied as the bundle row's `config`:

```yaml
- insert:
    - id: session-deleter
      name: 'dsh-session-deleter'
      config:
        sessionRoot: 'D:/somewhere/sessions'
        trashRoot: 'D:/somewhere/trash'
        protectCurrentSession: true
        refuseLiveSessions: true
```

Defaults: `sessionRoot` = `<DSH_HOME|~/.dsh>/sessions`, `trashRoot` =
`<home>/session-trash/sessions`.

## State on disk

- `<home>/session-trash/sessions/` — held directories, one per deletion, plus
  `manifest.json`.
- `<home>/session-trash/ledger.jsonl` — one append-only line per operation
  phase. A torn trailing line (a crash mid-append) is dropped on read rather
  than treated as corruption.

## Verification

Each check runs real filesystem and HTTP work against a sandbox copy of a real
session tree — no mocks of the plugin's own logic.

```
node tools/verify-host.mjs "$DSH_HOME/sessions"
node tools/verify-http.mjs
node tools/verify-client.mjs
node tools/check-locale.mjs     # static: t() keys vs both dictionaries
node tools/verify-frames.mjs <log> [<log> …]
node tools/verify-manage.mjs   # needs a browser + the gate cookie, see below
node tools/verify-ui.mjs       # same
node tools/verify-footer.mjs   # same
```

`verify-host` covers inventory/title parsing, the full hold → restore → purge
cycle, refusal paths (occupied path, purged entry, unknown entry), atomic
replacement backups, ledger durability, byte-exact frame round trips, and
traversal-shaped id rejection. `verify-http` mounts the plugin through a
`webServer` stub matching the shipped contract and drives all eight routes over
real HTTP. `verify-client` executes the browser bundle in a VM against a stub
module loader and asserts every slot registration. `check-locale` proves every
`t("…")` call resolves in both dictionaries (a missing key renders as the literal
key text) and that no key is shadowed by a duplicate. `verify-manage`,
`verify-ui`, and `verify-footer` drive the real GUI in Chrome and prove the
surfaces render, not merely register: `verify-manage` opens the picker from the
sidebar foot, clicks 「管理回收站」, and asserts the management view's rendered
counts equal what the routes return — an empty-but-mounted panel cannot pass.

Nothing machine-specific is committed. `tools/harness.mjs` discovers the browser
and `puppeteer-core` at run time, so the suites work on another machine; each
value has an override:

| Variable | Purpose |
| --- | --- |
| `DSH_URL` | GUI origin under test (default `http://127.0.0.1:3080`) |
| `DSH_COOKIE_NAME` / `DSH_COOKIE_VALUE` | The GUI gate cookie; overrides in-memory minting in the browser suites |
| `DSH_HOME` | Harness home whose credential file the cookie is minted from |
| `DSH_CHROME` | Chrome/Chromium binary |
| `DSH_PUPPETEER_CORE` | `puppeteer-core` entry module |
| `DSH_SHOTS_DIR` | Where screenshots land |
| `DSH_SESSIONS_DIR` | Source tree `verify-http` copies its fixture sessions from |
| `DSH_LAUNCHER` / `DSH_PLUGIN_DIR` | Used by `tools/restart-and-verify.ps1` |

The gate cookie is a bearer credential and is never written to this repository.
When `DSH_COOKIE_NAME`/`DSH_COOKIE_VALUE` are absent, `cookieForBaseUrl()` in
`tools/harness.mjs` mints one **in memory** from this Harness home's own
`.credentials.yaml` (`client-connection/browser-session`), signing it exactly as
`dsh-client-connection` does — payload `{version, authority, issuedAt, expiresAt}`
in milliseconds, HMAC-SHA256 over the base64url body with the **decoded 32-byte**
secret, and the name `dsh-auth-<base64url sha256(authority)>`. Nothing is printed
or persisted. The environment variables still win when set, so a run against a
remote host needs no local credential file.

## Uninstalling

Remove the bundle row and the package. Held directories stay in the recycle bin
and can be restored by hand — the manifest records each entry's original path.
