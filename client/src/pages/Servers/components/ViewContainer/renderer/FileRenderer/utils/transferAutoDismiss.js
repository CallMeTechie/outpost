// How long a cleanly finished row is given before it clears itself. Chosen so a fast local copy
// still leaves something to glance at, without making the pile-up from a slow OneDrive session
// wait indefinitely on a hand dismissal.
export const AUTO_DISMISS_DELAY_MS = 3000;

// Only a "done" row with nothing left to say clears itself. filesSkipped and leftovers are what
// TransferList renders as their own lines (skipped-files count, files the server could not clean
// up) — auto-dismissing those would make a message disappear before it was read. Errors and
// cancellations always carry information and are never eligible, regardless of these fields.
export const shouldAutoDismiss = (transfer) => transfer.status === "done"
    && !(transfer.filesSkipped > 0)
    && !(transfer.leftovers?.length > 0);
