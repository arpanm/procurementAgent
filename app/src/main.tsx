import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/* Ionic core CSS — required for every Ionic app. */
import "@ionic/react/css/core.css";

/* Ionic base reset / structure / typography. */
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";

/* Ionic optional utility CSS (padding/margin, flex, text, display helpers). */
import "@ionic/react/css/padding.css";
import "@ionic/react/css/float-elements.css";
import "@ionic/react/css/text-alignment.css";
import "@ionic/react/css/text-transformation.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/display.css";

/* Procure Copilot brand theme + custom component styling. */
import "./theme/variables.css";
import "./theme/app.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
