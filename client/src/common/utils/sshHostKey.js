export const keyAlgorithmLabel = (algorithm) => algorithm
    .replace(/^ssh-/, "")
    .replace(/^ecdsa-sha2-nistp(\d+)$/, "ecdsa-$1")
    .toUpperCase();

export const shortFingerprint = (fingerprint) => {
    const [kind, hash = ""] = fingerprint.split(":");
    return hash.length > 10 ? `${kind}:${hash.slice(0, 6)}…${hash.slice(-4)}` : fingerprint;
};
