// SPDX-License-Identifier: MIT
//
// Minimal event emitter, so the data layer does not depend on GObject or
// gnome-shell internals and can be unit tested under plain gjs.

export class Emitter {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(event, fn) {
        const id = this._nextId++;
        this._handlers.set(id, {event, fn});
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(event, ...args) {
        for (const {event: e, fn} of [...this._handlers.values()]) {
            if (e !== event)
                continue;
            try {
                fn(...args);
            } catch (err) {
                console.error(`[OpsDeck] '${event}' handler failed: ${err.stack ?? err}`);
            }
        }
    }

    disconnectAll() {
        this._handlers.clear();
    }
}
