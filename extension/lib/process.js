// SPDX-License-Identifier: MIT
//
// The one place OpsDeck signals local processes (Ports, System and SSH).
// Every signal is preceded by a fresh /proc check, so a stale list entry
// can never hit a recycled PID, another user's process or the session.

import {actionResult} from './source.js';
import {readText, run, self, which} from './subprocess.js';

// Killing any of these ends or breaks the desktop session.
const SESSION_CRITICAL = /^(gnome-shell|gnome-session.*|Xwayland|Xorg|systemd|dbus-daemon|dbus-broker.*|pipewire.*|wireplumber|gdm.*|mutter.*|gnome-keyring-d.*|at-spi.*|ibus-daemon|xdg-desktop-por.*|gsd-.*)$/;

export function isSessionCritical(comm) {
    return SESSION_CRITICAL.test(comm);
}

/**
 * @typedef {object} ProcInfo
 * @property {number} pid
 * @property {number} uid
 * @property {string} comm - kernel name, at most 15 chars (same as ss/top show)
 * @property {string[]} argv
 * @property {string} state - R, S, D, Z, ...
 */

/** @returns {Promise<ProcInfo|null>} null when the process is gone or unreadable */
export async function procInfo(pid, cancellable = null) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    const [status, comm, cmdline] = await Promise.all(['status', 'comm', 'cmdline']
        .map(f => readText(`/proc/${pid}/${f}`, cancellable)));
    const uid = status?.match(/^Uid:\s+(\d+)/m);
    if (!uid)
        return null;
    return {
        pid,
        uid: Number(uid[1]),
        comm: comm?.trim() ?? '',
        argv: cmdline ? cmdline.split('\0').filter(Boolean) : [],
        state: status.match(/^State:\s+(\S)/m)?.[1] ?? '?',
    };
}

/** Exited processes, including zombies waiting to be reaped, are gone. */
export function isGone(info) {
    return !info || info.state === 'Z';
}

/**
 * Why `info` must not be signalled, or null when it may be.
 *
 * @param {ProcInfo|null} info
 * @param {object} [o]
 * @param {string} [o.expectComm] - the name the user saw; guards against PID reuse
 */
export function signalBlocker(info, {expectComm} = {}) {
    if (isGone(info))
        return 'The process has already exited';
    if (info.pid <= 1 || info.pid === self().pid)
        return `PID ${info.pid} is protected`;
    if (info.uid !== self().uid)
        return `PID ${info.pid} belongs to another user`;
    if (isSessionCritical(info.comm))
        return `${info.comm} is part of the desktop session`;
    if (expectComm && info.comm !== expectComm)
        return `PID ${info.pid} is now ${info.comm || 'another process'}, not ${expectComm}`;
    return null;
}

export async function canSignal(pid, scope, opts = {}) {
    return signalBlocker(await procInfo(pid, scope.cancellable), opts) === null;
}

/**
 * Send each signal in turn, stopping as soon as the target is gone.
 * Shared by PID-based kills and the SSH tty path.
 *
 * @param {object} o
 * @param {string[]} o.signals - e.g. ['TERM', 'KILL']
 * @param {(sig: string) => Promise<{ok: boolean, status: number, stderr: string}>} o.send
 * @param {() => Promise<boolean>} o.alive
 * @param {import('./scope.js').Scope} o.scope
 * @param {string} o.what - for messages, e.g. "PID 4242"
 */
export async function escalate({signals, send, alive, scope, what}) {
    for (const sig of signals) {
        const r = await send(sig);
        // pkill exits 1 when nothing matched, i.e. the target is already gone.
        if (!r.ok && r.status !== 1)
            return actionResult(false, r.stderr.trim() || `SIG${sig} failed`);
        // Give polite signals ~1.5s to take effect, KILL ~0.3s.
        const polls = sig === 'KILL' ? 2 : 10;
        for (let i = 0; i < polls; i++) {
            await scope.sleep(150);
            if (!await alive())
                return actionResult(true, `Stopped ${what}`);
        }
    }
    return actionResult(false, `${what} is still running`);
}

/**
 * Signal a process by PID, re-validating it before every signal.
 *
 * @param {number} pid
 * @param {import('./scope.js').Scope} scope
 * @param {object} [o]
 * @param {string[]} [o.signals]
 * @param {string} [o.expectComm]
 */
export async function signalLadder(pid, scope, {signals = ['TERM', 'KILL'], expectComm} = {}) {
    const kill = which('kill');
    if (!kill)
        return actionResult(false, '`kill` is not installed');
    // Checked up front too, so a target that is already gone (or never was
    // ours) is reported as such rather than as a successful stop.
    const blocker = signalBlocker(await procInfo(pid, scope.cancellable), {expectComm});
    if (blocker)
        return actionResult(false, blocker);

    return escalate({
        signals,
        scope,
        what: expectComm ? `${expectComm} (PID ${pid})` : `PID ${pid}`,
        // Re-check before every escalation step, not just the first.
        send: async sig => {
            const info = await procInfo(pid, scope.cancellable);
            const why = signalBlocker(info, {expectComm});
            // status 1 = already gone (success); anything else stops the ladder.
            if (why)
                return {ok: false, status: isGone(info) ? 1 : 2, stderr: why};
            return run([kill, `-${sig}`, String(pid)], {cancellable: scope.cancellable});
        },
        alive: async () => !isGone(await procInfo(pid, scope.cancellable)),
    });
}
