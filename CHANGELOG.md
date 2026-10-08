# Changelog

Notable changes per release. This plugin follows [semantic versioning](https://semver.org/):
a behavior change or bug fix bumps the patch, a new surface or config field bumps
the minor, and anything that breaks an existing config or on-disk layout bumps
the major.

## 0.2.0

Message-level deletion: the line A / line B pair from the project plan, with
their honest visibility boundaries.

### Added

- **Shadow (line A, reversible).** `POST /session-deleter/messages/shadow`
  appends one `developer/message` tombstone with empty content whose
  `surfaceOp: {op: "replace", startSeq, endSeq}` shadows one live surface
  node. The shipped backend's own fold (`foldSurface`) then shadows the
  target, and `deriveEventMessage` derives the tombstone to no LLM message at
  all — so the message leaves the model's context in the canonical way, using
  the same mechanism the shipped compaction flow uses (60 replacement events
  observed across real logs). The append-origin event stays in the log and on
  the human transcript by design: that is the surface's documented contract,
  not an omission. Undo (`/messages/unshadow`) truncates the log back to the
  byte offset recorded in the shadow marker, and refuses when the log moved
  on.
- **Truncate (line B, backup-restorable).** `POST
  /session-deleter/messages/truncate` removes every event after a chosen seq
  by rebuilding the artifact from its surviving frame-aligned prefix. The
  replaced tail is kept as a `.bak-<stamp>` backup; restore
  (`/messages/untruncate`) is a byte-exact replacement that consumes the
  backup, and is refused when the log grew since the cut. A truncation whose
  surviving prefix would leave a replacement tombstone dangling without its
  target is planned and refused before any write.
- **Message listing.** `GET /session-deleter/messages?sessionId=…` returns
  every surface-eligible message with live/shadowed/replacement status,
  shadowed-by links, and a text preview — the dry run for both operations.
- **Message manager overlay.** A new shell overlay lists the messages with
  shadow/unshadow/truncate actions and a two-step truncate confirmation;
  opened from the session picker's 「管理消息…」 entry. All new strings exist
  in both dictionaries.
- All message routes reuse the whole-session gates: the current session, a
  live session, and traversal-shaped ids are refused before any filesystem
  work, and every operation lands in the audit ledger.

### Design notes

- The tombstone is a `developer/message`, not the target's own type: a
  `tool/result` replacement is restricted by the shipped validator to
  content-only edits, so a tool result cannot shadow itself to nothing —
  such shadow requests are refused with `not-shadowable`, and removing tool
  results requires truncation, which removes their calls' whole tail.
- The surface fold rules are replicated in `lib/shadow-fold.js` because the
  plugin's ESM resolution cannot reach the profile's `@deepseek-ai/dsh-session`;
  `tools/verify-shadow.mjs` cross-checks the replica against the real package
  when it is resolvable, so drift is a test failure.

## 0.1.1

Bug fixes for the management entry points, plus one pre-existing translation bug
found while verifying them.

### Fixed

- **The two management entry points did nothing.** Both 「管理回收站」 (in the
  session picker) and 「打开管理页」 (in the confirmation dialog) called one helper
  that ran `ctx.layout.selectPanel("settings")` inside a bare `catch {}`. That is
  not a registered main panel: `selectPanel` only addresses a panel registered in
  the `sidebar.panellist` slot, whose shipped occupants are `plugins` and
  `dsh-market`, so the call threw, the catch swallowed it, and the click was a
  silent no-op. The Settings panel is shell-owned and exposes no client service
  that opens it from a third-party plugin, so both entries now open this plugin's
  own manage overlay, which renders the same body as the `settings.section`
  occupant — one component, so the two paths cannot drift apart. A best-effort
  shell navigation is still attempted first, as a courtesy for a build where that
  panel key does exist.
- **The dialog's cancel button rendered the literal text `dialog.cancel`.** The
  key was referenced by the call site but missing from both the `zh` and `en`
  dictionaries. This predates 0.1.1 and was not introduced by the fix above.

### Changed

- The version reported by `/health` is now read from `package.json` instead of
  being written out a second time in `lib/index.js`, so a release cannot bump one
  and forget the other. `GET /session-deleter/health` still reports the same
  `version` field.

### Verification

- `tools/verify-manage.mjs` (new): drives the real GUI — opens the picker from the
  sidebar-foot entry, clicks 「管理回收站」, and asserts the rendered counts equal
  what the routes return. An empty-but-mounted panel cannot pass.
- `tools/check-locale.mjs` (new): proves every `t("…")` key resolves in both
  dictionaries and that no key is shadowed by a duplicate. Wired into CI.
- `tools/harness.mjs` mints the GUI gate cookie in memory from this Harness home's
  own credential file when the environment supplies none, so the browser suites
  run without exporting a bearer credential by hand. `DSH_COOKIE_NAME` /
  `DSH_COOKIE_VALUE` still win when set.
- `tools/verify-http.mjs` now asserts `/health` reports the same version as
  `package.json`.

## 0.1.0

First release. Whole-session deletion, reversible by default.

- Moves a session's directory into a private recycle bin (`~/.dsh/session-trash/sessions`),
  restorable in one step; permanent deletion only on an explicit second
  confirmation.
- A dry-run plan before anything moves: the directory, its size, the log
  generations, what else is affected, and what residue stays behind.
- Five UI surfaces, including a persistent sidebar-foot entry that needs no
  hover, because DSH only draws a session row's "…" trigger while the pointer is
  over a non-current row.
- Eight HTTP routes under `/session-deleter`, an append-only audit ledger, and
  refusals for the current session, live sessions, and traversal-shaped ids.
