class TransferNotPermittedError extends Error {
    constructor() {
        // Deliberately uniform: the caller must not be able to tell a missing session from a
        // missing permission or a foreign connection, or the endpoint becomes a probe for other
        // people's servers and accounts.
        super("Transfer not permitted");
        this.name = "TransferNotPermittedError";
    }
}

module.exports = { TransferNotPermittedError };
