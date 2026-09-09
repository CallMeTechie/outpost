// The five of RequestUtil's fourteen exports that dialogs and contexts use.
// Covering only those keeps the double small; nothing in the render tree of the
// components tested here reaches for any of the other nine.
const METHODS = ["getRequest", "postRequest", "putRequest", "patchRequest", "deleteRequest"];

export const createRequestDouble = () => {
    // A Map, not an object literal. The composite key `${method} ${path}` already
    // keeps a path like "__proto__" away from Object.prototype - "getRequest
    // __proto__" is not a member of it - but the Map needs no such argument to
    // hold: no key of it can reach a prototype, whatever the key shape becomes.
    const answers = new Map();
    const calls = [];
    const key = (method, path) => `${method} ${path}`;

    return {
        calls,

        stub(method, path, answer) {
            answers.set(key(method, path), answer);
        },

        reset() {
            answers.clear();
            calls.length = 0;
        },

        // The shape a vi.mock factory has to return: one entry per mocked export.
        asModule() {
            return Object.fromEntries(METHODS.map((method) => [
                method,
                async (path, body) => {
                    calls.push({ method, path, body });

                    const stubbed = key(method, path);
                    // Throwing, never resolving undefined: an unstubbed request
                    // has to be a visible mistake in the test, not a quiet detour
                    // into the component's empty-response branch.
                    if (!answers.has(stubbed)) {
                        throw new Error(`requestDouble: no answer stubbed for ${stubbed}`);
                    }

                    const answer = answers.get(stubbed);
                    if (answer instanceof Error) throw answer;
                    return answer;
                },
            ]));
        },
    };
};
