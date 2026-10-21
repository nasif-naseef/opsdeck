// SPDX-License-Identifier: MIT
//
// SSH sessions in both directions:
//   incoming: remote logins to this machine, from `who`
//   outgoing: ssh clients running on this machine, from `ss -Htnp state established`

import GLib from 'gi://GLib';

import {parseUsers, splitHostPort} from '../lib/sockets.js';
import {CancelledError} from '../lib/scope.js';
import {SourceError, actionResult} from '../lib/source.js';
import {MY_UID, processExists, processUid, readText, run, which} from '../lib/subprocess.js';
import {matchesQuery} from '../lib/format.js';

const TTY_RE = /^(pts\/\d+|tty\d+)$/;
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
            target: peer.host, own: false});
    }
    return out;
}

/**
 * Extract the destination from an ssh client's argv (from /proc/PID/cmdline).
 *
 * @param {string[]} argv
 * @returns {string|null} e.g. "deploy@web-1" or "ssh://host:2222"
 */
export function parseSshTarget(argv) {
    let login = null;
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--')
            return argv[i + 1] ? withLogin(argv[i + 1], login) : null;
        if (!arg.startsWith('-') || arg === '-')
            return withLogin(arg, login);
        for (let j = 1; j < arg.length; j++) {
            if (!SSH_OPTS_WITH_ARG.has(arg[j]))
                continue;
            const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
            if (arg[j] === 'l')
                login = value;
            break;
        }
    }
    return null;
}

function withLogin(dest, login) {
    return login && !dest.includes('@') && !dest.includes('://') ? `${login}@${dest}` : dest;
}

export function matchesSession(s, query) {
    return s.direction === 'in'
        ? matchesQuery(query, s.user, s.from, s.tty)
        : matchesQuery(query, s.target, s.host, s.pid);
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
            const [cmdline, uid] = await Promise.all([
                readText(`/proc/${session.pid}/cmdline`, this._scope.cancellable),
                processUid(session.pid, this._scope.cancellable),
            ]);
            session.own = uid === MY_UID;
            const target = cmdline ? parseSshTarget(cmdline.split('\0').filter(Boolean)) : null;
            if (target)
                session.target = target;
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
        const alive = async () =>
            (await run([pgrep, '-u', this._me, '-t', tty], {cancellable: this._scope.cancellable})).ok;
        return this._escalate(
            sig => run([pkill, `-${sig}`, '-u', this._me, '-t', tty], {cancellable: this._scope.cancellable}),
            alive, `session on ${tty}`);
    }

    async _endPid(pid) {
        const kill = which('kill');
        if (!kill)
            return actionResult(false, '`kill` not installed');
        if (await processUid(pid, this._scope.cancellable) !== MY_UID)
            return actionResult(false, `PID ${pid} is not yours`);
        return this._escalate(
            sig => run([kill, `-${sig}`, String(pid)], {cancellable: this._scope.cancellable}),
            async () => processExists(pid), `ssh (PID ${pid})`);
    }

    /** SIGHUP → SIGTERM → SIGKILL, stopping as soon as the target is gone. */
    async _escalate(send, alive, what) {
        for (const sig of ['HUP', 'TERM', 'KILL']) {
            const r = await send(sig);
            // pkill exits 1 when nothing matched, i.e. already gone.
            if (!r.ok && r.status !== 1)
                return actionResult(false, r.stderr.trim() || `SIG${sig} failed`);
            await this._scope.sleep(sig === 'KILL' ? 300 : 800);
            if (!await alive())
                return actionResult(true, `Ended ${what}`);
        }
        return actionResult(false, `Could not end ${what}`);
    }

    destroy() {}
}
