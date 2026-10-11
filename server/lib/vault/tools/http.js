module.exports = {
    def: { name: "vault_http", description: "", inputSchema: { type: "object", properties: {} } },
    handler: async () => { throw new Error("not implemented"); },
    needsBrowser: false,
    createHttpLimits: () => ({ rate: () => {}, enter: () => null, leave: () => {} }),
};
