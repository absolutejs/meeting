/**
 * Tiny hand-rolled event emitter — a `Set` of listeners per event plus a fan-out
 * `emit`. Deliberately not Node's `EventEmitter`: this runs in the browser too,
 * keeps zero deps, and stays fully typed against an event map (no `any`, no
 * `as never`). Used by the meeting core and the buffer source, and the shape the
 * platform adapters mirror.
 *
 * Construct with the exhaustive list of event names so each set exists up front;
 * the mapped type then guarantees `on`/`emit` are exhaustive over the map.
 */

export type Listener<T> = (payload: T) => void | Promise<void>;

export type Emitter<EventMap> = {
  on: <K extends keyof EventMap>(
    event: K,
    handler: Listener<EventMap[K]>,
  ) => () => void;
  emit: <K extends keyof EventMap>(event: K, payload: EventMap[K]) => void;
};

export const createEmitter = <EventMap>(
  events: readonly (keyof EventMap)[],
): Emitter<EventMap> => {
  const listeners = {} as {
    [K in keyof EventMap]: Set<Listener<EventMap[K]>>;
  };
  for (const event of events) {
    listeners[event] = new Set();
  }

  return {
    emit: (event, payload) => {
      for (const handler of listeners[event]) void handler(payload);
    },
    on: (event, handler) => {
      listeners[event].add(handler);

      return () => {
        listeners[event].delete(handler);
      };
    },
  };
};
