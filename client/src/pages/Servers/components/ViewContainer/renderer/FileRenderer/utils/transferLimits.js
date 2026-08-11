// Mirrors MAX_TRANSFER_PATHS in server/lib/fileTransfer/transferAuth.js — the two are held
// together by a test (server/lib/__tests__/transferAuth.test.js), because nothing else could.
// The server refuses a longer list before it has read a transfer id, so its refusal names no
// transfer and no row could ever carry it; stopping here is what turns that into something the
// user is told about.
export const MAX_TRANSFER_PATHS = 256;

// Kept as a function of its own, and in a file the module tests can reach: inside the component
// the cap was a comparison no test could see, so removing it or turning it around cost nothing.
export const exceedsTransferPathLimit = (paths) => (paths?.length ?? 0) > MAX_TRANSFER_PATHS;
