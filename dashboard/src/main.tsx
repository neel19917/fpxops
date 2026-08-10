import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { readAuthLog, clearAuthLog } from "./lib/authLog";

// Console handles so a user hitting a logout can hand over a timeline without
// needing DevTools skills: `fpxAuthLog()` prints it, `copy(JSON.stringify(
// fpxAuthLog(), null, 2))` puts it on the clipboard.
declare global {
  interface Window {
    fpxAuthLog?: () => ReturnType<typeof readAuthLog>;
    fpxAuthLogClear?: () => void;
  }
}
window.fpxAuthLog = () => {
  const entries = readAuthLog();
  console.table(entries);
  return entries;
};
window.fpxAuthLogClear = clearAuthLog;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
