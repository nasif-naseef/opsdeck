// SPDX-License-Identifier: MIT
//
// Listening TCP/UDP sockets via `ss -Htulnp`.

import {isLoopback, parseUsers, splitHostPort} from '../lib/sockets.js';
import {CancelledError} from '../lib/scope.js';
import {canKill, killProcess} from '../lib/process.js';
import {SourceError} from '../lib/source.js';
import {run, which} from '../lib/subprocess.js';
import {matchesQuery} from '../lib/format.js';

/**
 * @typedef {object} PortEntry
 * @property {'tcp'|'udp'} proto
 * @property {number} port
 * @property {string[]} hosts - every address the port is bound on
 * @property {boolean} localOnly - bound to loopback only
 * @property {{name: string, pid: number}[]} processes
 */

/**
 * Parse `ss -Htulnp`. Sockets on the same proto/port owned by the same
 * processes are merged (e.g. 0.0.0.0:80 and [::]:80, or SO_REUSEPORT fans).
 *
 * @param {string} raw
 * @returns {PortEntry[]}
 */
export function parseListening(raw) {
    const byKey = new Map();
    for (const line of raw.split('\n')) {
        const f = line.trim().split(/\s+/);
        // Netid State Recv-Q Send-Q Local Peer [Process...]
        if (f.length < 6 || !/^(tcp|udp)$/.test(f[0]))
            continue;
        const local = splitHostPort(f[4]);
        if (!local)
            continue;
        const processes = parseUsers(f.slice(6).join(' '));
        const key = `${f[0]}/${local.port}/${processes.map(p => p.pid).join(',')}`;
        let entry = byKey.get(key);
        if (!entry) {
            entry = {proto: f[0], port: local.port, hosts: [], localOnly: true, processes};
            byKey.set(key, entry);
        }
        if (!entry.hosts.includes(local.host))
            entry.hosts.push(local.host);
        entry.localOnly &&= isLoopback(local.host);
    }
    return [...byKey.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

/** Port range filter from settings. */
export function inRange(entry, min, max) {
    return entry.port >= min && entry.port <= max;
}

/** Entries the user asked to see (range + protocol settings). */
export function visiblePorts(entries, settings) {
    const min = settings.get_int('port-range-min');
    const max = settings.get_int('port-range-max');
    const udp = settings.get_boolean('ports-show-udp');
    return entries.filter(e => inRange(e, min, max) && (udp || e.proto === 'tcp'));
}

export function matchesPort(entry, query) {
    return matchesQuery(query, entry.port, entry.proto, ...entry.processes.flatMap(p => [p.name, p.pid]));
}

export function describePort(e) {
    const procs = e.processes.map(p => `${p.name} (${p.pid})`).join(', ') || 'unknown process';
    return `${e.proto.toUpperCase()} ${e.hosts.join(', ')}:${e.port}  ${procs}`;
}

export class PortsSource {
    id = 'ports';

    constructor(scope) {
        this._scope = scope;
    }

    async fetch() {
        const ss = which('ss');
        if (!ss)
            throw new SourceError('missing', '`ss` is not installed', 'Install iproute2.');
        const r = await run([ss, '-Htulnp'], {cancellable: this._scope.cancellable, timeoutMs: 4000});
        if (r.cancelled)
            throw new CancelledError();
        if (!r.ok)
            throw new SourceError('error', r.stderr.trim() || 'ss failed');
        const entries = parseListening(r.stdout);

        // Mark processes the user is allowed to signal (one /proc read per pid).
        const pids = [...new Set(entries.flatMap(e => e.processes.map(p => p.pid)))];
        const owned = new Set();
        await Promise.all(pids.map(async pid => {
            if (await this.canKill(pid))
                owned.add(pid);
        }));
        for (const e of entries) {
            for (const p of e.processes)
                p.own = owned.has(p.pid);
        }
        return entries;
    }

    count(entries, settings) {
        return visiblePorts(entries, settings).length;
    }

    canKill(pid) {
        return canKill(pid, this._scope);
    }

    kill(pid) {
        return killProcess(pid, this._scope);
    }

    destroy() {}
}
