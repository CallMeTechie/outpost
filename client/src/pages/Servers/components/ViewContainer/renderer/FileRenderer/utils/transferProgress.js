// The numbers come from the server and are read nowhere else, so a done count ahead of its total
// would push the bar past its track or, negative, out of it altogether. A missing count divides
// into NaN, which drops the width declaration and leaves the bar wherever it last stood.
const clamp = (value) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

// File counts are the more meaningful measure once every file is accounted for; bytes only
// drive the bar before the first file count arrives (e.g. a single large file in flight).
//
// Out of the component and in a file the module tests can reach: as a helper next to the JSX it
// was a calculation nothing could see, and neutralizing the limit broke no test.
export const transferPercent = (transfer = {}) => {
    if (transfer.filesTotal > 0) return clamp(Math.round((transfer.filesDone / transfer.filesTotal) * 100));
    if (transfer.bytesTotal > 0) return clamp(Math.round((transfer.bytesDone / transfer.bytesTotal) * 100));
    return 0;
};
