import { AsyncLocalStorage } from "node:async_hooks";

// Fields attached automatically to every log event emitted inside the context.
export type LogContext = {
  project_id?: string | null;
  call_id?: string | null;
  call_sid?: string | null;
  request_id?: string;
  user_id?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Merge fields into the current context (no-op outside a context). */
export function setLogContext(patch: LogContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

export function runWithLogContext<T>(initial: LogContext, fn: () => T): T {
  return storage.run({ ...initial }, fn);
}

/**
 * A context object that can be entered later from event listeners. EventEmitter callbacks
 * (WebSocket events) do NOT inherit async context, so listeners must be wrapped with bind().
 */
export function createLogContext(initial: LogContext = {}) {
  const store: LogContext = { ...initial };
  return {
    set: (patch: LogContext): void => { Object.assign(store, patch); },
    run: <T>(fn: () => T): T => storage.run(store, fn),
    bind: <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => storage.run(store, () => fn(...args)),
  };
}

/** Wrap a listener so it runs in the context that is active right now. */
export function bindToCurrentContext<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const store = storage.getStore();
  if (!store) return fn;
  return (...args: A): R => storage.run(store, () => fn(...args));
}
