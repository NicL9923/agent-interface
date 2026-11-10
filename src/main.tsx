import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installErrorReporting } from "./app/error-reports";
import { followKeyboard } from "./app/keyboard-viewport";
import { RootBoundary } from "./app/RootBoundary";
import "./ui.css";
import "./styles.css";
import "./motion.css";
installErrorReporting();
followKeyboard();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>,
);
