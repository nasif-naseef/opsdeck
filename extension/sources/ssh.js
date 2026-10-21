// SPDX-License-Identifier: MIT
//
// SSH sessions in both directions:
//   incoming: remote logins to this machine, from `who`
//   outgoing: ssh clients running on this machine, from `ss -Htnp state established`

import GLib from 'gi://GLib';

import {parseUsers, splitHostPort} from '../lib/sockets.js';
import {CancelledError} from '../lib/scope.js';
import {SourceError, actionResult} from '../lib/source.js';
import {escalate, procInfo, signalBlocker, signalLadder} from '../lib/process.js';
import {run, which} from '../lib/subprocess.js';
import {matchesQuery} from '../lib/format.js';

const TTY_RE = /^(pts\/\d+|tty\d+)$/;
// ssh clients and shells exit cleanly on hangup; escalate only if they don't.
const SSH_SIGNALS = ['HUP', 'TERM', 'KILL'];
// OpenSSH client options that consume an argument.
const SSH_OPTS_WITH_ARG = new Set('BbcDEeFIiJLlmOoPpQRSWw');

/**
 * @typedef {object} IncomingSession
 * @property {'in'} direction
 * @property {string} user
 * @property {string} tty
 * @property {string} from - remote host or address
 * @property {string} since
 * @property {boolean} own - started by the current user (so we may end it)
 *
 * @typedef {object} OutgoingSession
 * @property {'out'} direction
 * @property {number} pid
 * @property {string} target - "user@host" as typed, or the peer address
 * @property {string} host - peer address
 * @property {number} port - peer port
 * @property {Forward[]} forwards - port forwards this client holds open
 * @property {boolean} own
 */

/** Parse `who` (LC_ALL=C) into remote login sessions. */
export function parseWho(raw) {
    const out = [];
    const seen = new Set();
    for (const line of raw.split('\n')) {
        const m = line.match(/^(\S+)\s+(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d|\S+\s+\d+\s+\d\d:\d\d)\s*(?:\((.+)\))?\s*$/);
        if (!m || !m[4])
            continue;
        let from = m[4].trim();
        // Local displays, consoles, tmux/screen panes and greeters are not remote logins.
        if (from.startsWith(':') || /^(tmux|screen)\b/.test(from) || from === 'login screen' ||
            from === m[2] || /^(tty\d+|pts\/\d+)$/.test(from))
            continue;
        const zone = from.indexOf('%');
        if (zone > 0)
            from = from.slice(0, zone);
        const key = `${m[1]}/${m[2]}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({direction: 'in', user: m[1], tty: m[2], from, since: m[3], own: false});
    }
    return out;
}

/**
 * Parse `ss -Htnp state established` into outgoing ssh client connections.
 * With a state filter ss omits the State column, but we accept it either way.
 */
export function parseEstablished(raw) {
    const out = [];
    const seen = new Set();
    for (const line of raw.split('\n')) {
        let f = line.trim().split(/\s+/);
        if (f.length && !/^\d+$/.test(f[0]))
            f = f.slice(1); // drop a leading State column
        // Recv-Q Send-Q Local Peer Process...
        if (f.length < 5)
            continue;
        const peer = splitHostPort(f[3]);
        const ssh = parseUsers(f.slice(4).join(' ')).find(p => p.name === 'ssh');
        if (!peer || !ssh || seen.has(ssh.pid))
            continue;
        seen.add(ssh.pid);
        out.push({direction: 'out', pid: ssh.pid, host: peer.host, port: peer.port,
            target: peer.host, forwards: [], own: false});
    }
    return out;
}

/**
 * Extract the destination from an ssh client's argv (from /proc/PID/cmdline).
 *
 * @param {string[]} argv
 * @returns {string|null} e.g. "deploy@web-1" or "ssh://host:2222"
 */
/**
 * @typedef {object} Forward
 * @property {'L'|'R'|'D'} type - local, remote or dynamic (SOCKS)
 * @property {string} listen - "8080" or "127.0.0.1:8080" (bind address kept when given)
 * @property {string|null} to - "db:5432" for L/R, null for D
 */

/**
 * Parse an ssh client's argv (from /proc/PID/cmdline): destination and
 * port forwards from -L/-R/-D and -o Local/Remote/DynamicForward.
 *
 * @param {string[]} argv
 * @returns {{target: string|null, forwards: Forward[]}}
 */
export function parseSshArgs(argv) {
    let login = null;
    let target = null;
    const forwards = [];
    const option = (flag, value) => {
        if (flag === 'l')
            login = value;
        else if (flag === 'L' || flag === 'R' || flag === 'D')
            pushForward(forwards, flag, value);
        else if (flag === 'o')
            parseForwardOption(forwards, value);
    };
    // OpenSSH keeps parsing options after the destination; the first
    // non-option after it starts the remote command.
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            target ??= argv[i + 1] ?? null;
            break;
        }
        if (!arg.startsWith('-') || arg === '-') {
            if (target !== null)
                break;
            target = arg;
            continue;
        }
        for (let j = 1; j < arg.length; j++) {
            if (!SSH_OPTS_WITH_ARG.has(arg[j]))
                continue;
            const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
            if (value !== undefined)
                option(arg[j], value);
            break;
        }
    }
    return {target: target === null ? null : withLogin(target, login), forwards};
}

/** Back-compat helper: just the destination. */
export function parseSshTarget(argv) {
    return parseSshArgs(argv).target;
}

/** Split on ':' but keep "[v6:addr]" together, stripping the brackets. */
function splitSpec(spec) {
    const parts = [];
    let cur = '';
    let depth = 0;
    for (const ch of spec) {
        if (ch === '[')
            depth++;
        else if (ch === ']')
            depth--;
        else if (ch === ':' && depth === 0) {
            parts.push(cur);
            cur = '';
            continue;
        }
        if (ch !== '[' && ch !== ']')
            cur += ch;
    }
    parts.push(cur);
    return parts;
}

const bracket = host => (host.includes(':') ? `[${host}]` : host);

/** ["::1", "6000"] → "[::1]:6000", ["6000"] → "6000" */
function joinListen(parts) {
    return parts.length === 2 ? `${bracket(parts[0])}:${parts[1]}` : parts.join(':');
}

function pushForward(forwards, type, spec) {
    const p = splitSpec(spec.trim());
    if (type === 'D') {
        // [bind:]port
        forwards.push({type, listen: joinListen(p), to: null});
    } else if (p.length >= 3) {
        // [bind:]port:host:hostport
        const n = p.length;
        forwards.push({type, listen: joinListen(p.slice(0, n - 2)), to: `${bracket(p[n - 2])}:${p[n - 1]}`});
    } else if (p.length === 2) {
        // port:/unix/socket
        forwards.push({type, listen: p[0], to: p[1]});
    } else if (type === 'R' && p.length === 1) {
        // -R port: remote dynamic forward
        forwards.push({type, listen: p[0], to: null});
    }
}

/** -o "LocalForward 8080 db:5432", "-o LocalForward=8080 db:5432", DynamicForward 1080 */
function parseForwardOption(forwards, value) {
    const m = value.match(/^\s*(Local|Remote|Dynamic)Forward\s*[=\s]\s*(\S+)(?:\s+(\S+))?/i);
    if (!m)
        return;
    const type = m[1][0].toUpperCase();
    pushForward(forwards, type, m[3] ? `${m[2]}:${m[3]}` : m[2]);
}

function withLogin(dest, login) {
    return login && !dest.includes('@') && !dest.includes('://') ? `${login}@${dest}` : dest;
}

export function matchesSession(s, query) {
    return s.direction === 'in'
        ? matchesQuery(query, s.user, s.from, s.tty)
        : matchesQuery(query, s.target, s.host, s.pid,
            ...s.forwards.flatMap(f => [f.listen, f.to]));
}

export class SshSource {
    id = 'ssh';

    constructor(scope) {
        this._scope = scope;
        this._me = GLib.get_user_name();
    }

    async fetch() {
        const who = which('who');
        const ss = which('ss');
        if (!who && !ss)
            throw new SourceError('missing', 'Neither `who` nor `ss` is installed');
        const opts = {cancellable: this._scope.cancellable, timeoutMs: 4000};
        const [w, s] = await Promise.all([
            who ? run([who], opts) : null,
            ss ? run([ss, '-Htnp', 'state', 'established'], opts) : null,
        ]);

        if (w?.cancelled || s?.cancelled)
            throw new CancelledError();
        const incoming = w?.ok ? parseWho(w.stdout) : [];
        for (const session of incoming)
            session.own = session.user === this._me;

        const outgoing = s?.ok ? parseEstablished(s.stdout) : [];
        await Promise.all(outgoing.map(async session => {
            const info = await procInfo(session.pid, this._scope.cancellable);
            session.own = signalBlocker(info, {expectComm: 'ssh'}) === null;
            const {target, forwards} = info ? parseSshArgs(info.argv) : {target: null, forwards: []};
            if (target)
                session.target = target;
            session.forwards = forwards;
        }));
        return {incoming, outgoing};
    }

    count(data) {
        return data.incoming.length + data.outgoing.length;
    }

    async terminate(session) {
        if (!session.own)
            return actionResult(false, 'Only your own sessions can be ended');
        return session.direction === 'in'
            ? this._endTty(session.tty)
            : this._endPid(session.pid);
    }

    async _endTty(tty) {
        const pkill = which('pkill');
        const pgrep = which('pgrep');
        if (!pkill || !pgrep)
            return actionResult(false, '`pkill`/`pgrep` not installed');
        if (!TTY_RE.test(tty))
            return actionResult(false, `Refusing unexpected TTY "${tty}"`);
        // A login session is a process tree on its tty; pkill -u me -t only
        // reaches our own processes on it.
        const opts = {cancellable: this._scope.cancellable};
        return escalate({
            signals: SSH_SIGNALS,
            scope: this._scope,
            what: `session on ${tty}`,
            send: sig => run([pkill, `-${sig}`, '-u', this._me, '-t', tty], opts),
            alive: async () => (await run([pgrep, '-u', this._me, '-t', tty], opts)).ok,
        });
    }

    _endPid(pid) {
        // Re-validated against /proc before each signal: still ours, still ssh.
        return signalLadder(pid, this._scope, {signals: SSH_SIGNALS, expectComm: 'ssh'});
    }

    destroy() {}
}
