/**
 * dsh-session-deleter — message-level operations module.
 *
 * Line A (shadow) and line B (truncate) for single messages, backed by the
 * canonical surface fold rules replicated in shadow-fold.js. See shadow.js
 * for the operation semantics and their reversibility contract.
 */

export {
  planShadow,
  applyShadow,
  undoShadow,
  planTruncate,
  applyTruncate,
  restoreTruncate,
  SHADOWABLE_TYPES,
} from './shadow.js';
export { foldNodes, tombstoneFor } from './shadow-fold.js';
