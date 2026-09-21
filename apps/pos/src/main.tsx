import { createRoot } from "react-dom/client";
import App from "./App";
// Inter, served from this build rather than from Google Fonts, so a till with
// no internet comes up in its own typeface. See src/fonts.css.
import "./fonts.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
