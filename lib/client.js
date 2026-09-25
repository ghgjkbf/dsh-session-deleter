/**
 * dsh-session-deleter — browser half.
 *
 * Hand-written module-loader bundle: the runtime executes this file directly, so
 * there is no build step and no JSX syntax — elements go through
 * `react/jsx-runtime` explicitly. Everything else (CSS, components, slot
 * registration) lives inside the factory closure, which materializes on first
 * import rather than at script evaluation.
 *
 * Three visible surfaces, so the plugin's operations are reachable from the UI
 * rather than only from its HTTP routes:
 *   - one row in a Session's "..." menu (the delete entry),
 *   - one frame-wide confirmation dialog (dry-run plan, then the reversible move),
 *   - one Settings page (full session list, recycle bin, ledger, permanent purge).
 */
window.__ModuleLoader__.load({
  id: "dsh-session-deleter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let jsxRuntime = require("react/jsx-runtime");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let j = jsxRuntime.jsx;
    let js = jsxRuntime.jsxs;

    //#region styles
    const CSS = `
      .dshsd-section{display:flex;flex-direction:column;gap:20px;padding:4px 0 32px}
      .dshsd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .dshsd-title{color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500}
      .dshsd-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:4px}
      .dshsd-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
      .dshsd-cardTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500}
      .dshsd-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
      .dshsd-row:last-child{border-bottom:none}
      .dshsd-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
      .dshsd-name{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshsd-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshsd-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:8px 0}
      .dshsd-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dshsd-warn{color:var(--dsw-alias-label-error,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}
      .dshsd-list{max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0 12px}
      .dshsd-plan{display:flex;flex-direction:column;gap:10px}
      .dshsd-kv{display:grid;grid-template-columns:88px 1fr;gap:4px 12px;font-size:12px;line-height:18px}
      .dshsd-k{color:var(--dsw-alias-label-tertiary)}
      .dshsd-v{color:var(--dsw-alias-label-secondary);word-break:break-all}
      .dshsd-ul{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dshsd-foot{display:flex;justify-content:flex-end;gap:8px}
      .dshsd-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
      .dshsd-foot-entry{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:8px;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:left}
      .dshsd-foot-entry:hover{background:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
      .dshsd-foot-entry:disabled{opacity:.5;cursor:default}
      .dshsd-foot-entry-rail{justify-content:center;padding:6px 0}
      .dshsd-foot-entry svg{flex:0 0 auto}
      .dshsd-foot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    `;
    const CSS_TAG_ID = "dsh-session-deleter/client.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-deleter";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region locale
    const NS = "session-deleter";

    const zh = {
      "menu.deleteSession": "移入回收站…",
      "menu.deleteSessionHint": "删除这个会话（可恢复）",
      "dialog.title": "删除会话",
      "dialog.close": "关闭",
      "dialog.loading": "正在生成删除计划…",
      "dialog.planTitle": "将要发生什么",
      "dialog.kv.session": "会话",
      "dialog.kv.dir": "目录",
      "dialog.kv.size": "大小",
      "dialog.kv.generations": "日志代际",
      "dialog.kv.trash": "回收站",
      "dialog.also": "同时影响",
      "dialog.residue": "仍然残留",
      "dialog.confirm": "移入回收站",
      "dialog.working": "正在移动…",
      "dialog.doneTitle": "已移入回收站",
      "dialog.doneBody": "会话目录已移到回收站，内容仍在磁盘上。可以在设置里的「会话删除」页恢复或彻底删除。",
      "dialog.trashId": "回收站条目",
      "dialog.openSettings": "打开管理页",
      "dialog.blocked": "暂时不能删除",
      "section.title": "会话删除",
      "section.sub": "回收站、可删除的会话、以及操作账本。默认删除是「移入回收站」，只有「彻底删除」才会真正抹掉字节。",
      "section.refresh": "刷新",
      "section.sessions": "磁盘上的会话",
      "section.sessionsSub": "删除即把整个会话目录移入回收站，可随时恢复。",
      "section.trash": "回收站",
      "section.trashSub": "恢复会把目录放回原位；彻底删除不可撤销。",
      "section.ledger": "操作账本",
      "section.ledgerSub": "每一次删除、恢复与彻底删除都会在这里留痕。",
      "section.empty.sessions": "没有可删除的会话。",
      "section.empty.trash": "回收站是空的。",
      "section.empty.ledger": "还没有任何操作记录。",
      "section.delete": "移入回收站",
      "section.restore": "恢复",
      "section.purge": "彻底删除",
      "section.purgeConfirm": "再次点击确认彻底删除",
      "section.cancel": "取消",
      "section.current": "当前会话",
      "section.live": "运行中",
      "section.protected": "受保护",
      "section.count": "项",
      "section.orphans": "未登记的回收站条目",
      "section.corrupt": "回收站清单损坏：恢复元数据不可用，目录仍然在磁盘上。",
      "section.busy": "处理中…",
      "section.trashUse": "回收站占用",
      "footer.open": "删除会话",
      "picker.title": "删除会话",
      "picker.sub": "选择一个会话移入回收站。删除可在「会话删除」页恢复。",
      "picker.empty": "没有可删除的会话。",
      "picker.current": "当前会话",
      "picker.live": "运行中",
      "picker.open": "删除…",
      "picker.manage": "管理回收站",
    };

    const en = {
      "menu.deleteSession": "Move to recycle bin…",
      "menu.deleteSessionHint": "Delete this session (recoverable)",
      "dialog.title": "Delete session",
      "dialog.close": "Close",
      "dialog.loading": "Building the deletion plan…",
      "dialog.planTitle": "What will happen",
      "dialog.kv.session": "Session",
      "dialog.kv.dir": "Directory",
      "dialog.kv.size": "Size",
      "dialog.kv.generations": "Log generations",
      "dialog.kv.trash": "Recycle bin",
      "dialog.also": "Also affected",
      "dialog.residue": "Still left behind",
      "dialog.confirm": "Move to recycle bin",
      "dialog.working": "Moving…",
      "dialog.doneTitle": "Moved to the recycle bin",
      "dialog.doneBody": "The session directory now sits in the recycle bin; its bytes are still on disk. Restore or permanently delete it from the Session Deleter settings page.",
      "dialog.trashId": "Recycle entry",
      "dialog.openSettings": "Open the management page",
      "dialog.blocked": "Cannot delete right now",
      "section.title": "Session Deleter",
      "section.sub": "Recycle bin, deletable sessions, and the audit ledger. Deletion moves a directory into the recycle bin; only permanent deletion removes bytes.",
      "section.refresh": "Refresh",
      "section.sessions": "Sessions on disk",
      "section.sessionsSub": "Deleting moves the whole session directory into the recycle bin, restorable at any time.",
      "section.trash": "Recycle bin",
      "section.trashSub": "Restore puts the directory back; permanent deletion cannot be undone.",
      "section.ledger": "Audit ledger",
      "section.ledgerSub": "Every deletion, restore, and purge is recorded here.",
      "section.empty.sessions": "No deletable sessions.",
      "section.empty.trash": "The recycle bin is empty.",
      "section.empty.ledger": "No operations recorded yet.",
      "section.delete": "Move to bin",
      "section.restore": "Restore",
      "section.purge": "Delete permanently",
      "section.purgeConfirm": "Click again to delete permanently",
      "section.cancel": "Cancel",
      "section.current": "Current session",
      "section.live": "Running",
      "section.protected": "Protected",
      "section.count": "items",
      "section.orphans": "Unrecorded recycle entries",
      "section.corrupt": "The bin manifest is corrupt: restore metadata is unavailable, but the directories are still on disk.",
      "section.busy": "Working…",
      "section.trashUse": "Bin size",
      "footer.open": "Delete a session",
      "picker.title": "Delete a session",
      "picker.sub": "Pick a session to move into the recycle bin. Deletion is restorable from the Session Deleter page.",
      "picker.empty": "No deletable sessions.",
      "picker.current": "Current session",
      "picker.live": "Running",
      "picker.open": "Delete…",
      "picker.manage": "Manage the recycle bin",
    };
    //#endregion

    //#region api
    /** Default ceiling for one host round-trip. */
    const REQUEST_TIMEOUT_MS = 30000;

    /** One failure result in the shape every caller already unwraps. */
    function failure(code, error) {
      const message = error && error.message ? error.message : String(error);
      return { ok: false, body: { ok: false, error: { code, message } } };
    }

    /**
     * Call this plugin's own host routes on the same origin.
     *
     * This never rejects. It is used inside stateful handlers that clear a busy
     * flag after awaiting it, so a rejected promise would strand that flag and
     * leave a spinner running forever — the caller must always get a result
     * object it can branch on. The timeout covers the body read as well as the
     * response headers, because a route that answers and then stalls mid-body
     * would otherwise hang exactly the same way.
     */
    async function apiJson(path, init, timeoutMs = REQUEST_TIMEOUT_MS) {
      const url = new URL(path, window.location.origin).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetch(url, {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
            ...init,
          });
        } catch (error) {
          return failure(error && error.name === "AbortError" ? "timeout" : "network", error);
        }
        let text;
        try {
          text = await response.text();
        } catch (error) {
          return failure(error && error.name === "AbortError" ? "timeout" : "unreadable", error);
        }
        let body;
        try {
          body = text.length > 0 ? JSON.parse(text) : {};
        } catch {
          body = { ok: false, error: { code: "bad-json", message: text.slice(0, 300) } };
        }
        return { ok: response.ok && body.ok === true, body };
      } finally {
        clearTimeout(timer);
      }
    }

    function postJson(path, payload) {
      return apiJson(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    /** Render any thrown value as one readable line. */
    function messageOf(body, fallback) {
      const error = body && body.error;
      if (error && typeof error.message === "string") return error.message;
      return fallback;
    }

    function humanBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
      const units = ["B", "KiB", "MiB", "GiB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
      const shown = value < 10 && unit > 0 ? value.toFixed(1) : String(Math.round(value));
      return `${shown} ${units[unit]}`;
    }
    //#endregion

    //#region shared dialog state
    /**
     * The delete dialog's state, shared by the menu row that opens it and the
     * frame-wide overlay that renders it. Both live in this same bundle, so one
     * module-level store is enough — no context plumbing across slot trees.
     */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(patch) {
          state = { ...state, ...patch };
          for (const listener of [...listeners]) listener();
        },
      };
    }

    const dialogStore = createStore({ open: false, sessionId: null, title: "" });

    function openDeleteDialog(sessionId, title) {
      dialogStore.set({ open: true, sessionId, title });
    }

    function closeDeleteDialog() {
      dialogStore.set({ open: false, sessionId: null, title: "" });
    }

    /** Ask the shell to open the Session Deleter settings page, when it can. */
    function openSettingsPage() {
      try {
        const layout = ctxRef.services && ctxRef.services.layout;
        if (layout && typeof layout.selectPanel === "function") layout.selectPanel("settings");
      } catch {
        /* Opening settings is a convenience; the section is reachable by hand. */
      }
    }

    const ctxRef = { services: null };
    //#endregion

    //#region components
    /**
     * Session "..." menu row (order 500, after the shipped archive row at 400):
     * opens the dry-run dialog for this row's session.
     */
    function DeleteSessionMenuItem(props) {
      const t = props.t;
      const useMenuOpenState = props.useMenuOpenState;
      const [, setMenuOpen] = useMenuOpenState();
      return j(primitives.MenuItemButton, {
        icon: j(primitives.IconTrashOutlineRegular, {}),
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          setMenuOpen(false);
          openDeleteDialog(props.sessionId, props.displayTitle);
        },
        children: t("menu.deleteSession"),
      });
    }

    /**
     * Frame-wide confirmation dialog: shows exactly what deletion touches before
     * anything moves, then performs the reversible step.
     */
    function DeleteSessionDialog(props) {
      const t = props.t;
      const state = react.useSyncExternalStore(dialogStore.subscribe, dialogStore.get);
      const [plan, setPlan] = react.useState(null);
      const [phase, setPhase] = react.useState("idle");
      const [error, setError] = react.useState(null);
      const [result, setResult] = react.useState(null);

      const sessionId = state.sessionId;
      react.useEffect(() => {
        if (!state.open || typeof sessionId !== "string") return undefined;
        let cancelled = false;
        setPlan(null);
        setError(null);
        setResult(null);
        setPhase("planning");
        apiJson(`/session-deleter/plan?sessionId=${encodeURIComponent(sessionId)}`).then(({ ok, body }) => {
          if (cancelled) return;
          if (!ok) {
            setPhase("failed");
            setError(messageOf(body, "could not build the deletion plan"));
            return;
          }
          setPlan(body.plan);
          setPhase("ready");
        });
        return () => { cancelled = true; };
      }, [state.open, sessionId]);

      if (!state.open) return null;

      const blocked = Array.isArray(plan && plan.blockers) && plan.blockers.length > 0;
      const busy = phase === "planning" || phase === "deleting";

      async function confirm() {
        setPhase("deleting");
        setError(null);
        const { ok, body } = await postJson("/session-deleter/delete", { sessionId, force: true });
        if (!ok) {
          setPhase("ready");
          setError(messageOf(body, "deletion failed"));
          return;
        }
        setResult(body.result);
        setPhase("done");
      }

      let body;
      if (phase === "done" && result !== null) {
        body = js("div", {
          className: "dshsd-plan",
          children: [
            j("div", { className: "dshsd-cardTitle", children: t("dialog.doneTitle") }),
            j("div", { className: "dshsd-note", children: t("dialog.doneBody") }),
            js("div", {
              className: "dshsd-kv",
              children: [
                j("div", { className: "dshsd-k", children: t("dialog.trashId") }),
                j("div", { className: "dshsd-v", children: result.trashId }),
              ],
            }),
          ],
        });
      } else if (phase === "failed") {
        body = j("div", { className: "dshsd-warn", children: error });
      } else if (plan === null) {
        body = j("div", { className: "dshsd-note", children: t("dialog.loading") });
      } else {
        body = js("div", {
          className: "dshsd-plan",
          children: [
            j("div", { className: "dshsd-cardTitle", children: t("dialog.planTitle") }),
            js("div", {
              className: "dshsd-kv",
              children: [
                j("div", { className: "dshsd-k", children: t("dialog.kv.session") }),
                j("div", { className: "dshsd-v", children: plan.sessionId }),
                j("div", { className: "dshsd-k", children: t("dialog.kv.dir") }),
                j("div", { className: "dshsd-v", children: plan.dir }),
                j("div", { className: "dshsd-k", children: t("dialog.kv.size") }),
                j("div", { className: "dshsd-v", children: `${plan.humanBytes} (${plan.bytes} B)` }),
                j("div", { className: "dshsd-k", children: t("dialog.kv.generations") }),
                j("div", { className: "dshsd-v", children: plan.generations.join(", ") }),
                j("div", { className: "dshsd-k", children: t("dialog.kv.trash") }),
                j("div", { className: "dshsd-v", children: plan.trashRoot }),
              ],
            }),
            plan.consequences.length > 0
              ? js("div", {
                  children: [
                    j("div", { className: "dshsd-note", children: t("dialog.also") }),
                    j("ul", { className: "dshsd-ul", children: plan.consequences.map((line) => j("li", { children: line })) }),
                  ],
                })
              : null,
            plan.residue.length > 0
              ? js("div", {
                  children: [
                    j("div", { className: "dshsd-note", children: t("dialog.residue") }),
                    j("ul", { className: "dshsd-ul", children: plan.residue.map((line) => j("li", { children: line })) }),
                  ],
                })
              : null,
            blocked
              ? js("div", {
                  children: [
                    j("div", { className: "dshsd-warn", children: t("dialog.blocked") }),
                    j("ul", { className: "dshsd-ul", children: plan.blockers.map((line) => j("li", { children: line })) }),
                  ],
                })
              : null,
            error !== null ? j("div", { className: "dshsd-warn", children: error }) : null,
          ],
        });
      }

      const footer = phase === "done"
        ? [
            j(primitives.Button, {
              key: "settings",
              variant: "outline",
              onClick: () => { closeDeleteDialog(); openSettingsPage(); },
              children: t("dialog.openSettings"),
            }),
            j(primitives.Button, {
              key: "close",
              variant: "primary",
              onClick: closeDeleteDialog,
              children: t("dialog.close"),
            }),
          ]
        : [
            j(primitives.Button, {
              key: "cancel",
              variant: "outline",
              onClick: closeDeleteDialog,
              children: t("dialog.cancel"),
            }),
            j(primitives.Button, {
              key: "confirm",
              variant: "primary",
              disabled: busy || plan === null,
              onClick: confirm,
              children: busy ? t("dialog.working") : t("dialog.confirm"),
            }),
          ];

      return j(primitives.Modal, {
        open: true,
        onClose: closeDeleteDialog,
        title: state.title || t("dialog.title"),
        closeLabel: t("dialog.close"),
        footer: j("div", { className: "dshsd-foot", children: footer }),
        children: body,
      });
    }

    /**
     * Settings page: the complete picture — every session on disk, the recycle
     * bin, and the audit ledger — so the plugin is manageable from the UI rather
     * than only from HTTP.
     */
    function SessionDeleterSection(props) {
      const t = props.t;
      const [inventory, setInventory] = react.useState(null);
      const [trash, setTrash] = react.useState(null);
      const [ledger, setLedger] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [notice, setNotice] = react.useState(null);
      const [pendingPurge, setPendingPurge] = react.useState(null);

      const refresh = react.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const [inv, bin, log] = await Promise.all([
            apiJson("/session-deleter/inventory"),
            apiJson("/session-deleter/trash"),
            apiJson("/session-deleter/ledger?limit=50"),
          ]);
          if (inv.ok) setInventory(inv.body); else setError(messageOf(inv.body, "inventory failed"));
          if (bin.ok) setTrash(bin.body); else setError(messageOf(bin.body, "recycle bin failed"));
          if (log.ok) setLedger(log.body.entries); else setError(messageOf(log.body, "ledger failed"));
        } catch (error) {
          // apiJson does not reject, so reaching here means a rendering bug.
          // Clear the busy flag anyway: a stuck spinner hides the real fault.
          setError(messageOf({ error }, "refresh failed"));
        } finally {
          setBusy(false);
        }
      }, []);

      react.useEffect(() => { refresh(); }, [refresh]);

      async function deleteSession(sessionId) {
        setBusy(true);
        setNotice(null);
        const { ok, body } = await postJson("/session-deleter/delete", { sessionId, force: true });
        setBusy(false);
        if (!ok) { setError(messageOf(body, "deletion failed")); return; }
        setNotice(`${sessionId} → ${body.result.trashId}`);
        await refresh();
      }

      async function restoreEntry(id) {
        setBusy(true);
        setNotice(null);
        const { ok, body } = await postJson("/session-deleter/restore", { id });
        setBusy(false);
        if (!ok) { setError(messageOf(body, "restore failed")); return; }
        setNotice(body.restored);
        setPendingPurge(null);
        await refresh();
      }

      async function purgeEntry(id) {
        if (pendingPurge !== id) { setPendingPurge(id); return; }
        setBusy(true);
        setNotice(null);
        const { ok, body } = await postJson("/session-deleter/purge", { id, confirm: true });
        setBusy(false);
        setPendingPurge(null);
        if (!ok) { setError(messageOf(body, "permanent deletion failed")); return; }
        setNotice(`${id}: ${humanBytes(body.bytes)}`);
        await refresh();
      }

      const sessions = (inventory && inventory.sessions) || [];
      const entries = (trash && trash.entries) || [];

      return js("div", {
        className: "dshsd-section",
        children: [
          js("div", {
            className: "dshsd-head",
            children: [
              js("div", {
                children: [
                  j("div", { className: "dshsd-title", children: t("section.title") }),
                  j("div", { className: "dshsd-sub", children: t("section.sub") }),
                ],
              }),
              j(primitives.Button, {
                variant: "outline",
                size: "sm",
                disabled: busy,
                onClick: refresh,
                children: busy ? t("section.busy") : t("section.refresh"),
              }),
            ],
          }),
          error !== null ? j("div", { className: "dshsd-warn", children: error }) : null,
          notice !== null ? j("div", { className: "dshsd-note", children: notice }) : null,
          trash && trash.corrupt ? j("div", { className: "dshsd-warn", children: t("section.corrupt") }) : null,
          js("div", {
            className: "dshsd-card",
            children: [
              js("div", {
                children: [
                  j("div", { className: "dshsd-cardTitle", children: `${t("section.sessions")} · ${sessions.length}` }),
                  j("div", { className: "dshsd-sub", children: t("section.sessionsSub") }),
                ],
              }),
              sessions.length === 0
                ? j("div", { className: "dshsd-empty", children: t("section.empty.sessions") })
                : j("div", {
                    className: "dshsd-list",
                    children: sessions.map((row) => {
                      const tags = [];
                      if (row.isCurrent) tags.push(t("section.current"));
                      else if (row.live) tags.push(t("section.live"));
                      return js("div", {
                        className: "dshsd-row",
                        key: row.sessionId,
                        children: [
                          js("div", {
                            className: "dshsd-rowMain",
                            children: [
                              j("div", { className: "dshsd-name", children: row.title || row.sessionId }),
                              j("div", {
                                className: "dshsd-meta",
                                children: `${row.sessionId} · ${humanBytes(row.bytes)} · v${row.currentVersion} · ${row.generations.map((g) => g.filename).join(", ")}`,
                              }),
                            ],
                          }),
                          tags.length > 0
                            ? j("span", { className: "dshsd-tag", children: tags.join(" / ") })
                            : null,
                          j(primitives.Button, {
                            variant: "ghost",
                            size: "sm",
                            disabled: busy || row.isCurrent,
                            onClick: () => deleteSession(row.sessionId),
                            children: t("section.delete"),
                          }),
                        ],
                      });
                    }),
                  }),
            ],
          }),
          js("div", {
            className: "dshsd-card",
            children: [
              js("div", {
                children: [
                  j("div", {
                    className: "dshsd-cardTitle",
                    children: `${t("section.trash")} · ${entries.length}${inventory && inventory.trash ? ` · ${humanBytes(inventory.trash.bytes)}` : ""}`,
                  }),
                  j("div", { className: "dshsd-sub", children: t("section.trashSub") }),
                ],
              }),
              trash && trash.orphans && trash.orphans.length > 0
                ? j("div", { className: "dshsd-warn", children: `${t("section.orphans")}: ${trash.orphans.join(", ")}` })
                : null,
              entries.length === 0
                ? j("div", { className: "dshsd-empty", children: t("section.empty.trash") })
                : j("div", {
                    className: "dshsd-list",
                    children: entries.map((entry) => js("div", {
                      className: "dshsd-row",
                      key: entry.id,
                      children: [
                        js("div", {
                          className: "dshsd-rowMain",
                          children: [
                            j("div", { className: "dshsd-name", children: entry.title || entry.sessionId }),
                            j("div", {
                              className: "dshsd-meta",
                              children: `${entry.id} · ${entry.from}`,
                            }),
                          ],
                        }),
                        j(primitives.Button, {
                          variant: "ghost",
                          size: "sm",
                          disabled: busy,
                          onClick: () => restoreEntry(entry.id),
                          children: t("section.restore"),
                        }),
                        j(primitives.Button, {
                          variant: pendingPurge === entry.id ? "primary" : "ghost",
                          size: "sm",
                          disabled: busy,
                          onClick: () => purgeEntry(entry.id),
                          children: pendingPurge === entry.id ? t("section.purgeConfirm") : t("section.purge"),
                        }),
                      ],
                    })),
                  }),
            ],
          }),
          js("div", {
            className: "dshsd-card",
            children: [
              js("div", {
                children: [
                  j("div", { className: "dshsd-cardTitle", children: `${t("section.ledger")} · ${ledger === null ? 0 : ledger.length}` }),
                  j("div", { className: "dshsd-sub", children: t("section.ledgerSub") }),
                ],
              }),
              ledger === null || ledger.length === 0
                ? j("div", { className: "dshsd-empty", children: t("section.empty.ledger") })
                : j("div", {
                    className: "dshsd-list",
                    children: ledger.slice().reverse().map((entry, index) => js("div", {
                      className: "dshsd-row",
                      key: `${entry.at}-${index}`,
                      children: [
                        js("div", {
                          className: "dshsd-rowMain",
                          children: [
                            j("div", { className: "dshsd-name", children: `${entry.op} · ${entry.phase}` }),
                            j("div", { className: "dshsd-meta", children: `${entry.at} ${entry.sessionId ?? ""} ${entry.trashId ?? ""} ${entry.message ?? ""}`.trim() }),
                          ],
                        }),
                      ],
                    })),
                  }),
            ],
          }),
        ],
      });
    }
    //#endregion

    /**
     * Session picker: the always-visible way in.
     *
     * The Session "..." menu only exists while a non-current row is hovered, so
     * it cannot be the only door — a reader who never hovers sees no evidence the
     * plugin is installed. This dialog is opened from a persistent sidebar-foot
     * button and lists every deletable session itself.
     */
    const pickerStore = createStore({ open: false });

    function openPicker() { pickerStore.set({ open: true }); }
    function closePicker() { pickerStore.set({ open: false }); }

    function DeleteSessionPicker(props) {
      const t = props.t;
      const state = react.useSyncExternalStore(pickerStore.subscribe, pickerStore.get);
      const [inventory, setInventory] = react.useState(null);
      const [error, setError] = react.useState(null);

      react.useEffect(() => {
        if (!state.open) return undefined;
        let cancelled = false;
        setInventory(null);
        setError(null);
        apiJson("/session-deleter/inventory").then(({ ok, body }) => {
          if (cancelled) return;
          if (!ok) { setError(messageOf(body, "inventory failed")); return; }
          setInventory(body);
        });
        return () => { cancelled = true; };
      }, [state.open]);

      if (!state.open) return null;

      const sessions = (inventory && inventory.sessions) || [];

      let body;
      if (error !== null) {
        body = j("div", { className: "dshsd-warn", children: error });
      } else if (inventory === null) {
        body = j("div", { className: "dshsd-note", children: t("dialog.loading") });
      } else if (sessions.length === 0) {
        body = j("div", { className: "dshsd-empty", children: t("picker.empty") });
      } else {
        body = js("div", {
          className: "dshsd-plan",
          children: [
            j("div", { className: "dshsd-note", children: t("picker.sub") }),
            j("div", {
              className: "dshsd-list",
              children: sessions.map((row) => {
                const tag = row.isCurrent ? t("picker.current") : row.live ? t("picker.live") : null;
                return js("div", {
                  className: "dshsd-row",
                  key: row.sessionId,
                  children: [
                    js("div", {
                      className: "dshsd-rowMain",
                      children: [
                        j("div", { className: "dshsd-name", children: row.title || row.sessionId }),
                        j("div", {
                          className: "dshsd-meta",
                          children: `${row.sessionId} · ${humanBytes(row.bytes)} · v${row.currentVersion}`,
                        }),
                      ],
                    }),
                    tag !== null ? j("span", { className: "dshsd-tag", children: tag }) : null,
                    j(primitives.Button, {
                      variant: "ghost",
                      size: "sm",
                      disabled: row.isCurrent,
                      onClick: () => { closePicker(); openDeleteDialog(row.sessionId, row.title || row.sessionId); },
                      children: t("picker.open"),
                    }),
                  ],
                });
              }),
            }),
          ],
        });
      }

      return j(primitives.Modal, {
        open: true,
        onClose: closePicker,
        title: t("picker.title"),
        closeLabel: t("dialog.close"),
        footer: j("div", {
          className: "dshsd-foot",
          children: [
            j(primitives.Button, {
              key: "manage",
              variant: "outline",
              onClick: () => { closePicker(); openSettingsPage(); },
              children: t("picker.manage"),
            }),
            j(primitives.Button, {
              key: "close",
              variant: "primary",
              onClick: closePicker,
              children: t("dialog.close"),
            }),
          ],
        }),
        children: body,
      });
    }

    /**
     * The persistent sidebar-foot button. Rendered in the rail (narrow) as an
     * icon alone, and beside Settings (wide) with its label.
     */
    function SessionDeleterFooterAction(props) {
      const t = props.t;
      const wide = props.wide === true;
      return j("button", {
        type: "button",
        className: wide ? "dshsd-foot-entry" : "dshsd-foot-entry dshsd-foot-entry-rail",
        title: t("footer.open"),
        "aria-label": t("footer.open"),
        onClick: openPicker,
        children: [
          j(primitives.IconTrashOutlineRegular, { key: "icon" }),
          wide ? j("span", { key: "label", className: "dshsd-foot-label", children: t("footer.open") }) : null,
        ],
      });
    }
    //#endregion

    //#region registration
    /** Required client services: the slot registry and the locale registry. */
    const inject = ["slots", "locale"];

    /**
     * Client plugin body: publish the dictionaries, then claim the delete entry
     * in a Session's "..." menu, the frame-wide confirmation dialog, and the
     * settings page.
     *
     * The menu row uses a package-namespaced id at order 500 so it lands after
     * the shipped rows (pin 100 / rename 200 / fork 300 / archive 400) instead of
     * shadowing one of them.
     */
    function apply(ctx) {
      ctxRef.services = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-deleter: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "session-deleter",
        order: 500,
        label: () => t("menu.deleteSession"),
        locale: NS,
      }, DeleteSessionMenuItem));

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "session-deleter.dialog",
        locale: NS,
      }, DeleteSessionDialog));

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "session-deleter",
        order: 50,
        label: () => t("section.title"),
        locale: NS,
      }, SessionDeleterSection));

      // The always-visible entry: a Session "..." row only exists while a
      // non-current row is hovered, so it cannot be the only way in.
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "session-deleter.delete",
        order: 20,
        label: () => t("footer.open"),
        locale: NS,
      }, SessionDeleterFooterAction));

      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "session-deleter.picker",
        order: 10,
        locale: NS,
      }, DeleteSessionPicker));
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    exports.DeleteSessionMenuItem = DeleteSessionMenuItem;
    return module.exports;
  },
});
