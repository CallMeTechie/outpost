import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App.jsx";
import { PreferencesProvider } from "@/common/contexts/PreferencesContext.jsx";
import { registerDevFeatureConsoleApi } from "@/common/utils/devFeatures.js";
import { migrateLegacyStorageKeys } from "@/common/utils/storageMigration.js";

try {
    migrateLegacyStorageKeys([localStorage, sessionStorage]);
} catch {
    // Never let a storage migration keep the application from rendering.
}

registerDevFeatureConsoleApi();

document.addEventListener("contextmenu", (e) => {
    const tag = e.target.tagName?.toLowerCase();
    const isEditable = tag === "input" || tag === "textarea" || e.target.isContentEditable;
    if (!isEditable) e.preventDefault();
});

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <PreferencesProvider>
            <App />
        </PreferencesProvider>
    </StrictMode>,
);
