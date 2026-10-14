import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import App from "./App";
import { StartupBoundary } from "./components/startup-boundary";
import { CONFIG } from "./lib/config";
import { initTheme } from "./lib/theme";
import "./index.css";

initTheme();

const Router = CONFIG.useHashRouter ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StartupBoundary>
      <Router>
        <App />
      </Router>
    </StartupBoundary>
  </StrictMode>,
);
