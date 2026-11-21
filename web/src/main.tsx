import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";

const root = createRoot(document.getElementById("root")!);
const classic = /classic|tab=/.test(window.location.hash);

if (classic) {
  Promise.all([import("./styles.css"), import("./App")]).then(([, m]) => root.render(<StrictMode><m.App /></StrictMode>));
} else {
  Promise.all([import("./lime.css"), import("./Story")]).then(([, m]) => root.render(<StrictMode><m.Story /></StrictMode>));
}
