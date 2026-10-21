// SPDX-License-Identifier: MIT
//
// Docker containers via the docker CLI (works with rootless and remote
// contexts too, since we inherit the user's docker config).

import GLib from 'gi://GLib';

import {CancelledError} from '../lib/scope.js';
import {SourceError, actionResult} from '../lib/source.js';
import {run, spawnDetached, which} from '../lib/subprocess.js';
import {matchesQuery} from '../lib/format.js';

const ID_RE = /^[0-9a-f]{12,64}$/;

/**
 * @typedef {object} Container
 * @property {string} id
 * @property {string} name
 * @property {string} image
 * @property {string} state - running, exited, paused, restarting, created, dead
 * @property {string} status - human text, e.g. "Up 2 hours"
 * @property {boolean} running
 * @property {string|null} project - docker compose project, if any
 * @property {string[]} ports - published ports, e.g. "8080→80/tcp"
 * @property {PublishedPort[]} published
 *
 * @typedef {object} PublishedPort
 * @property {number} hostPort
 * @property {string} proto - tcp | udp | sctp
 * @property {string} containerPort - e.g. "80" or "3000-3002"
 *
 * @typedef {object} ContainerStats
 * @property {string} cpu - e.g. "7.75%"
 * @property {string} mem - e.g. "34MiB"
 * @property {number} memPct
 */

const MAX_RANGE = 1024; // don't expand absurd published port ranges

/** Parse `docker ps -a --format '{{json .}}'` (one JSON object per line). */
export function parseContainers(raw) {
    const out = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        const state = (o.State ?? '').toLowerCase() ||
            ((o.Status ?? '').startsWith('Up') ? 'running' : 'exited');
        out.push({
            id: String(o.ID ?? '').slice(0, 12),
            name: String(o.Names ?? '').split(',')[0].replace(/^\//, ''),
            image: o.Image ?? '',
            state,
            status: o.Status ?? state,
            running: state === 'running',
            project: parseLabels(o.Labels)['com.docker.compose.project'] ?? null,
            ports: publishedPorts(o.Ports ?? ''),
            published: parsePublished(o.Ports ?? ''),
        });
    }
    // Running first, then by name.
    return out.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

export function parseLabels(labels) {
    const map = {};
    for (const pair of String(labels ?? '').split(',')) {
        const i = pair.indexOf('=');
        if (i > 0)
            map[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return map;
}

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp" → ["8080→80/tcp"] */
export function publishedPorts(ports) {
    const out = new Set();
    for (const m of ports.matchAll(/:(\d+(?:-\d+)?)->(\d+(?:-\d+)?\/\w+)/g))
        out.add(`${m[1]}→${m[2]}`);
    return [...out];
}

/**
 * Structured published ports, one entry per host port (ranges expanded).
 * "0.0.0.0:8080->80/tcp, :::8080->80/tcp" → [{hostPort: 8080, proto: 'tcp', containerPort: '80'}]
 *
 * @returns {PublishedPort[]}
 */
export function parsePublished(ports) {
    const out = new Map();
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->(\d+(?:-\d+)?)\/(\w+)/g)) {
        const first = Number(m[1]);
        const last = m[2] ? Math.min(Number(m[2]), first + MAX_RANGE) : first;
        const cFirst = Number(m[3].split('-')[0]);
        for (let p = first; p <= last; p++) {
            const containerPort = m[2] ? String(cFirst + (p - first)) : m[3];
            out.set(`${m[4]}/${p}`, {hostPort: p, proto: m[4], containerPort});
        }
    }
    return [...out.values()];
}

/**
 * Index published host ports to the containers that own them.
 *
 * @param {Container[]} containers
 * @returns {Map<string, {name: string, containerPort: string, running: boolean}>} keyed "tcp/8080"
 */
export function hostPortIndex(containers) {
    const index = new Map();
    for (const c of containers ?? []) {
        for (const p of c.published ?? []) {
            const key = `${p.proto}/${p.hostPort}`;
            // Prefer a running container if a stopped one claims the same port.
            if (!index.has(key) || c.running)
                index.set(key, {name: c.name, containerPort: p.containerPort, running: c.running});
        }
    }
    return index;
}

/**
 * Parse `docker stats --no-stream --format '{{json .}}'`.
 *
 * @returns {Map<string, ContainerStats>} keyed by 12-char container id
 */
export function parseStats(raw) {
    const out = new Map();
    for (const line of raw.split('\n')) {
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        const id = String(o.ID ?? o.Container ?? '').slice(0, 12);
        if (!id)
            continue;
        out.set(id, {
            cpu: o.CPUPerc ?? '',
            mem: String(o.MemUsage ?? '').split('/')[0].trim(),
            memPct: parseFloat(o.MemPerc) || 0,
        });
    }
    return out;
}

/** Turn docker CLI stderr into a user-facing SourceError. */
export function classifyDockerError(stderr) {
    const s = stderr.trim();
    if (/permission denied/i.test(s)) {
        return new SourceError('permission', 'No permission to talk to Docker',
            'Add yourself to the "docker" group, then log out and back in.');
    }
    if (/cannot connect|failed to connect|is the docker daemon running|no such file or directory/i.test(s))
        return new SourceError('daemon', 'Docker daemon is not running', 'Start it with: systemctl start docker');
    return new SourceError('error', s.split('\n')[0] || 'docker failed');
}

export function matchesContainer(c, query) {
    return matchesQuery(query, c.name, c.image, c.project, c.id, ...c.ports);
}

// Terminal emulators, most preferred first. `cmd` is the argv to run inside.
const TERMINALS = [
    ['xdg-terminal-exec', cmd => cmd],
    ['ptyxis', cmd => ['--new-window', '-x', cmd.map(a => GLib.shell_quote(a)).join(' ')]],
    ['kgx', cmd => ['--', ...cmd]],
    ['gnome-terminal', cmd => ['--', ...cmd]],
    ['kitty', cmd => ['--', ...cmd]],
    ['alacritty', cmd => ['-e', ...cmd]],
    ['wezterm', cmd => ['start', '--', ...cmd]],
    ['foot', cmd => cmd],
    ['konsole', cmd => ['-e', ...cmd]],
    ['xterm', cmd => ['-e', ...cmd]],
];

function openInTerminal(cmd, okMessage) {
    for (const [bin, build] of TERMINALS) {
        const path = which(bin);
        if (path && spawnDetached([path, ...build(cmd)]))
            return actionResult(true, okMessage);
    }
    return actionResult(false, 'No terminal emulator found');
}

export class DockerSource {
    id = 'docker';

    constructor(scope) {
        this._scope = scope;
        /** @type {Map<string, ContainerStats>} */
        this.stats = new Map();
        this.statsAt = 0;
        this._wantStats = false;
        this._statsInflight = false;
        /** Set by the Hub: call when data changes outside fetch(). */
        this.onUpdate = null;
    }

    /**
     * Stats are expensive (`docker stats` samples for ~1-5s), so they are
     * only collected while the Docker tab is on screen.
     */
    setVisible(visible) {
        this._wantStats = visible;
        if (visible)
            this._refreshStats();
    }

    async _refreshStats() {
        const docker = which('docker');
        if (!docker || !this._wantStats || this._statsInflight || Date.now() - this.statsAt < 8000)
            return;
        this._statsInflight = true;
        try {
            const r = await run([docker, 'stats', '--no-stream', '--format', '{{json .}}'],
                {cancellable: this._scope.cancellable, timeoutMs: 15000});
            if (r.cancelled || this._scope.disposed)
                return;
            if (r.ok) {
                this.stats = parseStats(r.stdout);
                this.statsAt = Date.now();
                this.onUpdate?.();
            }
        } finally {
            this._statsInflight = false;
        }
    }

    async fetch() {
        const docker = which('docker');
        if (!docker)
            throw new SourceError('missing', 'Docker is not installed');
        const r = await run([docker, 'ps', '-a', '--format', '{{json .}}'],
            {cancellable: this._scope.cancellable, timeoutMs: 8000});
        if (r.cancelled)
            throw new CancelledError();
        if (!r.ok) {
            if (r.timedOut)
                throw new SourceError('daemon', 'Docker did not respond', 'The daemon may be hung.');
            throw classifyDockerError(r.stderr);
        }
        const containers = parseContainers(r.stdout);
        this._refreshStats();
        return containers;
    }

    count(containers) {
        return containers.filter(c => c.running).length;
    }

    /** @param {'start'|'stop'|'restart'} verb */
    async act(verb, container) {
        const docker = which('docker');
        if (!docker || !ID_RE.test(container.id) || !['start', 'stop', 'restart'].includes(verb))
            return actionResult(false, 'Invalid docker action');
        const argv = [docker, verb];
        if (verb !== 'start')
            argv.push('-t', '10');
        argv.push(container.id);
        const r = await run(argv, {cancellable: this._scope.cancellable, timeoutMs: 30000});
        return r.ok
            ? actionResult(true, `${verb} ${container.name}`)
            : actionResult(false, r.stderr.trim().split('\n')[0] || `docker ${verb} failed`);
    }

    /** Open an interactive shell in the container in a terminal window. */
    openShell(container) {
        const docker = which('docker');
        if (!docker || !ID_RE.test(container.id))
            return actionResult(false, 'Invalid container');
        return openInTerminal([docker, 'exec', '-it', container.id, 'sh', '-c',
            'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
        `Opened shell in ${container.name}`);
    }

    /** Follow the container's logs in a terminal window. */
    openLogs(container) {
        const docker = which('docker');
        if (!docker || !ID_RE.test(container.id))
            return actionResult(false, 'Invalid container');
        return openInTerminal([docker, 'logs', '--follow', '--tail', '200', container.id],
            `Showing logs of ${container.name}`);
    }

    destroy() {}
}
