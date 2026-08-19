const SELF_UPDATING = ["appimage", "installer"];

// Anything we do not recognise must not offer a button that then fails. A
// future connector could report a kind this build has never heard of.
export const canSelfUpdate = (kind) => SELF_UPDATING.includes(kind);

// deb and rpm need different commands, so they get different texts. Anything
// else falls back to a hint without a command, which is honest rather than
// wrong.
export const packageHintKey = (kind) =>
    kind === "deb" ? "updater.packageManagedDeb"
    : kind === "rpm" ? "updater.packageManagedRpm"
    : "updater.packageManaged";
