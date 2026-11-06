import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installErrorReporting } from "./app/error-reports";
import { RootBoundary } from "./app/RootBoundary";
import "./ui.css";
import "./styles.css";
installErrorReporting();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>,
);
