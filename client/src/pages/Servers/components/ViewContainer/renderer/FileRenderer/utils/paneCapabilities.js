// What a pane assumes until its socket says otherwise. Every capability is granted: the fallback is
// reached before READY arrives and by components rendered outside a pane, and a control that is
// briefly offered and then hidden is a smaller failure than one that is hidden for a provider that
// could have answered it.
//
// One object rather than a literal at each of the six places that need it — the words are added one
// at a time, and a fallback that misses the newest one silently inverts its meaning.
// server/lib/fileCapabilities.js is where the real answer comes from; a test pins these keys
// against it.
export const DEFAULT_CAPABILITIES = { shell: true, terminal: true, copy: true, nativeFs: true, content: true };
