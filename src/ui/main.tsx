import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import "./design-system.css";
import { initializeTheme } from "./ThemeToggle";
import { currentRoute, followsSavedTheme, isPublicRoute } from "./router";
import App from "./App";

const route = currentRoute();
const shell = Promise.resolve({ default: App });
initializeTheme(isPublicRoute(route) && !followsSavedTheme(route));

declare global {
  interface Window {
    gitflareFontsReady?: Promise<void>;
  }
}

void Promise.all([shell, window.gitflareFontsReady]).then(([{ default: Root }]) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
