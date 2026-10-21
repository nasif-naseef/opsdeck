// SPDX-License-Identifier: MIT
//
// Listening TCP/UDP sockets via `ss -Htulnp`.

import {isLoopback, parseUsers, splitHostPort} from '../lib/sockets.js';
import {CancelledError} from '../lib/scope.js';
import {canSignal, signalLadder} from '../lib/process.js';
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

/** Entries the user asked to see (range + protocol settings). */
export function visiblePorts(entries, settings) {
    const min = settings.get_int('port-range-min');
    const max = settings.get_int('port-range-max');
    const udp = settings.get_boolean('ports-show-udp');
    return entries.filter(e => e.port >= min && e.port <= max && (udp || e.proto === 'tcp'));
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
    displayKeys = ['port-range-min', 'port-range-max', 'ports-show-udp'];

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

        // Kill is only offered when a port has exactly one owning process,
        // so only those need the (per-pid /proc) ownership check.
        await Promise.all(entries.filter(e => e.processes.length === 1).map(async e => {
            const p = e.processes[0];
            p.own = await canSignal(p.pid, this._scope, {expectComm: p.name});
        }));
        return entries;
    }

    count(entries, settings) {
        return visiblePorts(entries, settings).length;
    }

    /** @param {{pid: number, name: string}} proc - as listed, so a recycled PID is refused */
    kill(proc) {
        return signalLadder(proc.pid, this._scope, {expectComm: proc.name});
    }

    destroy() {}
}
