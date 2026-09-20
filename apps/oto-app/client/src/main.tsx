import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import HandoffProblemPage from "./pages/handoff-problem-page";
import { handoffArrival, type HandoffProblem } from "./lib/platform-handoff";
import "./index.css";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_APP_CHANGE_ID ?? import.meta.env.VITE_APP_VERSION,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      maskAllInputs: false,
      blockAllMedia: false,
    }),
  ],
  // Tracing
  tracesSampleRate: 1.0,
  // Session Replay — both rates set to 0 (recording only starts manually)
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});

const root = createRoot(document.getElementById("root")!);

function show(problem: HandoffProblem | null): void {
  root.render(problem ? <HandoffProblemPage problem={problem} /> : <App />);
}

/**
 * A hand-off is spent before the app renders, so the first thing the app does
 * — ask `/api/user` who is signed in — happens after the session exists rather
 * than racing it. Without a hand-off in the address bar there is nothing to
 * wait for and the app renders as it always did.
 */
if (handoffArrival) {
  void handoffArrival.then(show);
} else {
  show(null);
}
