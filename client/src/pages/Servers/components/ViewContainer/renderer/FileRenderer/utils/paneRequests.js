// The payload the file pane puts behind each opcode. One vocabulary for every provider on purpose:
// a pane that named its fields differently depending on who is listening would be exactly the
// provider-specific knowledge the file manager is built without.
//
// These live outside the components so that a test can feed a real request into a real handler.
// server/lib/__tests__/oneDrivePaneSeam.test.js does that. Before it existed, both sides of this
// seam were fully tested against themselves and still disagreed on the fields behind four of the
// eight opcodes, with not a single red test to show for it.
export const listFilesRequest = (path) => ({ path });

export const statRequest = (path) => ({ path });

// The new folder is named by its full path, not by parent plus name.
export const createFolderRequest = (path) => ({ path });

// A dropped folder tree asks for a whole chain of parents at once.
export const createFolderRecursiveRequest = (path) => ({ path, recursive: true });

export const deleteFileRequest = (path) => ({ path });

export const deleteFolderRequest = (path) => ({ path });

// A rename names where the item should end up, not what it should be called; the last segment of
// newPath is the new name.
export const renameRequest = (path, newPath) => ({ path, newPath });

export const moveFilesRequest = (sources, destination) => ({ sources, destination });

export const copyFilesRequest = (sources, destination) => ({ sources, destination });
