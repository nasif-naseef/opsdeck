// SPDX-License-Identifier: MIT
//
// Claude plan usage (5-hour / 7-day limits) for the account Claude Code is
// signed in with.
//
// Strictly READ-ONLY with respect to credentials: we read the access token
// from ~/.claude/.credentials.json and never refresh or write it. Claude Code
// owns the token lifecycle; refreshing it here could rotate the refresh token
// out from under Claude Code and sign the user out. When the token has
// expired we say so and wait for Claude Code to renew it.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {SourceError} from '../lib/source.js';
import {readText} from '../lib/subprocess.js';
import {usageLevel} from '../lib/format.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';
const MIN_FETCH_GAP_MS = 60_000;      // the endpoint rate-limits aggressively
const MIN_FORCED_GAP_MS = 15_000;     // manual refreshes still get a floor

// Usage windows are named by period, optionally followed by what they cover
// (a model family such as "fable" or "opus", or e.g. "oauth_apps"). Labels are
// derived from the key, so new models show up without code changes.
const PERIODS = [
    ['five_hour', 'Session (5h)', 'Session'],
    ['seven_day', 'Weekly (7d)', 'Weekly'],
];
const SCOPE_NAMES = {oauth_apps: 'Apps'};

const titleCase = s => s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** "seven_day" → "Weekly (7d)", "seven_day_fable" → "Weekly · Fable". */
export function windowLabel(id) {
    for (const [prefix, whole, short] of PERIODS) {
        if (id === prefix)
            return whole;
        if (id.startsWith(`${prefix}_`)) {
            const scope = id.slice(prefix.length + 1);
            return `${short} · ${SCOPE_NAMES[scope] ?? titleCase(scope)}`;
        }
    }
    return titleCase(id);
}

/** Overall limits first (session, then weekly), then per-model ones alphabetically. */
function windowRank(id) {
    const period = PERIODS.findIndex(([prefix]) => id === prefix || id.startsWith(`${prefix}_`));
    const overall = PERIODS.some(([prefix]) => id === prefix);
    return [overall ? 0 : 1, period === -1 ? PERIODS.length : period, id];
}

export function credentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

/**
 * @param {string|null} text - credentials file contents
 * @param {number} nowMs
 * @returns {{state: 'signed-out'} | {state: 'expired'|'ok', token: string, expiresAt: number}}
 */
export function parseCredentials(text, nowMs) {
    let oauth;
    try {
        oauth = JSON.parse(text ?? '')?.claudeAiOauth;
    } catch {
        return {state: 'signed-out'};
    }
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token)
        return {state: 'signed-out'};
    const expiresAt = Number(oauth.expiresAt) || 0;
    return {state: expiresAt && expiresAt <= nowMs ? 'expired' : 'ok', token, expiresAt};
}

/**
 * @typedef {object} UsageWindow
 * @property {string} id - "five_hour", "seven_day", "seven_day_fable", ...
 * @property {string} label
 * @property {number} pct
 * @property {number|null} resetsAt
 * @property {number|null} sharePct - for a scoped limit: the share of the
 *   weekly allowance it may use (e.g. 50)
 */

const pctOf = v => Math.max(0, Math.min(100, Math.round(v)));
const timeOf = v => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
};
const slug = s => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Newer responses list every limit in `limits`: the session and overall
 * weekly limits plus "weekly_scoped" ones for a model or surface (e.g.
 * Fable), with `weekly_scoped_shares` giving each scoped limit's share of
 * the weekly allowance. Undocumented, so anything unexpected is skipped.
 *
 * @returns {UsageWindow[]|null} null when the response has no usable `limits`
 */
function parseLimits(json) {
    if (!Array.isArray(json?.limits))
        return null;
    const shares = new Map();
    for (const s of Array.isArray(json.weekly_scoped_shares) ? json.weekly_scoped_shares : []) {
        if (Number.isInteger(s?.limit_index) && typeof s.allowance_percent_of_weekly === 'number')
            shares.set(s.limit_index, s.allowance_percent_of_weekly);
    }
    const windows = [];
    json.limits.forEach((limit, index) => {
        if (!limit || typeof limit.percent !== 'number')
            return;
        const scopeName = limit.scope?.model?.display_name ?? limit.scope?.surface?.display_name ??
            (typeof limit.scope?.surface === 'string' ? limit.scope.surface : null);
        let id;
        if (limit.kind === 'session')
            id = 'five_hour';
        else if (limit.kind === 'weekly_all')
            id = 'seven_day';
        else if (scopeName)
            id = `${limit.group === 'session' ? 'five_hour' : 'seven_day'}_${slug(scopeName)}`;
        else
            return;
        windows.push({
            id,
            label: scopeName ? `${limit.group === 'session' ? 'Session' : 'Weekly'} · ${scopeName}` : windowLabel(id),
            pct: pctOf(limit.percent),
            resetsAt: timeOf(limit.resets_at),
            sharePct: shares.get(index) ?? null,
        });
    });
    return windows.length ? windows : null;
}

/** Older responses: one top-level key per window ({utilization, resets_at}). */
function parseWindowKeys(json) {
    const windows = [];
    for (const [id, w] of Object.entries(json ?? {})) {
        if (!w || typeof w !== 'object' || typeof w.utilization !== 'number')
            continue;
        windows.push({id, label: windowLabel(id), pct: pctOf(w.utilization), resetsAt: timeOf(w.resets_at), sharePct: null});
    }
    return windows;
}

/**
 * Normalise the usage response into an ordered list of windows.
 *
 * @returns {UsageWindow[]}
 */
export function parseUsage(json) {
    const windows = parseLimits(json) ?? parseWindowKeys(json);
    return windows.sort((a, b) => {
        const [ra, rb] = [windowRank(a.id), windowRank(b.id)];
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
    });
}

/** The percentage to show in the top bar for the given preference. */
export function panelPercent(windows, pref) {
    if (!windows.length)
        return null;
    const byId = id => windows.find(w => w.id === id)?.pct;
    const max = Math.max(...windows.map(w => w.pct));
    if (pref === '5h')
        return byId('five_hour') ?? max;
    if (pref === '7d')
        return byId('seven_day') ?? max;
    return max;
}

/**
 * @typedef {object} ClaudeUsage
 * @property {ReturnType<typeof parseUsage>} windows
 * @property {number} fetchedAt
 * @property {string|null} stale - why the data is old, if it is
 */

export class ClaudeSource {
    id = 'claude';
    displayKeys = ['claude-panel-window'];

    constructor(scope) {
        this._scope = scope;
        this._session = new Soup.Session({timeout: 15, user_agent: 'OpsDeck (GNOME Shell extension)'});
        /** @type {ClaudeUsage|null} */
        this._last = null;
        this._lastAttempt = 0;
        /** @type {SourceError|null} last API failure, replayed while backing off */
        this._lastError = null;
        // A token the API rejected; don't retry it until Claude Code replaces it.
        this._rejectedToken = null;
    }

    async fetch({force = false} = {}) {
        const now = Date.now();
        // Local state first (a cheap file read): a cached reading must never
        // hide that Claude Code is signed out or its sign-in expired.
        const creds = parseCredentials(await readText(credentialsPath(), this._scope.cancellable), now);
        if (creds.state === 'signed-out') {
            this._last = null;
            throw new SourceError('signed-out', 'Claude Code is not signed in',
                'Run `claude` and log in to see plan usage.');
        }
        if (creds.state === 'expired' || creds.token === this._rejectedToken)
            throw this._expired();

        // Back off between API calls whether or not the last one succeeded,
        // so a failing or rate-limited endpoint isn't hit on every menu open.
        if (now - this._lastAttempt < (force ? MIN_FORCED_GAP_MS : MIN_FETCH_GAP_MS)) {
            if (this._last)
                return this._last;
            if (this._lastError)
                throw this._lastError;
        }

        this._lastAttempt = now;
        let status, body;
        try {
            [status, body] = await this._get(creds.token);
        } catch (e) {
            if (this._scope.cancellable.is_cancelled())
                throw e;
            return this._staleOr('offline', new SourceError('network', 'Could not reach Anthropic', e.message));
        }

        if (status === 401 || status === 403) {
            this._rejectedToken = creds.token;
            throw this._expired();
        }
        if (status === 429)
            return this._staleOr('rate-limited', new SourceError('rate-limited', 'Rate limited by the usage API'));
        if (status < 200 || status >= 300)
            return this._staleOr('error', new SourceError('error', `Usage API returned HTTP ${status}`));

        let json;
        try {
            json = JSON.parse(body);
        } catch {
            return this._staleOr('error', new SourceError('error', 'Unexpected response from usage API'));
        }
        this._rejectedToken = null;
        this._lastError = null;
        this._last = {windows: parseUsage(json), fetchedAt: Date.now(), stale: null};
        return this._last;
    }

    gauge(usage, settings) {
        const pct = panelPercent(usage.windows, settings.get_string('claude-panel-window'));
        return pct === null ? null : {value: pct, unit: '%', level: usageLevel(pct)};
    }

    async _get(token) {
        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', BETA_HEADER);
        headers.append('Accept', 'application/json');

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._scope.cancellable,
                (session, res) => {
                    try {
                        resolve(session.send_and_read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const body = bytes ? new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()) : '';
        return [msg.get_status(), body];
    }

    _expired() {
        return new SourceError('expired', 'Claude Code sign-in has expired',
            'Open Claude Code once; it renews the token and OpsDeck picks it up.');
    }

    _staleOr(reason, error) {
        this._lastError = error;
        if (!this._last)
            throw error;
        this._last = {...this._last, stale: reason};
        return this._last;
    }

    destroy() {
        this._session.abort();
        this._session = null;
        this._last = null;
    }
}
