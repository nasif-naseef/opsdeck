// SPDX-License-Identifier: MIT
//
// Hub: owns polling and the latest state of every source. The UI only reads
// `hub.state[sourceId]` and listens for events; it never fetches.
//
// Source contract (duck-typed):
//   fetch({force})          → data            required, cheap, runs on every poll
//   count(data, settings)   → number          one of these two, for the top bar:
//   gauge(data, settings)   → {value, unit, level} | null   (a % or °, not a count)
//   fetchDetails()          → details         optional, expensive, only while the
//   detailsGapMs            number            source'sourceState tab is on screen
//   displayKeys             string[]          settings that only need a re-render
//
// Events: 'loading' (sourceId) when a fetch starts, 'changed' (sourceId) when state[sourceId]
// changed, 'enabled-changed' (sourceId).

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
        for (const sourceId of SOURCE_IDS) {
            this.state[sourceId] = {enabled: false, loading: false, data: null, error: null, updatedAt: 0, details: null};
            this._generation[sourceId] = 0;
            this._details[sourceId] = {inflight: false, at: 0, generation: 0};
        }

        this._settingsIds = SOURCE_IDS.flatMap(sourceId => [
            settings.connect(`changed::enable-${sourceId}`, () => this._applyEnabled(sourceId)),
            settings.connect(`changed::refresh-interval-${sourceId}`, () => this._schedule(sourceId)),
            ...(sources[sourceId].displayKeys ?? []).map(key =>
                settings.connect(`changed::${key}`, () => this.emit('changed', sourceId))),
        ]);
    }

    start() {
        for (const sourceId of SOURCE_IDS)
            this._applyEnabled(sourceId);
    }

    /**
     * What the top-bar counter and nav badge show for a source, or null when
     * there is nothing to show yet.
     *
     * `quiet` marks an empty count (nothing running): the badge hides it and
     * the top bar does when "hide zero counters" is on. Gauges are never quiet.
     *
     * @returns {{value: number, text: string, level: string|null, quiet: boolean} | null}
     */
    display(sourceId) {
        const sourceState = this.state[sourceId];
        if (!sourceState.enabled || sourceState.data === null)
            return null;
        const source = this.sources[sourceId];
        if (source.gauge) {
            const gauge = source.gauge(sourceState.data, this._settings);
            return gauge && {value: gauge.value, text: `${gauge.value}${gauge.unit}`, level: gauge.level, quiet: false};
        }
        const count = source.count(sourceState.data, this._settings);
        return {value: count, text: String(count), level: null, quiet: count === 0};
    }

    /** The source whose tab is on screen (or null): only it fetches details. */
    setVisible(sourceId) {
        if (this._visible === sourceId)
            return;
        this._visible = sourceId;
        if (sourceId)
            this._refreshDetails(sourceId);
    }

    refreshAll({force = false} = {}) {
        for (const sourceId of SOURCE_IDS)
            this.refresh(sourceId, {force});
    }

    async refresh(sourceId, {force = false} = {}) {
        const sourceState = this.state[sourceId];
        if (!sourceState.enabled || this._scope.disposed)
            return;
        if (this._inflight[sourceId]) {
            // Never run two fetches of one source at once; a forced request
            // during a fetch queues exactly one follow-up instead.
            this._again[sourceId] ||= force;
            return;
        }
        const generation = ++this._generation[sourceId];
        this._inflight[sourceId] = true;
        sourceState.loading = true;
        this.emit('loading', sourceId);

        try {
            const data = await this.sources[sourceId].fetch({force});
            if (generation !== this._generation[sourceId] || this._scope.disposed)
                return;
            Object.assign(sourceState, {data, error: null, updatedAt: Date.now()});
        } catch (error) {
            if (generation !== this._generation[sourceId] || this._scope.disposed || error instanceof CancelledError)
                return;
            if (!(error instanceof SourceError))
                console.error(`[OpsDeck] ${sourceId} refresh failed: ${error.stack ?? error}`);
            sourceState.error = error instanceof SourceError ? error : new SourceError('error', String(error.message ?? error));
            if (CLEARS_DATA.has(sourceState.error.kind))
                sourceState.data = null;
        } finally {
            if (generation === this._generation[sourceId] && !this._scope.disposed) {
                this._inflight[sourceId] = false;
                sourceState.loading = false;
                if (this._visible === sourceId && sourceState.data !== null)
                    this._refreshDetails(sourceId);
                if (this._again[sourceId]) {
                    this._again[sourceId] = false;
                    this.refresh(sourceId, {force: true});
                }
                // Last, and even when nothing new arrived (a cancelled fetch),
                // so the "refreshing" note always clears. Emitter isolates
                // handler exceptions, so the follow-ups above always run.
                this.emit('changed', sourceId);
            }
        }
    }

    async _refreshDetails(sourceId) {
        const source = this.sources[sourceId];
        const sourceState = this.state[sourceId];
        const tracker = this._details[sourceId];
        const gap = source.detailsGapMs ?? DEFAULT_DETAILS_GAP_MS;
        if (!source.fetchDetails || !sourceState.enabled || tracker.inflight || Date.now() - tracker.at < gap || this._scope.disposed)
            return;
        const generation = ++tracker.generation;
        tracker.inflight = true;
        try {
            const details = await source.fetchDetails();
            if (generation !== tracker.generation || this._scope.disposed || !sourceState.enabled)
                return;
            sourceState.details = details;
            tracker.at = Date.now();
            this.emit('changed', sourceId);
        } catch (error) {
            // Details are best-effort; keep the last good set.
            if (!(error instanceof CancelledError) && !this._scope.disposed)
                console.error(`[OpsDeck] ${sourceId} details failed: ${error.stack ?? error}`);
        } finally {
            if (generation === tracker.generation)
                tracker.inflight = false;
        }
    }

    _applyEnabled(sourceId) {
        const sourceState = this.state[sourceId];
        sourceState.enabled = this._settings.get_boolean(`enable-${sourceId}`);
        if (sourceState.enabled) {
            this._schedule(sourceId);
            this.refresh(sourceId, {force: true});
        } else {
            this._timers[sourceId] = this._scope.clear(this._timers[sourceId]);
            // Drop any in-flight results.
            this._generation[sourceId]++;
            this._inflight[sourceId] = false;
            this._again[sourceId] = false;
            Object.assign(this._details[sourceId], {inflight: false, at: 0});
            this._details[sourceId].generation++;
            Object.assign(sourceState, {loading: false, data: null, error: null, updatedAt: 0, details: null});
        }
        this.emit('enabled-changed', sourceId);
        this.emit('changed', sourceId);
    }

    _schedule(sourceId) {
        this._timers[sourceId] = this._scope.clear(this._timers[sourceId]);
        if (!this.state[sourceId].enabled)
            return;
        const seconds = this._settings.get_int(`refresh-interval-${sourceId}`);
        this._timers[sourceId] = this._scope.interval(seconds, () => this.refresh(sourceId));
    }

    destroy() {
        for (const handlerId of this._settingsIds)
            this._settings.disconnect(handlerId);
        this._settingsIds = [];
        for (const sourceId of SOURCE_IDS)
            this._timers[sourceId] = this._scope.clear(this._timers[sourceId]);
        this.disconnectAll();
    }
}
