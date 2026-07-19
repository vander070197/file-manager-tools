const { EventEmitter } = require("events");

// In-memory registry of long-running operations, keyed by a client-generated
// opId. Each operation's state is broadcast over SSE (see routes/files.js
// GET /api/files/progress/:opId) so the browser can render a live progress
// bar without polling.
//
// Lifecycle: create() -> update() 0..n times -> finish()/fail().
// Finished/failed operations are kept around briefly (RETAIN_MS) so a client
// that connects to the SSE stream a little late (or reconnects) still sees
// the final state instead of a 404-ish "unknown operation".

const RETAIN_MS = 60 * 1000;
const STALE_MS = 15 * 60 * 1000; // safety net: drop anything nobody finished

class ProgressManager {
  constructor() {
    this.ops = new Map(); // opId -> { state, emitter, timer }
    setInterval(() => this._sweep(), 5 * 60 * 1000).unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [opId, op] of this.ops.entries()) {
      if (now - op.state.startedAt > STALE_MS) this.ops.delete(opId);
    }
  }

  _scheduleCleanup(opId) {
    const op = this.ops.get(opId);
    if (!op) return;
    clearTimeout(op.timer);
    op.timer = setTimeout(() => this.ops.delete(opId), RETAIN_MS);
    op.timer.unref?.();
  }

  _recompute(state, keepExplicitPercent) {
    if (!keepExplicitPercent) {
      if (state.bytesTotal > 0) {
        state.percent = Math.max(0, Math.min(100, Math.round((state.bytesProcessed / state.bytesTotal) * 100)));
      } else if (state.total > 0) {
        state.percent = Math.max(0, Math.min(100, Math.round((state.processed / state.total) * 100)));
      }
    }
    const elapsed = Date.now() - state.startedAt;
    if (state.status === "running" && state.percent > 2 && elapsed > 400) {
      state.etaMs = Math.round((elapsed / state.percent) * (100 - state.percent));
    } else {
      state.etaMs = null;
    }
  }

  // opId: string. initial: partial state (label, kind, total, bytesTotal, currentFile...)
  create(opId, initial) {
    if (!opId) return null;
    const existing = this.ops.get(opId);
    if (existing) {
      // A subscriber's SSE connection can reach the server before the
      // operation itself does — the client opens EventSource and then
      // fires the actual request, and those two requests can arrive in
      // either order. subscribe() (below) handles that by registering a
      // pending placeholder op so it has something to listen to. When the
      // real create() call comes in, fold its state into that placeholder
      // instead of bailing out — otherwise the listener that's already
      // attached would never hear about it, and the progress bar would
      // sit at 0% forever even though the operation is progressing fine.
      Object.assign(existing.state, initial || {}, { status: "running" });
      this._recompute(existing.state, Object.prototype.hasOwnProperty.call(initial || {}, "percent"));
      existing.emitter.emit("update", existing.state);
      return existing.state;
    }
    const state = Object.assign(
      {
        opId,
        status: "running", // running | done | error
        phase: "starting",
        percent: 0,
        processed: 0,
        total: 0,
        bytesProcessed: 0,
        bytesTotal: 0,
        currentFile: null,
        label: "Working…",
        error: null,
        etaMs: null,
        startedAt: Date.now(),
      },
      initial || {}
    );
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);
    this.ops.set(opId, { state, emitter, timer: null });
    return state;
  }

  update(opId, patch) {
    const op = this.ops.get(opId);
    if (!op) return;
    const explicitPercent = Object.prototype.hasOwnProperty.call(patch || {}, "percent");
    Object.assign(op.state, patch);
    this._recompute(op.state, explicitPercent);
    op.emitter.emit("update", op.state);
  }

  finish(opId, patch) {
    const op = this.ops.get(opId);
    if (!op) return;
    Object.assign(op.state, patch || {}, { status: "done", percent: 100, currentFile: null, etaMs: null });
    op.emitter.emit("update", op.state);
    this._scheduleCleanup(opId);
  }

  fail(opId, message) {
    const op = this.ops.get(opId);
    if (!op) return;
    Object.assign(op.state, { status: "error", error: message, etaMs: null });
    op.emitter.emit("update", op.state);
    this._scheduleCleanup(opId);
  }

  get(opId) {
    const op = this.ops.get(opId);
    return op ? op.state : null;
  }

  // Returns an unsubscribe function. If the operation hasn't been create()d
  // yet (the SSE connection got here first — see the comment in create()),
  // register a pending placeholder so this subscriber is actually attached
  // to something, rather than returning a no-op that would never fire.
  subscribe(opId, cb) {
    let op = this.ops.get(opId);
    if (!op) {
      const state = {
        opId,
        status: "pending",
        phase: "waiting",
        percent: 0,
        processed: 0,
        total: 0,
        bytesProcessed: 0,
        bytesTotal: 0,
        currentFile: null,
        label: "Waiting to start…",
        error: null,
        etaMs: null,
        startedAt: Date.now(),
      };
      const emitter = new EventEmitter();
      emitter.setMaxListeners(100);
      op = { state, emitter, timer: null };
      this.ops.set(opId, op);
    }
    op.emitter.on("update", cb);
    return () => op.emitter.off("update", cb);
  }
}

module.exports = new ProgressManager();
