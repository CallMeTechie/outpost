// Storage keys moved from the nexterm_ prefix to outpost_. Renaming them without
// carrying the values over would sign the user out of their own instance and lose
// the configured server URL, so the old keys are moved once and then dropped.
const LEGACY_PREFIX = "nexterm_";
const PREFIX = "outpost_";

export const migrateLegacyStorageKeys = (storages) => {
    for (const storage of storages) {
        if (!storage) continue;
        const legacyKeys = [];
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
        }
        for (const key of legacyKeys) {
            const target = PREFIX + key.slice(LEGACY_PREFIX.length);
            try {
                // A value already stored under the new name wins: it is the newer one.
                if (storage.getItem(target) === null) storage.setItem(target, storage.getItem(key));
                storage.removeItem(key);
            } catch {
                // Quota exceeded or storage disabled: leave this key behind rather than
                // letting a storage error stop the application from starting at all.
            }
        }
    }
};
