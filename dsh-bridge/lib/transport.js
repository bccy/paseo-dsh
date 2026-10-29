/**
 * Newline-delimited JSON-RPC 2.0 over byte streams.
 *
 * This is deliberately modelled on the shipped `dsh-sdk-protocol` transport,
 * but it exists as a local copy for two reasons:
 *
 * 1. `@deepseek-ai/dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` are not
 *    published at the runtime version and are not resolvable from a profile,
 *    so importing them would drag an unresolvable dependency into the profile.
 * 2. The Paseo bridge needs the *server -> client request* direction, which the
 *    shipped SDK transport supports but never exercises.
 *
 * @module dsh-paseo-bridge/transport
 */
import { StringDecoder } from 'node:string_decoder';

/**
 * A JSON-RPC error response, preserving the wire `code` and optional `data`.
 *
 * Internal on purpose: it is the rejection value for a failed server -> client
 * request (`paseo/question`), and no consumer outside this module catches it by
 * class — the caller only sees an Error, so exporting the type would advertise a
 * contract nobody reads.
 */
class JsonRpcResponseError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcResponseError';
    this.code = code;
    this.data = data;
  }
}

export class PaseoTransport {
  #input;
  #output;
  #decoder = new StringDecoder('utf8');
  /**
   * The chunks of the one inbound line currently being received, in order.
   *
   * Invariant: their concatenation contains no `\n`, so a new chunk is the only
   * place a terminator can be hiding. The line is joined exactly once, when it
   * completes.
   *
   * Two mechanics, and both are needed — this is the same defect
   * `paseo-plugin/server/frame-reader.ts` fixes on the plugin's side of the
   * same pipe, where it cost 56 s for one 39 MB frame:
   *
   * 1. **Scan only the new chunk.** The old reader re-`split('\n')` the whole
   *    accumulated buffer on every `data` event, so a frame that arrived in
   *    thousands of 16 KB chunks scanned its own length thousands of times. An
   *    inbound `session/prompt` carrying a phone photo is ~13 MiB of base64, and
   *    this process serves every session: 2.2 s of blocked event loop stalled
   *    all of them.
   * 2. **Accumulate into an array, never a growing string.** `buffer += chunk`
   *    plus `indexOf` on the result looks linear and is not: `+=` builds a V8
   *    rope and every `indexOf` starts by flattening the whole thing back into a
   *    string, which is the same O(n²) with a smaller constant.
   *
   * Behavior is unchanged, including the details that are easy to "improve"
   * into a regression: a blank line is skipped, a `\r` before the `\n` is kept
   * in the line (the caller's `trim()` is what removes it, exactly as before),
   * a trailing line without a newline stays pending forever, and an unparsable
   * line is reported on stderr instead of being swallowed.
   */
  #partial = [];
  #started = false;
  #closed = false;
  #requestHandler;
  #pending = new Map();
  #nextId = 1;

  constructor(input, output) {
    this.#input = input;
    this.#output = output;
  }

  /** Attach stream listeners and begin reading frames. Idempotent. */
  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#input.on('data', this.#onData);
    this.#input.on('error', this.#onError);
    this.#input.on('end', this.#onEnd);
  }

  /**
   * Detach listeners, mark the transport closed, and reject pending requests
   * without destroying streams.
   *
   * `#closed` used to be declared and checked but never set, so every "closed"
   * guard below was dead. Closing is final here: a later write would target a
   * surface the peer may already have torn down (the point of the flag), and
   * nothing restarts a closed transport. Idempotent, and safe before `start()`:
   * `off()` on streams that never got the listeners is a no-op, while the
   * pending-request drain still matters.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#input.off('data', this.#onData);
    this.#input.off('error', this.#onError);
    this.#input.off('end', this.#onEnd);
    this.#failPending(new Error('paseo bridge transport closed'));
  }

  /** Install the handler for client -> server requests, replacing any prior one. */
  onRequest(handler) {
    this.#requestHandler = handler;
  }

  /** Wait for prior frame write callbacks; the empty barrier emits no bytes. */
  flush() {
    return new Promise((resolve) => {
      this.#output.write('', () => resolve());
    });
  }

  /** Send a notification; omitted params produce no `params` member. */
  notify(method, params) {
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /**
   * Send a server -> client request and await its response.
   * @param method - JSON-RPC method name.
   * @param params - request parameters.
   * @param signal - optional abandonment signal; aborting drops the pending entry.
   */
  request(method, params, signal) {
    if (this.#closed) return Promise.reject(new Error('paseo bridge transport closed'));
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('aborted'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        entry.onAbort = () => {
          if (this.#pending.delete(id)) reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#pending.set(id, entry);
      this.#write({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  #release(entry) {
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }
  }

  #failPending(error) {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      this.#release(entry);
      entry.reject(error);
    }
  }

  #write(frame) {
    if (this.#closed) return;
    try {
      void this.#output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* a dead stdout surface must not take the runtime down */
    }
  }

  #onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    // `start` is the offset just past the last terminator found in THIS chunk;
    // the loop only ever looks forward, so no byte is scanned twice.
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      const piece = text.slice(start, newline);
      let line;
      if (this.#partial.length === 0) {
        // The common case: the whole frame was inside this one chunk.
        line = piece;
      } else {
        this.#partial.push(piece);
        line = this.#partial.join('');
        this.#partial = [];
      }
      start = newline + 1;
      this.#dispatchLine(line);
    }
    // Whatever follows the last newline starts the next frame. Deliberately no
    // trailing-`\r` strip: `trim()` in `#dispatchLine` covers it, and stripping
    // here would change the text logged for a malformed line.
    if (start < text.length) this.#partial.push(text.slice(start));
  };

  /** Route one complete, terminator-free line to the frame handlers. */
  #dispatchLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      // A frame the peer means us to act on is JSON by contract (one
      // JSON-RPC message per line). A torn or non-JSON line is therefore a
      // protocol bug, and dropping it silently turns a bug into a timeout on
      // the other side. Say so; never guess at a repair.
      process.stderr.write(`[bridge] dropped an unparseable JSON-RPC frame: ${trimmed.slice(0, 120)}\n`);
      return;
    }
    void this.#handleFrame(frame);
  }

  #onError = (error) => {
    this.#failPending(error);
  };

  #onEnd = () => {
    this.#failPending(new Error('paseo bridge input ended'));
  };

  async #handleFrame(frame) {
    if (frame === null || typeof frame !== 'object') return;
    const hasMethod = typeof frame.method === 'string';
    const hasId = frame.id !== undefined && frame.id !== null;
    if (hasMethod && hasId) return this.#handleIncomingRequest(frame);
    if (hasMethod) {
      // A notification (a method without an id) is legitimate JSON-RPC but has
      // no consumer on this side: Paseo's plugin sends every frame as a request
      // (`DshProcess` mints an id for each), and the protocol this repository
      // defines has no server-bound notifications. Tolerated and dropped — it
      // must never be answered, since that would send a response to a request
      // that never had an id.
      return;
    }
    if (hasId) return this.#handleIncomingResponse(frame);
  }

  async #handleIncomingRequest(frame) {
    try {
      if (this.#requestHandler === undefined) {
        throw new Error(`no request handler for ${frame.method}`);
      }
      const result = await this.#requestHandler(frame.method, frame.params ?? {});
      this.#write({ jsonrpc: '2.0', id: frame.id, result: result === undefined ? null : result });
    } catch (error) {
      this.#write({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  #handleIncomingResponse(frame) {
    const entry = this.#pending.get(frame.id);
    if (entry === undefined) return;
    this.#pending.delete(frame.id);
    this.#release(entry);
    if (frame.error !== undefined) {
      entry.reject(
        new JsonRpcResponseError(frame.error?.code, frame.error?.message ?? 'request failed', frame.error?.data),
      );
    } else {
      entry.resolve(frame.result);
    }
  }
}
