// The numbers come from the server and are read nowhere else, so a done count ahead of its total
// would push the bar past its track or, negative, out of it altogether. A missing count divides
// into NaN, which drops the width declaration and leaves the bar wherever it last stood.
const clamp = (value) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

// Bytes are the finer measure and, unlike the file count, cover both a single huge file and a
// pile of small ones: the server tracks bytesDone/bytesTotal across the whole transfer, not per
// file, and the client already knows filesTotal from the path count before the first byte moves.
// So a lone file in flight has filesTotal stuck at 1 and filesDone at 0 for its entire run, while
// bytesTotal is already the real total — bytes have to go first. File counts only fill in while
// no byte total exists yet: mid directory-walk, or when every file in the transfer is empty.
//
// Out of the component and in a file the module tests can reach: as a helper next to the JSX it
// was a calculation nothing could see, and neutralizing the limit broke no test.
export const transferPercent = (transfer = {}) => {
    if (transfer.bytesTotal > 0) return clamp(Math.round((transfer.bytesDone / transfer.bytesTotal) * 100));
    if (transfer.filesTotal > 0) return clamp(Math.round((transfer.filesDone / transfer.filesTotal) * 100));
    return 0;
};
