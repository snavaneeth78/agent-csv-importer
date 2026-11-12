import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/open-sauce-one/400.css";
import "@fontsource/open-sauce-one/500.css";
import "@fontsource/open-sauce-one/600.css";
import "@fontsource/open-sauce-one/700.css";
import "@fontsource/open-sauce-sans/700.css";
import "@fontsource/open-sauce-sans/800.css";
import "@distru/csv-importer/ui/styles.css";
import "./app.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
