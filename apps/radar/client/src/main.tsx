import { createRoot } from "react-dom/client";
import App from "./App";
import OpenFromLauncherPage from "./pages/open-from-launcher";
import { handoffArrival, type HandoffProblem } from "./lib/platform-handoff";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

function show(problem: HandoffProblem | null): void {
  root.render(
    problem ? (
      <OpenFromLauncherPage title={problem.title} detail={problem.detail} launcherUrl={problem.launcherUrl} />
    ) : (
      <App />
    ),
  );
}

// A launcher arrival is exchanged for Radar's cookie before the first screen
// asks who is signed in; every other visit renders straight away.
if (handoffArrival) {
  void handoffArrival.then(show);
} else {
  show(null);
}
