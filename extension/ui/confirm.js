// SPDX-License-Identifier: MIT
//
// Two-click confirmation for destructive actions. Armed state lives here,
// keyed by entity, so it survives list re-renders from background polling.

const ARM_WINDOW_MS = 4000;

export class ConfirmTracker {
    /**
     * @param {import('../lib/scope.js').Scope} scope
     * @param {import('gi://Gio').default.Settings} settings
     * @param {() => void} onChange - re-render request
     */
    constructor(scope, settings, onChange) {
        this._scope = scope;
        this._settings = settings;
        this._onChange = onChange;
        this._armed = new Map(); // key -> timeout id
    }

    isArmed(key) {
        return this._armed.has(key);
    }

    /** Returns true when the action should run now; otherwise arms `key`. */
    confirm(key) {
        if (!this._settings.get_boolean('confirm-destructive'))
            return true;
        if (this._armed.has(key)) {
            this._scope.clear(this._armed.get(key));
            this._armed.delete(key);
            this._onChange();
            return true;
        }
        this._armed.set(key, this._scope.timeout(ARM_WINDOW_MS, () => {
            this._armed.delete(key);
            this._onChange();
        }));
        this._onChange();
        return false;
    }

    clear() {
        for (const id of this._armed.values())
            this._scope.clear(id);
        this._armed.clear();
    }
}
