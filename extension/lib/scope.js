// SPDX-License-Identifier: MIT
//
// Scope owns every asynchronous resource created between enable() and
// disable(): one root Gio.Cancellable plus every GLib main-loop source.
// Disposing the scope cancels in-flight I/O, removes all timers and rejects
// pending sleeps, so nothing can call back into a disabled extension.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class CancelledError extends Error {
    constructor() {
        super('Operation cancelled');
        this.name = 'CancelledError';
    }
}

export class Scope {
    constructor() {
        this.cancellable = new Gio.Cancellable();
        this.disposed = false;
        this._sources = new Set();
        this._sleepers = new Set();
    }

    /** Run `fn` once after `ms` milliseconds. Returns a source id for clear(). */
    timeout(ms, fn) {
        if (this.disposed)
            return 0;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    /** Run `fn` every `seconds` seconds until cleared or disposed. */
    interval(seconds, fn) {
        if (this.disposed)
            return 0;
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._sources.add(id);
        return id;
    }

    clear(id) {
        if (id && this._sources.delete(id))
            GLib.source_remove(id);
        return 0;
    }

    /** Promise that resolves after `ms`, or rejects with CancelledError on dispose. */
    sleep(ms) {
        if (this.disposed)
            return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => {
            const sleeper = {reject};
            this._sleepers.add(sleeper);
            this.timeout(ms, () => {
                this._sleepers.delete(sleeper);
                resolve();
            });
        });
    }

    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.cancellable.cancel();
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        for (const {reject} of this._sleepers)
            reject(new CancelledError());
        this._sleepers.clear();
    }
}
