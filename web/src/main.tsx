import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { AppearancePanel } from "./components/AppearancePanel";
import { ToastProvider } from "./components/Toast";
import { AppearanceProvider } from "./theme/AppearanceProvider";
import "./theme/themes.css";
import "./styles.css";
import "./theme/wow.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppearanceProvider>
        <AuthProvider>
          <ToastProvider>
            <App />
            <AppearancePanel />
          </ToastProvider>
        </AuthProvider>
      </AppearanceProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
