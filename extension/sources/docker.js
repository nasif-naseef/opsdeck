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
 */

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

export class DockerSource {
    id = 'docker';

    constructor(scope) {
        this._scope = scope;
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
        return parseContainers(r.stdout);
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
            argv.push('--time', '10');
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
        const cmd = [docker, 'exec', '-it', container.id, 'sh', '-c',
            'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];
        for (const [bin, build] of TERMINALS) {
            const path = which(bin);
            if (path && spawnDetached([path, ...build(cmd)]))
                return actionResult(true, `Opened shell in ${container.name}`);
        }
        return actionResult(false, 'No terminal emulator found');
    }

    destroy() {}
}
