const { isGitHost } = require("./provision");

// Hosts are stored as entered; Git and DNS compare them without case. A host that Joi accepts but a
// gitconfig section cannot carry (fd00::1, bücher.de) is left out instead of breaking the setup.
const hostsOf = (item) => (item?.type === "api_key" && item.fields?.git === true && Array.isArray(item.fields.hosts)
    ? item.fields.hosts.map((host) => String(host).toLowerCase()).filter(isGitHost)
    : []);

const coversGit = (item, host) => hostsOf(item).includes(String(host).toLowerCase());

const gitHostsOf = (items) => [...new Set(items.flatMap(hostsOf))].sort();

module.exports = { hostsOf, coversGit, gitHostsOf };
