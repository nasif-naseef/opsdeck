// SPDX-License-Identifier: MIT
//
// Hub: owns the polling loop and the latest state of every source. The UI
// only reads `hub.state[id]` and listens for 'changed'; it never fetches.

import {Emitter} from './emitter.js';
import {CancelledError} from './scope.js';
import {SourceError} from './source.js';

export const SOURCE_IDS = ['claude', 'ports', 'ssh', 'docker'];

// Errors after which old data would be misleading rather than useful.
const CLEARS_DATA = new Set(['missing', 'daemon', 'permission', 'signed-out']);

/**
 * @typedef {object} SourceState
 * @property {boolean} enabled
 * @property {boolean} loading
 * @property {any} data - last successful result (may coexist with an error)
 * @property {SourceError|null} error
 * @property {number} updatedAt - ms timestamp of last success
 */

export class Hub extends Emitter {
    /**
     * @param {import('gi://Gio').default.Settings} settings
     * @param {import('./scope.js').Scope} scope
     * @param {Record<string, {fetch: Function, count: Function}>} sources
     */
    constructor(settings, scope, sources) {
        super();
        this._settings = settings;
        this._scope = scope;
        this.sources = sources;
        this._timers = {};
        this._generation = {};
        this._inflight = {};
        /** @type {Record<string, SourceState>} */
        this.state = {};
        for (const id of SOURCE_IDS) {
            this.state[id] = {enabled: false, loading: false, data: null, error: null, updatedAt: 0};
            this._generation[id] = 0;
        }

        this._settingsIds = [
            ...SOURCE_IDS.flatMap(id => [
                settings.connect(`changed::enable-${id}`, () => this._applyEnabled(id)),
                settings.connect(`changed::refresh-interval-${id}`, () => this._schedule(id)),
            ]),
            // Display-only settings: no refetch, just recount and re-render.
            ...['port-range-min', 'port-range-max', 'ports-show-udp'].map(k =>
                settings.connect(`changed::${k}`, () => this.emit('changed', 'ports'))),
            settings.connect('changed::claude-panel-window', () => this.emit('changed', 'claude')),
            settings.connect('changed::docker-show-stopped', () => this.emit('changed', 'docker')),
        ];
    }

    start() {
        for (const id of SOURCE_IDS)
            this._applyEnabled(id);
    }

    /** Value for the top-bar counter, or null when there is nothing to show. */
    count(id) {
        const s = this.state[id];
        if (!s.enabled || s.data === null)
            return null;
        return this.sources[id].count(s.data, this._settings);
    }

    refreshAll({force = false} = {}) {
        for (const id of SOURCE_IDS)
            this.refresh(id, {force});
    }

    async refresh(id, {force = false} = {}) {
        const s = this.state[id];
        if (!s.enabled || this._scope.disposed || (this._inflight[id] && !force))
            return;
        const gen = ++this._generation[id];
        this._inflight[id] = true;
        s.loading = true;
        this.emit('changed', id);

        try {
            const data = await this.sources[id].fetch({force});
            if (gen !== this._generation[id] || this._scope.disposed)
                return;
            s.data = data;
            s.error = null;
            s.updatedAt = Date.now();
        } catch (e) {
            if (gen !== this._generation[id] || this._scope.disposed || e instanceof CancelledError)
                return;
            if (!(e instanceof SourceError))
                console.error(`[OpsDeck] ${id} refresh failed: ${e.stack ?? e}`);
            s.error = e instanceof SourceError ? e : new SourceError('error', String(e.message ?? e));
            if (CLEARS_DATA.has(s.error.kind))
                s.data = null;
        } finally {
            if (gen === this._generation[id] && !this._scope.disposed) {
                this._inflight[id] = false;
                s.loading = false;
                this.emit('changed', id);
            }
        }
    }

    _applyEnabled(id) {
        const s = this.state[id];
        s.enabled = this._settings.get_boolean(`enable-${id}`);
        if (s.enabled) {
            this._schedule(id);
            this.refresh(id, {force: true});
        } else {
            this._timers[id] = this._scope.clear(this._timers[id]);
            this._generation[id]++; // drop any in-flight result
            this._inflight[id] = false;
            Object.assign(s, {loading: false, data: null, error: null, updatedAt: 0});
        }
        this.emit('enabled-changed', id);
        this.emit('changed', id);
    }

    _schedule(id) {
        this._timers[id] = this._scope.clear(this._timers[id]);
        if (!this.state[id].enabled)
            return;
        const seconds = this._settings.get_int(`refresh-interval-${id}`);
        this._timers[id] = this._scope.interval(seconds, () => this.refresh(id));
    }

    destroy() {
        for (const sid of this._settingsIds)
            this._settings.disconnect(sid);
        this._settingsIds = [];
        for (const id of SOURCE_IDS)
            this._timers[id] = this._scope.clear(this._timers[id]);
        this.disconnectAll();
    }
}
