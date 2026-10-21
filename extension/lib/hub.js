// SPDX-License-Identifier: MIT
//
// Hub: owns polling and the latest state of every source. The UI only reads
// `hub.state[id]` and listens for events; it never fetches.
//
// Source contract (duck-typed):
//   fetch({force})          → data            required, cheap, runs on every poll
//   count(data, settings)   → number          required, for top-bar counters
//   fetchDetails()          → details         optional, expensive, only while the
//   detailsGapMs            number            source's tab is on screen
//   displayKeys             string[]          settings that only need a re-render
//
// Events: 'loading' (id) when a fetch starts, 'changed' (id) when state[id]
// changed, 'enabled-changed' (id).

import {Emitter} from './emitter.js';
import {CancelledError} from './scope.js';
import {SourceError} from './source.js';

export const SOURCE_IDS = ['claude', 'system', 'ports', 'ssh', 'docker'];

// Errors after which old data would be misleading rather than useful.
const CLEARS_DATA = new Set(['missing', 'daemon', 'permission', 'signed-out']);
const DEFAULT_DETAILS_GAP_MS = 2500;

/**
 * @typedef {object} SourceState
 * @property {boolean} enabled
 * @property {boolean} loading
 * @property {any} data - last successful result (may coexist with an error)
 * @property {SourceError|null} error
 * @property {number} updatedAt - ms timestamp of last success
 * @property {any} details - last fetchDetails() result, or null
 */

export class Hub extends Emitter {
    /**
     * @param {import('gi://Gio').default.Settings} settings
     * @param {import('./scope.js').Scope} scope
     * @param {Record<string, object>} sources
     */
    constructor(settings, scope, sources) {
        super();
        this._settings = settings;
        this._scope = scope;
        this.sources = sources;
        this._visible = null;
        this._timers = {};
        this._generation = {};
        this._inflight = {};
        this._again = {};
        this._details = {};
        /** @type {Record<string, SourceState>} */
        this.state = {};
        for (const id of SOURCE_IDS) {
            this.state[id] = {enabled: false, loading: false, data: null, error: null, updatedAt: 0, details: null};
            this._generation[id] = 0;
            this._details[id] = {inflight: false, at: 0, generation: 0};
        }

        this._settingsIds = SOURCE_IDS.flatMap(id => [
            settings.connect(`changed::enable-${id}`, () => this._applyEnabled(id)),
            settings.connect(`changed::refresh-interval-${id}`, () => this._schedule(id)),
            ...(sources[id].displayKeys ?? []).map(k =>
                settings.connect(`changed::${k}`, () => this.emit('changed', id))),
        ]);
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

    /**
     * Gauge sources (a percentage or temperature, not a count) format their
     * own value and say how close to a limit it is.
     */
    isGauge(id) {
        return typeof this.sources[id].formatCount === 'function';
    }

    format(id, value) {
        return this.isGauge(id) ? this.sources[id].formatCount(value, this._settings) : String(value);
    }

    /** 'ok' | 'warn' | 'critical' for gauges, null for counts. */
    level(id, value) {
        return this.sources[id].level?.(value, this._settings) ?? null;
    }

    /** The source whose tab is on screen (or null): only it fetches details. */
    setVisible(id) {
        if (this._visible === id)
            return;
        this._visible = id;
        if (id)
            this._refreshDetails(id);
    }

    refreshAll({force = false} = {}) {
        for (const id of SOURCE_IDS)
            this.refresh(id, {force});
    }

    async refresh(id, {force = false} = {}) {
        const s = this.state[id];
        if (!s.enabled || this._scope.disposed)
            return;
        if (this._inflight[id]) {
            // Never run two fetches of one source at once; a forced request
            // during a fetch queues exactly one follow-up instead.
            this._again[id] ||= force;
            return;
        }
        const gen = ++this._generation[id];
        this._inflight[id] = true;
        s.loading = true;
        this.emit('loading', id);

        let changed = false;
        try {
            const data = await this.sources[id].fetch({force});
            if (gen !== this._generation[id] || this._scope.disposed)
                return;
            Object.assign(s, {data, error: null, updatedAt: Date.now()});
            changed = true;
        } catch (e) {
            if (gen !== this._generation[id] || this._scope.disposed || e instanceof CancelledError)
                return;
            if (!(e instanceof SourceError))
                console.error(`[OpsDeck] ${id} refresh failed: ${e.stack ?? e}`);
            s.error = e instanceof SourceError ? e : new SourceError('error', String(e.message ?? e));
            if (CLEARS_DATA.has(s.error.kind))
                s.data = null;
            changed = true;
        } finally {
            if (gen === this._generation[id] && !this._scope.disposed) {
                this._inflight[id] = false;
                s.loading = false;
                if (changed)
                    this.emit('changed', id);
                if (this._visible === id && s.data !== null)
                    this._refreshDetails(id);
                if (this._again[id]) {
                    this._again[id] = false;
                    this.refresh(id, {force: true});
                }
            }
        }
    }

    async _refreshDetails(id) {
        const source = this.sources[id];
        const s = this.state[id];
        const d = this._details[id];
        const gap = source.detailsGapMs ?? DEFAULT_DETAILS_GAP_MS;
        if (!source.fetchDetails || !s.enabled || d.inflight || Date.now() - d.at < gap || this._scope.disposed)
            return;
        const gen = ++d.generation;
        d.inflight = true;
        try {
            const details = await source.fetchDetails();
            if (gen !== d.generation || this._scope.disposed || !s.enabled)
                return;
            s.details = details;
            d.at = Date.now();
            this.emit('changed', id);
        } catch (e) {
            // Details are best-effort; keep the last good set.
            if (!(e instanceof CancelledError) && !this._scope.disposed)
                console.error(`[OpsDeck] ${id} details failed: ${e.stack ?? e}`);
        } finally {
            if (gen === d.generation)
                d.inflight = false;
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
            // Drop any in-flight results.
            this._generation[id]++;
            this._inflight[id] = false;
            this._again[id] = false;
            Object.assign(this._details[id], {inflight: false, at: 0});
            this._details[id].generation++;
            Object.assign(s, {loading: false, data: null, error: null, updatedAt: 0, details: null});
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
