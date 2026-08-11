// The single client-side copy of the opcode table. server/routes/sftpWS.js holds the server's
// copy; the two must stay in step. This used to be duplicated in FileRenderer.jsx as well, and
// the copy in fileUtils.js had already drifted - it was missing PATH_SYNC.
//
// It lives here rather than in fileUtils.js because fileUtils.js imports @mdi/js, which only
// exists under client/node_modules. The root test run installs root dependencies only, so a test
// reaching through fileUtils.js would pass locally and fail in CI.
export const OPERATIONS = {
    READY: 0x0, LIST_FILES: 0x1, CREATE_FILE: 0x4, CREATE_FOLDER: 0x5, DELETE_FILE: 0x6,
    DELETE_FOLDER: 0x7, RENAME_FILE: 0x8, ERROR: 0x9, SEARCH_DIRECTORIES: 0xA,
    RESOLVE_SYMLINK: 0xB, MOVE_FILES: 0xC, COPY_FILES: 0xD, CHMOD: 0xE,
    STAT: 0xF, CHECKSUM: 0x10, FOLDER_SIZE: 0x11, PATH_SYNC: 0x12,
    TRANSFER_START: 0x13, TRANSFER_PROGRESS: 0x14, TRANSFER_DONE: 0x15, TRANSFER_ERROR: 0x16,
    TRANSFER_CANCEL: 0x17, TRANSFER_CONFLICT: 0x18, TRANSFER_RESOLVE: 0x19,
};
