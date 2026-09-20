import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
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

createRoot(document.getElementById("root")!).render(<App />);
