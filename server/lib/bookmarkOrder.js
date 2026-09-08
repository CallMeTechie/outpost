// Positions are always rewritten as a whole, gapless from 0: a half-written order is a state the
// bar cannot draw.
const renumberPositions = (ids) => ids.map((id, position) => ({ id, position }));

// The order route is strict rather than forgiving. Ignoring unknown ids and appending missing ones
// would reorder by a rule the user never sees, and an appended bookmark jumps somewhere nobody
// dragged it after the next reload. Mismatch means the pane sorted on a stale list - the client
// reloads and drops its ordering.
const orderRequestIsComplete = (received, existing) => {
    if (!Array.isArray(received) || received.length !== existing.length) return false;
    const seen = new Set(received);
    if (seen.size !== received.length) return false;
    return existing.every((id) => seen.has(id));
};

module.exports = { renumberPositions, orderRequestIsComplete };
