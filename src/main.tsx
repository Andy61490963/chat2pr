import React from "react";
import { createRoot } from "react-dom/client";
import { App, applyTheme } from "./App.js";
import { UnsavedProvider } from "./app/unsaved.js";
import "@fontsource-variable/inter";
import "./styles.css";
// 先套用使用者選的外觀，避免載入時閃一下另一種配色。
applyTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UnsavedProvider>
      <App />
    </UnsavedProvider>
  </React.StrictMode>,
);
