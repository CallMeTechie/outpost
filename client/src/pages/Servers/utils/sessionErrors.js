export const shouldRecordError = (existing, incoming, currentGeneration) => {
    const generation = incoming.generation ?? currentGeneration;
    if (generation < currentGeneration) return false;
    return !existing || (existing.generation ?? 1) < generation;
};

export const isSuperseded = (existing, serverGeneration) => Boolean(existing) && (existing.generation ?? 1) < (serverGeneration ?? 1);
