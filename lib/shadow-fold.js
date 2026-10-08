/**
 * Minimal surface fold, mirroring @deepseek-ai/dsh-session's canonical rules.
 *
 * The plugin cannot bare-import `@deepseek-ai/dsh-session` (its ESM resolution
 * starts at the source tree, not the profile's node_modules), so the fold rules
 * the shadow operations depend on are replicated here from the installed
 * 0.1.7-rc.1 source. `tools/verify-shadow.mjs` cross-checks this implementation
 * against the real package when it is resolvable, so drift between the two is
 * a test failure rather than a silent divergence.
 *
 * Scope: node tracking and replace validation only — exactly what planning a
 * tombstone needs. Message projections (`image/offload`) are out of scope and
 * reported as unsupported instead of being misread.
 */

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** Event types that require a projection interpreter this fold does not carry. */
const PROJECTION_REQUIRED_TYPES = new Set(['image/offload']);

function isEventSeq(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    value.op === 'replace' &&
    isEventSeq(value.startSeq) &&
    isEventSeq(value.endSeq)
  );
}

/**
 * Fold events into the live surface node list.
 *
 * @returns `{ nodes, shadowedBy }` where `shadowedBy` maps a shadowed seq to
 *   the replacement event's seq. Throws with a message mirroring the shipped
 *   validator when an event violates the canonical surface contract.
 */
export function foldNodes(events) {
  const nodes = [];
  const shadowedBy = new Map();
  for (const event of events) {
    // The log's first line is the `session` header record; it carries no seq
    // and never joins the surface. Anything else without a seq is malformed.
    if (!isEventSeq(event.seq)) {
      if (event.type === 'session' && event.seq === undefined) continue;
      throw new Error(`event of type "${event.type}" is missing a valid seq`);
    }
    const op = event.surfaceOp;
    if (PROJECTION_REQUIRED_TYPES.has(event.type)) {
      throw new Error(`event "${event.type}" at seq ${event.seq} requires a message projection this tool does not carry`);
    }
    if (!SURFACE_EVENT_TYPES.has(event.type)) {
      if (op !== undefined) {
        throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
      }
      continue; // log-only record: never changes the surface
    }
    if (op === undefined) {
      throw new Error(`session event "${event.type}" at seq ${event.seq} is surface-eligible and requires a surfaceOp marker`);
    }
    if (op === 'append') {
      nodes.push(event.seq);
      continue;
    }
    if (!isReplaceOp(op)) {
      throw new Error(`session event "${event.type}" at seq ${event.seq} carries an invalid replace surfaceOp`);
    }
    if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
      throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`);
    }
    const startIdx = nodes.indexOf(op.startSeq);
    if (startIdx === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
    const endIdx = nodes.indexOf(op.endSeq);
    if (endIdx === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
    if (startIdx > endIdx) {
      throw new Error(`surface replace: start seq ${op.startSeq} is after end seq ${op.endSeq}`);
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1);
    const sources = new Set(event.sourceEventSeqs ?? []);
    if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) {
      throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
    }
    if (sources.size !== (event.sourceEventSeqs?.length ?? 0) || (event.sourceEventSeqs !== undefined && event.sourceEventSeqs.length === 0)) {
      throw new Error(`surface replace at seq ${event.seq}: sourceEventSeqs must be unique and non-empty`);
    }
    const missing = shadowed.filter((seq) => !sources.has(seq));
    if (missing.length > 0) {
      throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
    }
    if (startIdx === 0 && shadowed.length === 1 && shadowed[0] === nodes[0]) {
      // Node 0 holds the system prompt; only a system/message over exactly that
      // node may rewrite it. This tool never plans such a rewrite.
      throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node');
    }
    for (const seq of shadowed) shadowedBy.set(seq, event.seq);
    nodes.splice(startIdx, shadowed.length, event.seq);
  }
  return { nodes, shadowedBy };
}

/**
 * The tombstone event that shadows one live surface node.
 *
 * A `developer/message` with empty content derives to no LLM message at all
 * (`deriveEventMessage` returns null for empty developer content), which is
 * what a deletion means on the model side. The type must not be the target's
 * `tool/result`: that type's replacement is restricted to content-only edits.
 *
 * @returns a complete tombstone event, not yet written anywhere.
 */
export function tombstoneFor(target, seq, time) {
  if (!SURFACE_EVENT_TYPES.has(target.type)) {
    throw new Error(`event at seq ${target.seq} is "${target.type}", which is not a surface message`);
  }
  if (target.type === 'tool/result') {
    throw new Error('tool/result shadows its model message but stays on the transcript; use truncation to remove it');
  }
  return {
    type: 'developer/message',
    seq,
    time,
    data: { message: { role: 'developer', content: [] } },
    sourceEventSeqs: [target.seq],
    surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
  };
}
