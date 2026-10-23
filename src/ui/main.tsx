import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./design-system.css";
import { initializeTheme } from "./ThemeToggle";
import { currentRoute, followsSavedTheme, isPublicRoute } from "./router";
import App from "./App";

const route = currentRoute();
initializeTheme(isPublicRoute(route) && !followsSavedTheme(route));

declare global {
  interface Window {
    gitflareFontsReady?: Promise<void>;
  }
}

void Promise.resolve(window.gitflareFontsReady).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
