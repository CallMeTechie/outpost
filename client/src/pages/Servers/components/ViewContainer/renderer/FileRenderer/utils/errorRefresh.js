// Reloading after an error is what keeps a pane honest: a batch move stops at the first failure
// and the reply says only that something failed, never which files already moved.
//
// It is also how a pane that cannot list at all talks itself into a loop, because the reload asks
// the very question that just failed — a tenant without a SharePoint licence answers every single
// request with an error. The reply carries no opcode, so "was it the listing itself?" cannot be
// read off the error. What can be read off it: whether this pane ever got a listing at all.
export const createErrorRefreshGate = () => {
    let everListed = false;
    let spent = false;

    return {
        listingSucceeded() {
            everListed = true;
            spent = false;
        },
        // true means: reload now.
        errorArrived() {
            if (!everListed || spent) return false;
            spent = true;
            return true;
        },
        // A pane that never listed anything must not render its empty item list as an empty
        // folder — for an account without a drive that is the most dangerous answer, because you
        // would drag something into it.
        hasListed() {
            return everListed;
        },
    };
};
