export const initialTransferState = { transfers: [], conflicts: [] };

const FINISHED = ["done", "cancelled", "error"];

// The server payload is untrusted: a wrong-typed field here (e.g. a number instead of an
// array) must not reach a spread and throw — it should just be treated as empty.
const toArray = (value) => (Array.isArray(value) ? value : []);

const patch = (state, id, fields) => {
    if (!state.transfers.some((t) => t.id === id)) return state;
    return { ...state, transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...fields } : t)) };
};

// Conflicts belong to the transfer that raised them: a transfer that ended must not leave a
// dialog behind, and answering one must not clear another transfer's question for the same name.
const withoutConflictsOf = (state, id) => state.conflicts.some((c) => c.transferId === id)
    ? { ...state, conflicts: state.conflicts.filter((c) => c.transferId !== id) }
    : state;

export const transferReducer = (state, event) => {
    switch (event?.type) {
        case "start":
            return { ...state, transfers: [...state.transfers, {
                id: event.id, action: event.action, destination: event.destination,
                status: "running", file: undefined, bytesDone: 0, bytesTotal: 0,
                filesDone: 0, filesTotal: event.filesTotal ?? 0,
            }] };
        case "progress": {
            const { transferId, file, bytesDone, bytesTotal, filesDone, filesTotal } = event.payload ?? {};
            return patch(state, transferId, { file, bytesDone, bytesTotal, filesDone, filesTotal });
        }
        case "done": {
            const { transferId, filesTransferred, filesSkipped, cancelled, leftovers } = event.payload ?? {};
            const next = patch(state, transferId, {
                status: cancelled ? "cancelled" : "done", filesTransferred, filesSkipped,
                leftovers: leftovers?.length ? leftovers : undefined,
            });
            return next === state ? state : withoutConflictsOf(next, transferId);
        }
        case "error": {
            const { transferId, message, leftovers, sourceLeftovers } = event.payload ?? {};
            // Files the server could not clean up. The spec wants the path named, and message
            // alone does not carry it.
            const next = patch(state, transferId, { status: "error", message,
                leftovers: [...toArray(leftovers), ...toArray(sourceLeftovers)] });
            return next === state ? state : withoutConflictsOf(next, transferId);
        }
        case "conflict": {
            const payload = event.payload ?? {};
            if (!state.transfers.some((t) => t.id === payload.transferId)) return state;
            return { ...state, conflicts: [...state.conflicts, payload] };
        }
        case "resolved": {
            if (!state.conflicts.some((c) => c.transferId === event.id && c.file === event.file)) return state;
            return { ...state, conflicts: state.conflicts.filter(
                (c) => !(c.transferId === event.id && c.file === event.file)) };
        }
        case "cancelling": {
            // A click landing while the closing message is already being processed would otherwise
            // push a finished row back into an active state — and nothing can ever get it out of
            // there again: cancelling blocks both the cancel button and dismiss, and the server has
            // nothing left to send about a transfer that has already ended.
            const target = state.transfers.find((t) => t.id === event.id);
            if (!target || FINISHED.includes(target.status)) return state;
            return patch(state, event.id, { status: "cancelling" });
        }
        // Without this a dropped socket leaves rows spinning forever: no DONE or ERROR can arrive
        // anymore, and dismiss only removes finished rows.
        case "connectionLost": {
            if (state.conflicts.length === 0 && state.transfers.every((t) => FINISHED.includes(t.status))) return state;
            return { ...state, conflicts: [], transfers: state.transfers.map((t) =>
                FINISHED.includes(t.status) ? t : { ...t, status: "error", message: "connectionLost" }) };
        }
        case "dismiss": {
            // ids are unique per transfer, so once the guard confirms the target is finished,
            // removing it by id alone is exact — repeating the status check here would be dead code.
            const target = state.transfers.find((t) => t.id === event.id);
            if (!target || !FINISHED.includes(target.status)) return state;
            return { ...state, transfers: state.transfers.filter((t) => t.id !== event.id) };
        }
        default:
            return state;
    }
};
