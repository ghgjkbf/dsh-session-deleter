/**
 * Minimal HTTP helpers for the plugin's own routes.
 *
 * The web server hands over a raw node request/response pair, so framing,
 * content type, and body limits are this plugin's responsibility.
 */

/** Largest JSON body accepted on a mutating route. */
const MAX_BODY_BYTES = 1 << 20;

/** Send one JSON response. */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Send a structured failure the client can pattern-match on. */
export function sendError(response, status, code, message, extra = {}) {
  sendJson(response, status, { ok: false, error: { code, message, ...extra } });
}

/** Reject a request whose method does not match, with a usable `Allow` header. */
export function requireMethod(request, response, allowed) {
  if (request.method === allowed) return true;
  response.writeHead(405, { allow: allowed, 'cache-control': 'no-store' });
  response.end();
  return false;
}

/**
 * Read a JSON request body.
 *
 * The limit is enforced while streaming so an oversized body is never fully
 * buffered. The socket is *not* destroyed to enforce it: killing the request
 * mid-upload surfaces at the caller as a bare connection reset instead of the
 * 413 the route means to send, so the remaining bytes are drained and the
 * refusal is delivered as a normal response.
 */
export async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      // Stop retaining bytes, but keep reading so the response can be written.
      overflow = true;
      chunks.length = 0;
      continue;
    }
    if (!overflow) chunks.push(chunk);
  }
  if (overflow) throw new HttpBodyError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpBodyError('request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpBodyError) throw error;
    throw new HttpBodyError(`request body is not valid JSON: ${error.message}`);
  }
}

/** A request-body problem the route layer turns into its own status. */
export class HttpBodyError extends Error {
  /**
   * @param message - operator-readable reason.
   * @param status - HTTP status the route should answer with; defaults to 400.
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'HttpBodyError';
    this.status = status;
  }
}

/** A request that named something the plugin refuses to act on. */
export class HttpRequestError extends Error {
  /**
   * @param message - operator-readable reason.
   * @param status - HTTP status to answer with.
   * @param code - machine-readable code the client can match on.
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
    this.code = code;
  }
}
