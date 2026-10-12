import { useRef } from "react";

/** Keep a transport retry on the same decision; editing or finishing starts a new one. */
export function useManagerActionRequest() {
  const pending = useRef(new Map<string, { payload: string; id: string }>());
  return {
    requestIdFor(scope: string, payload: unknown = null) {
      const serialized = JSON.stringify(payload);
      const previous = pending.current.get(scope);
      if (previous?.payload === serialized) return previous.id;
      const next = { payload: serialized, id: crypto.randomUUID() };
      pending.current.set(scope, next);
      return next.id;
    },
    completed(scope: string) { pending.current.delete(scope); },
  };
}
