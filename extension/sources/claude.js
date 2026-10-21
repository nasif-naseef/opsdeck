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

export const WINDOW_LABELS = {
    five_hour: 'Session (5h)',
    seven_day: 'Weekly (7d)',
    seven_day_opus: 'Weekly · Opus',
    seven_day_sonnet: 'Weekly · Sonnet',
    seven_day_oauth_apps: 'Weekly · Apps',
};

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
 * Normalise the usage response into an ordered list of windows.
 *
 * @returns {{id: string, label: string, pct: number, resetsAt: number|null}[]}
 */
export function parseUsage(json) {
    const windows = [];
    for (const [id, w] of Object.entries(json ?? {})) {
        if (!w || typeof w !== 'object' || typeof w.utilization !== 'number')
            continue;
        const resetsAt = w.resets_at ? Date.parse(w.resets_at) : NaN;
        windows.push({
            id,
            label: WINDOW_LABELS[id] ?? id.replace(/_/g, ' '),
            pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
            resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        });
    }
    const order = Object.keys(WINDOW_LABELS);
    const rank = id => (order.includes(id) ? order.indexOf(id) : order.length);
    return windows.sort((a, b) => rank(a.id) - rank(b.id));
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

    constructor(scope) {
        this._scope = scope;
        this._session = new Soup.Session({timeout: 15, user_agent: 'OpsDeck (GNOME Shell extension)'});
        /** @type {ClaudeUsage|null} */
        this._last = null;
        this._lastAttempt = 0;
        // A token the API rejected; don't retry it until Claude Code replaces it.
        this._rejectedToken = null;
    }

    async fetch({force = false} = {}) {
        const now = Date.now();
        const gap = force ? MIN_FORCED_GAP_MS : MIN_FETCH_GAP_MS;
        if (this._last && now - this._lastAttempt < gap)
            return this._last;

        const creds = parseCredentials(await readText(credentialsPath(), this._scope.cancellable), now);
        if (creds.state === 'signed-out') {
            this._last = null;
            throw new SourceError('signed-out', 'Claude Code is not signed in',
                'Run `claude` and log in to see plan usage.');
        }
        if (creds.state === 'expired' || creds.token === this._rejectedToken)
            throw this._expired();

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
        this._last = {windows: parseUsage(json), fetchedAt: Date.now(), stale: null};
        return this._last;
    }

    count(usage, settings) {
        return panelPercent(usage.windows, settings.get_string('claude-panel-window'));
    }

    formatCount(value) {
        return `${value}%`;
    }

    level(value) {
        return usageLevel(value);
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
