/**
 * dsh-session-deleter — host half.
 *
 * Gives the harness a way to delete what it has no API for deleting: a whole
 * stored session, and (later) individual messages inside one. Every destructive
 * step is either reversible (a rename into a private trash root) or explicitly
 * confirmed; nothing here removes bytes on a first, unreviewed request.
 *
 * Routes are served over the plugin's own exact paths on the harness web server,
 * so the browser half talks to this process directly, with no extra transport.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { hold, purge, reconcile, restore, TRASH_DIR_NAME } from './trash.js';
import { inventory, locate, trashBytes } from './sessions.js';
import { findStagingLitter } from './atomic.js';
import { record, tail, LEDGER_FILENAME } from './ledger.js';
import { assertSafeSessionId } from './paths.js';
import { HttpBodyError, readJsonBody, requireMethod, sendError, sendJson } from './http.js';

export const name = 'session-deleter';

/** Services the routes need; all are optional so the plugin mounts anywhere. */
export const inject = [];

/** Route prefix owned by this plugin. */
const BASE = '/session-deleter';

/** Defaults applied when the profile supplies no config row. */
const DEFAULTS = {
  enabled: true,
  /** Trash root; defaults beside the session root under the harness home. */
  trashRoot: null,
  /** Session root override; the harness default is `<home>/sessions`. */
  sessionRoot: null,
  /** Refuse to delete the session issuing the request. */
  protectCurrentSession: true,
  /** Refuse to delete a session the harness currently holds live. */
  refuseLiveSessions: true,
};

/** Resolve the harness home the way the launcher does. */
function harnessHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Resolve the session root.
 *
 * The shipped backend configures `dshHomePath('sessions')`, so that is the
 * default; an explicit config value always wins so a redeployed harness can
 * point this plugin at a shared or relocated root.
 */
function resolveRoot(cfg) {
  if (typeof cfg.sessionRoot === 'string' && cfg.sessionRoot.length > 0) return cfg.sessionRoot;
  return join(harnessHome(), 'sessions');
}

function resolveTrashRoot(cfg, sessionRoot) {
  if (typeof cfg.trashRoot === 'string' && cfg.trashRoot.length > 0) return cfg.trashRoot;
  return join(harnessHome(), TRASH_DIR_NAME, 'sessions');
}

/** Ledger path beside the trash root, so both share one state directory. */
function ledgerPath(trashRoot) {
  return join(trashRoot, '..', LEDGER_FILENAME);
}

/**
 * Build the live view of what can be deleted.
 *
 * Liveness is answered from the harness's own session store when that service is
 * mounted, and from the current process's session id as a fallback: a session
 * that is running has its log open for writing, so deleting it under the writer
 * would either fail or leave the writer appending to a path that no longer
 * exists.
 */
function activityOf(ctx, sessionId) {
  const current = process.env.DSH_SESSION_ID;
  const live = [];
  let sessions;
  try {
    sessions = ctx.get('sessions');
  } catch {
    sessions = undefined;
  }
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      if (sessions.get(sessionId) !== undefined) live.push('session store holds it live');
    } catch {
      /* Store lookup is advisory; never fail a report over it. */
    }
  }
  if (typeof current === 'string' && current === sessionId) live.push('this is the session issuing the request');
  return { live, isCurrent: current === sessionId };
}

/** A human-readable byte count. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Compose the dry-run plan for deleting one whole session.
 *
 * The plan names every consequence a caller would otherwise discover after the
 * fact: which files move, how large they are, whether the harness still holds
 * the session, and which side records keep mentioning it.
 */
async function planWholeSession(ctx, state, sessionId) {
  // A session id becomes a path segment, so an id shaped like a traversal is
  // refused here rather than being allowed to reach the filesystem. It is a
  // malformed request, not a plugin fault, so the caller answers 400.
  try {
    assertSafeSessionId(sessionId);
  } catch (error) {
    return { ok: false, error: { code: 'unsafe-id', message: error.message } };
  }
  const found = await locate(state.sessionRoot, sessionId);
  if (found === undefined) {
    return { ok: false, error: { code: 'not-found', message: `no stored session "${sessionId}"` } };
  }
  const generations = found.generations;
  let bytes = 0;
  for (const generation of generations) {
    bytes += await stat(generation.path).then((s) => s.size).catch(() => 0);
  }
  const activity = activityOf(ctx, sessionId);
  const staging = await findStagingLitter(found.dir).catch(() => []);

  const blockers = [];
  if (state.cfg.protectCurrentSession && activity.isCurrent) {
    blockers.push('protected: the session asking for deletion cannot delete itself');
  }
  if (state.cfg.refuseLiveSessions && activity.live.length > 0) {
    blockers.push(`active: ${activity.live.join('; ')}`);
  }
  if (staging.length > 0) {
    blockers.push(`litter: ${staging.length} unfinished staging file(s) inside the directory`);
  }

  return {
    ok: true,
    plan: {
      kind: 'session',
      sessionId,
      title: found.row?.title ?? '',
      cwd: found.row?.cwd ?? null,
      dir: found.dir,
      bytes,
      humanBytes: humanBytes(bytes),
      generations: generations.map((generation) => generation.filename),
      trashRoot: state.trashRoot,
      reversible: true,
      blockers,
      consequences: [
        'the session disappears from the sidebar and from every listing',
        'its log files move into the recycle bin; the bytes are still on disk',
        'restoring moves the directory back to its original path',
      ],
      residue: [
        'workspace membership may keep a dangling id until the sidebar rebuilds',
        'a cached projection row for this session may remain until it is rebuilt',
        'if another session referenced this one as a subagent child, that reference is not rewritten',
      ],
    },
  };
}

/** Move one whole session directory into the trash. */
async function deleteWholeSession(ctx, state, sessionId, options) {
  const planned = await planWholeSession(ctx, state, sessionId);
  if (planned.ok !== true) return planned;
  const plan = planned.plan;
  if (plan.blockers.length > 0 && options.force !== true) {
    return {
      ok: false,
      error: { code: 'blocked', message: plan.blockers.join('; '), blockers: plan.blockers },
    };
  }

  await record(state.ledger, {
    op: 'session/delete',
    phase: 'begin',
    sessionId,
    dir: plan.dir,
    bytes: plan.bytes,
    generations: plan.generations,
  });

  try {
    const entry = await hold({
      trashRoot: state.trashRoot,
      dir: plan.dir,
      sessionId,
      title: plan.title,
      cwd: plan.cwd,
      bytes: plan.bytes,
      generations: plan.generations,
    });
    await record(state.ledger, {
      op: 'session/delete',
      phase: 'done',
      sessionId,
      trashId: entry.id,
      held: entry.held,
    });
    return { ok: true, result: { sessionId, trashId: entry.id, held: entry.held, bytes: plan.bytes, reversible: true } };
  } catch (error) {
    await record(state.ledger, { op: 'session/delete', phase: 'failed', sessionId, message: error.message });
    return { ok: false, error: { code: 'io', message: error.message } };
  }
}

/** Register every route this plugin serves. */
function registerRoutes(host, state) {
  const routes = [
    {
      path: `${BASE}/health`,
      label: 'session-deleter: health',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        sendJson(response, 200, {
          ok: true,
          name,
          version: '0.1.0',
          sessionRoot: state.sessionRoot,
          trashRoot: state.trashRoot,
          currentSessionId: process.env.DSH_SESSION_ID ?? null,
        });
      },
    },
    {
      path: `${BASE}/inventory`,
      label: 'session-deleter: inventory',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        try {
          const url = new URL(request.url, 'http://localhost');
          const withTitles = url.searchParams.get('titles') !== '0';
          const { rows, projects } = await inventory(state.sessionRoot, { withTitles });
          const trash = await trashBytes(state.trashRoot);
          const currentSessionId = process.env.DSH_SESSION_ID ?? null;
          const decorated = rows.map((row) => {
            const activity = activityOf(host, row.sessionId);
            return {
              ...row,
              isCurrent: activity.isCurrent,
              live: activity.live.length > 0,
            };
          });
          sendJson(response, 200, {
            ok: true,
            sessionRoot: state.sessionRoot,
            trashRoot: state.trashRoot,
            currentSessionId,
            projects,
            trash,
            sessions: decorated,
          });
        } catch (error) {
          sendError(response, 500, 'inventory-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/plan`,
      label: 'session-deleter: plan',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        try {
          const url = new URL(request.url, 'http://localhost');
          const sessionId = url.searchParams.get('sessionId');
          if (sessionId === null || sessionId.length === 0) {
            sendError(response, 400, 'missing-session-id', 'sessionId query parameter is required');
            return;
          }
          const planned = await planWholeSession(host, state, sessionId);
          if (planned.ok !== true) {
            sendError(response, planned.error.code === 'unsafe-id' ? 400 : 404, planned.error.code, planned.error.message);
            return;
          }
          sendJson(response, 200, planned);
        } catch (error) {
          sendError(response, 500, 'plan-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/delete`,
      label: 'session-deleter: delete',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        try {
          const body = await readJsonBody(request);
          const sessionId = body.sessionId;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            sendError(response, 400, 'missing-session-id', 'body must carry a sessionId string');
            return;
          }
          const result = await deleteWholeSession(host, state, sessionId, { force: body.force === true });
          if (result.ok !== true) {
            const status = result.error.code === 'not-found' ? 404
              : result.error.code === 'blocked' ? 409
                : result.error.code === 'unsafe-id' ? 400
                  : 500;
            sendError(response, status, result.error.code, result.error.message, {
              blockers: result.error.blockers,
            });
            return;
          }
          sendJson(response, 200, result);
        } catch (error) {
          if (error instanceof HttpBodyError) {
            sendError(response, error.status, 'bad-body', error.message);
            return;
          }
          sendError(response, 500, 'delete-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/trash`,
      label: 'session-deleter: trash',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        try {
          const view = await reconcile(state.trashRoot);
          const sizes = new Map();
          for (const entry of view.entries) {
            sizes.set(entry.id, await trashBytes(entry.held).catch(() => ({ bytes: 0, count: 0 })));
          }
          sendJson(response, 200, {
            ok: true,
            trashRoot: state.trashRoot,
            corrupt: view.corrupt,
            orphans: view.orphans,
            missing: view.missing,
            entries: view.entries.map((entry) => ({
              ...entry,
              heldBytes: sizes.get(entry.id)?.bytes ?? 0,
              humanBytes: humanBytes(sizes.get(entry.id)?.bytes ?? 0),
            })),
          });
        } catch (error) {
          sendError(response, 500, 'trash-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/restore`,
      label: 'session-deleter: restore',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        // Captured outside the try so a failure can name the entry it lost to
        // in the ledger even when the throw happened after the id was read.
        let id;
        try {
          const body = await readJsonBody(request);
          id = body.id;
          if (typeof id !== 'string' || id.length === 0) {
            sendError(response, 400, 'missing-id', 'body must carry a trash entry id');
            return;
          }
          await record(state.ledger, { op: 'session/restore', phase: 'begin', trashId: id });
          const path = await restore(state.trashRoot, id);
          await record(state.ledger, { op: 'session/restore', phase: 'done', trashId: id, path });
          sendJson(response, 200, { ok: true, restored: path });
        } catch (error) {
          if (error instanceof HttpBodyError) {
            sendError(response, error.status, 'bad-body', error.message);
            return;
          }
          await record(state.ledger, { op: 'session/restore', phase: 'failed', trashId: id, message: error.message }).catch(() => {});
          sendError(response, 409, 'restore-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/purge`,
      label: 'session-deleter: purge',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        let id;
        try {
          const body = await readJsonBody(request);
          id = body.id;
          if (typeof id !== 'string' || id.length === 0) {
            sendError(response, 400, 'missing-id', 'body must carry a trash entry id');
            return;
          }
          if (body.confirm !== true) {
            sendError(response, 400, 'confirmation-required', 'permanent deletion needs confirm: true');
            return;
          }
          await record(state.ledger, { op: 'session/purge', phase: 'begin', trashId: id });
          const entry = await purge(state.trashRoot, id);
          await record(state.ledger, { op: 'session/purge', phase: 'done', trashId: id, bytes: entry.bytes });
          sendJson(response, 200, { ok: true, purged: id, bytes: entry.bytes ?? 0 });
        } catch (error) {
          if (error instanceof HttpBodyError) {
            sendError(response, error.status, 'bad-body', error.message);
            return;
          }
          await record(state.ledger, { op: 'session/purge', phase: 'failed', trashId: id, message: error.message }).catch(() => {});
          sendError(response, 409, 'purge-failed', error.message);
        }
      },
    },
    {
      path: `${BASE}/ledger`,
      label: 'session-deleter: ledger',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        try {
          const url = new URL(request.url, 'http://localhost');
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
          const entries = await tail(state.ledger, Number.isFinite(limit) ? limit : 200);
          sendJson(response, 200, { ok: true, ledger: state.ledger, entries });
        } catch (error) {
          sendError(response, 500, 'ledger-failed', error.message);
        }
      },
    },
  ];

  const handles = [];
  for (const route of routes) {
    try {
      handles.push(host.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }));
    } catch (error) {
      // A duplicate (kind, path) throws, and the raw message names only the
      // path. Release whatever was already claimed first, so a failed mount
      // leaves no half-registered plugin holding paths it no longer serves.
      for (const handle of handles) disposeRoute(handle);
      throw new Error(`session-deleter: cannot register "${route.label}" at ${route.path}: ${error.message}`);
    }
  }
  return handles;
}

/**
 * Release a route handle.
 *
 * `webServer.register` returns the disposer function directly, which is exactly
 * what `ctx.effect` expects to collect; the object shape is tolerated so a
 * wrapped handle from another server implementation still unloads cleanly.
 */
function disposeRoute(handle) {
  if (typeof handle === 'function') handle();
  else if (handle !== null && typeof handle === 'object') handle.dispose?.();
}

/**
 * Mount the plugin.
 *
 * The routes are declared inside an effect so unloading the plugin releases its
 * paths, and the trash root is created lazily by the first deletion rather than
 * at mount, so merely enabling the plugin writes nothing.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (cfg.enabled === false) return;

  const sessionRoot = resolveRoot(cfg);
  const trashRoot = resolveTrashRoot(cfg, sessionRoot);
  const state = { cfg, sessionRoot, trashRoot, ledger: ledgerPath(trashRoot) };

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const handles = registerRoutes(host, state);
      return () => {
        for (const handle of handles) {
          try {
            disposeRoute(handle);
          } catch {
            /* Unload must not fail over one route that already went away. */
          }
        }
      };
    }, 'session-deleter: routes');
  });
}

/** Exported for the verification tools; not part of the plugin contract. */
export const internals = { harnessHome, resolveRoot, resolveTrashRoot, planWholeSession, humanBytes };
