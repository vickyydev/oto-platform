import { useEffect, useState } from "react";

/**
 * How somebody signed out gets back in (SCRUM-529), as the server answers it
 * at `GET /api/auth/sign-in-options` and in the `POST /api/logout` reply:
 * whether the old sign-in form is on (OTOAPP_LEGACY_LOGIN) and the OTO
 * launcher's address (LAUNCHER_URL).
 */
export interface SignInOptions {
  legacyLogin: boolean;
  launcherUrl: string | null;
}

/** Only an absolute http(s) URL is a place to send the browser. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Null when the body is not an answer this client understands. */
export function readSignInOptions(body: unknown): SignInOptions | null {
  const b = body as { legacyLogin?: unknown; launcherUrl?: unknown } | null | undefined;
  if (typeof b?.legacyLogin !== "boolean") return null;
  return { legacyLogin: b.legacyLogin, launcherUrl: safeUrl(b.launcherUrl) };
}

/**
 * The signed-out screens' read. A plain fetch rather than a query, because the
 * hand-off problem page renders outside the app's QueryClientProvider.
 * `undefined` while asking; `null` when the server did not say, and the
 * caller then keeps its old behaviour.
 */
export function useSignInOptions(): SignInOptions | null | undefined {
  const [options, setOptions] = useState<SignInOptions | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/sign-in-options", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body) => {
        if (live) setOptions(readSignInOptions(body));
      });
    return () => {
      live = false;
    };
  }, []);
  return options;
}
