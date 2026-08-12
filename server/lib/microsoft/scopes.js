const BASE_SCOPES = ["offline_access", "openid", "email", "profile"];

const FILES_SCOPE = "Files.ReadWrite";
const FILES_ALL_SCOPE = "Files.ReadWrite.All";

// Files.ReadWrite.All replaces Files.ReadWrite rather than joining it: asking for both would put
// the tenant-wide consent prompt in front of every user, which is exactly what the checkbox exists
// to avoid.
const buildScopes = (allFiles = false) =>
    [...BASE_SCOPES, allFiles ? FILES_ALL_SCOPE : FILES_SCOPE].join(" ");

// Microsoft returns the granted scopes either as short names ("Files.ReadWrite") or as absolute
// Graph URIs ("https://graph.microsoft.com/Files.ReadWrite"), depending on the tenant. The stored
// value keeps whatever Microsoft sent; the normalisation happens here, on reading.
const normalize = (scope) => scope.slice(scope.lastIndexOf("/") + 1);

const hasAllFilesAccess = (grantedScopes) => {
    if (typeof grantedScopes !== "string") return false;
    return grantedScopes.split(/\s+/).filter(Boolean).map(normalize).includes(FILES_ALL_SCOPE);
};

module.exports = { BASE_SCOPES, FILES_SCOPE, FILES_ALL_SCOPE, buildScopes, hasAllFilesAccess };
