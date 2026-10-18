/**
 * Newline-delimited JSON-RPC 2.0 transport for the DSH bridge.
 *
 * Wire format: one JSON-RPC 2.0 message per `\n`-terminated line over a pair of
 * caller-owned byte streams. A frame carrying both `id` and `method` is a
 * request, `id` alone is a response, and `method` alone is a notification.
 * Malformed lines are ignored (optionally reported via `onMalformedLine`);
 * request-handler failures become `-32603` error frames and an unhandled
 * request becomes `-32601`.
 *
 * This mirrors the semantics of the official
 * `@deepseek-ai/dsh-sdk-protocol` transport but is dependency-free (Node
 * built-ins only) so the gateway does not need the DSH npm packages.
 *
 * @module dsh-im-manager/bridge/jsonrpc
 */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/**
 * Error rejecting a request whose peer answered with a JSON-RPC error frame.
 * The wire `code` and optional `data` are preserved verbatim.
 */
export class JsonRpcResponseError extends Error {
  /**
   * @param {number | undefined} code Wire error code, or `undefined` when the
   *   peer sent no numeric code.
   * @param {string} message Wire error message.
   * @param {unknown} [data] Optional structured error payload.
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcResponseError';
    /** @type {number | undefined} */
    this.code = code;
    /** @type {unknown} */
    this.data = data;
  }
}

/**
 * @typedef {Object} JsonRpcTransportOptions
 * @property {(line: string, error: Error) => void} [onMalformedLine] Called for
 *   each non-empty stdout line that is not valid JSON (or not a JSON object).
 */

/**
 * Line-delimited JSON-RPC 2.0 endpoint over caller-owned streams.
 *
 * A transport is intended for one child process: create it after spawn,
 * {@link start} it, and {@link close} it when the process exits. `close()` only
 * detaches listeners and rejects in-flight requests; it never destroys the
 * caller's streams.
 */
export class JsonRpcLineTransport {
  /** @type {import('node:stream').Readable} */
  #input;
  /** @type {import('node:stream').Writable} */
  #output;
  /** @type {JsonRpcTransportOptions} */
  #options;
  /** @type {string} */
  #buffer = '';
  /** @type {StringDecoder} */
  #decoder = new StringDecoder('utf8');
  /** @type {boolean} */
  #started = false;
  /** @type {((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined} */
  #requestHandler;
  /** @type {((method: string, params: Record<string, unknown>) => void) | undefined} */
  #notificationHandler;
  /** @type {Map<string | number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  #pending = new Map();

  /**
   * @param {import('node:stream').Readable} input Stream that carries frames
   *   from the peer (a child's stdout).
   * @param {import('node:stream').Writable} output Stream that accepts frames
   *   for the peer (a child's stdin).
   * @param {JsonRpcTransportOptions} [options]
   */
  constructor(input, output, options = {}) {
    if (!input || typeof input.on !== 'function') {
      throw new TypeError('JsonRpcLineTransport: input must be a readable stream');
    }
    if (!output || typeof output.write !== 'function') {
      throw new TypeError('JsonRpcLineTransport: output must be a writable stream');
    }
    this.#input = input;
    this.#output = output;
    this.#options = options;
  }

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start() {
    if (this.#started) return;
    this.#started = true;
    this.#input.on('data', this.#onData);
    this.#input.on('error', this.#onInputError);
    this.#input.on('end', this.#onInputEnd);
  }

  /** Detach listeners and reject every pending request. Safe to call twice. */
  close() {
    if (this.#started) {
      this.#started = false;
      this.#input.off('data', this.#onData);
      this.#input.off('error', this.#onInputError);
      this.#input.off('end', this.#onInputEnd);
    }
    this.failPending(new Error('JSON-RPC transport closed'));
  }

  /**
   * Install the handler for incoming requests. A rejected handler (or a missing
   * handler) produces an error response frame; it never crashes the transport.
   *
   * @param {(method: string, params: Record<string, unknown>) => unknown | Promise<unknown>} handler
   */
  onRequest(handler) {
    this.#requestHandler = handler;
  }

  /**
   * Install the handler for incoming notifications.
   *
   * @param {(method: string, params: Record<string, unknown>) => void} handler
   */
  onNotification(handler) {
    this.#notificationHandler = handler;
  }

  /**
   * Install a reporter for malformed input lines. Replaces any prior reporter.
   *
   * @param {(line: string, error: Error) => void} handler
   */
  onMalformedLine(handler) {
    this.#options = { ...this.#options, onMalformedLine: handler };
  }

  /**
   * Send a request and resolve with its `result`.
   *
   * @param {string} method JSON-RPC method name.
   * @param {Record<string, unknown> | undefined} params Request parameters.
   * @param {AbortSignal} [signal] Abandonment signal: aborting drops the pending
   *   entry and rejects with the signal's reason.
   * @returns {Promise<unknown>}
   */
  request(method, params, signal) {
    const id = `req_${randomUUID().replaceAll('-', '')}`;
    /** @type {Record<string, unknown>} */
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;

    return new Promise((resolve, reject) => {
      /** @type {() => void} */
      let detach = () => {};
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason));
          return;
        }
        const onAbort = () => {
          this.#pending.delete(id);
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.#pending.set(id, {
        resolve: (value) => {
          detach();
          resolve(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
      });
      try {
        this.#write(message);
      } catch (error) {
        this.#pending.delete(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Send a notification (no response is expected).
   *
   * @param {string} method JSON-RPC method name.
   * @param {Record<string, unknown>} [params] Notification parameters.
   */
  notify(method, params) {
    /** @type {Record<string, unknown>} */
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this.#write(message);
  }

  /**
   * Wait until previously written frames have been handed to the output's write
   * callback. The empty barrier writes no bytes.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return new Promise((resolve, reject) => {
      this.#output.write('', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Reject all pending requests with `error`. Used when the peer dies so callers
   * do not wait out their own timeouts.
   *
   * @param {Error} error
   */
  failPending(error) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of pending) waiter.reject(error);
  }

  /** @returns {number} Number of requests still awaiting a response. */
  get pendingCount() {
    return this.#pending.size;
  }

  /** @type {(chunk: Buffer | string) => void} */
  #onData = (chunk) => {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    this.#drainLines();
  };

  #drainLines() {
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      this.#handleLine(line);
    }
  }

  /** @type {(error: Error) => void} */
  #onInputError = (error) => {
    this.failPending(error instanceof Error ? error : new Error(String(error)));
  };

  /** @type {() => void} */
  #onInputEnd = () => {
    this.#buffer += this.#decoder.end();
    this.#drainLines();
    this.failPending(new Error('JSON-RPC input closed'));
  };

  /** @param {string} line */
  #handleLine(line) {
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.#reportMalformed(line, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.#reportMalformed(line, new Error('frame is not a JSON object'));
      return;
    }
    const frame = /** @type {Record<string, unknown>} */ (message);
    const id = frame.id;
    const method = frame.method;
    const hasId = typeof id === 'string' || typeof id === 'number';
    if (hasId && typeof method === 'string') {
      this.#handleIncomingRequest(id, method, objectParams(frame.params));
      return;
    }
    if (hasId) {
      this.#handleIncomingResponse(id, frame);
      return;
    }
    if (typeof method === 'string') {
      const params = objectParams(frame.params);
      try {
        this.#notificationHandler?.(method, params);
      } catch (error) {
        // A listener throwing must never take down the transport.
        this.#options.onMalformedLine?.(
          line,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /**
   * @param {string | number} id
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  async #handleIncomingRequest(id, method, params) {
    const handler = this.#requestHandler;
    if (handler === undefined) {
      this.#writeError(id, -32601, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(method, params);
      this.#write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.#writeError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * @param {string | number} id
   * @param {Record<string, unknown>} frame
   */
  #handleIncomingResponse(id, frame) {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    const error = frame.error;
    if (error !== null && typeof error === 'object') {
      const payload = /** @type {Record<string, unknown>} */ (error);
      pending.reject(
        new JsonRpcResponseError(
          typeof payload.code === 'number' ? payload.code : undefined,
          typeof payload.message === 'string' ? payload.message : 'JSON-RPC error',
          payload.data,
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  /**
   * @param {string | number} id
   * @param {number} code
   * @param {string} message
   */
  #writeError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** @param {Record<string, unknown>} message */
  #write(message) {
    if (this.#output.destroyed || this.#output.writableEnded) {
      throw new Error('JSON-RPC output is not writable');
    }
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * @param {string} line
   * @param {Error} error
   */
  #reportMalformed(line, error) {
    this.#options.onMalformedLine?.(line, error);
  }
}

/**
 * Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to
 * `{}` so handlers always see an object, matching the official transport).
 *
 * @param {unknown} params
 * @returns {Record<string, unknown>}
 */
function objectParams(params) {
  return params !== null && typeof params === 'object' && !Array.isArray(params)
    ? /** @type {Record<string, unknown>} */ (params)
    : {};
}

/**
 * Normalize an abort reason into an `Error`.
 *
 * @param {unknown} reason
 * @returns {Error}
 */
function abortError(reason) {
  return reason instanceof Error
    ? reason
    : new Error(`JSON-RPC request aborted: ${String(reason)}`);
}
