// SPDX-License-Identifier: MIT
//
// Signalling local processes, shared by the Ports and System modules.
// Only processes owned by the current user are ever signalled.

import {actionResult} from './source.js';
import {MY_PID, MY_UID, processExists, processUid, readText, run, which} from './subprocess.js';

// Killing any of these ends or breaks the desktop session.
const SESSION_CRITICAL = /^(gnome-shell|gnome-session.*|Xwayland|Xorg|systemd|dbus-daemon|dbus-broker.*|pipewire.*|wireplumber|gdm.*|mutter.*|gnome-keyring-d.*|at-spi.*|ibus-daemon|xdg-desktop-por.*|gsd-.*)$/;

export function isSessionCritical(comm) {
    return SESSION_CRITICAL.test(comm);
}

/** Can the current user signal this process without breaking the session? */
export async function canKill(pid, scope) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === MY_PID)
        return false;
    const [uid, comm] = await Promise.all([processUid(pid, scope.cancellable),
        readText(`/proc/${pid}/comm`, scope.cancellable)]);
    return uid === MY_UID && comm !== null && !isSessionCritical(comm.trim());
}

/** SIGTERM, then SIGKILL if the process is still alive after ~2s. */
export async function killProcess(pid, scope) {
    const kill = which('kill');
    if (!kill)
        return actionResult(false, '`kill` is not installed');
    if (!await canKill(pid, scope))
        return actionResult(false, `PID ${pid} is not yours or is part of the desktop session`);

    const term = await run([kill, '-TERM', String(pid)], {cancellable: scope.cancellable});
    if (!term.ok)
        return actionResult(false, term.stderr.trim() || 'SIGTERM failed');
    for (let i = 0; i < 10; i++) {
        await scope.sleep(200);
        if (!processExists(pid))
            return actionResult(true, `Stopped PID ${pid}`);
    }
    const hard = await run([kill, '-KILL', String(pid)], {cancellable: scope.cancellable});
    if (!hard.ok)
        return actionResult(false, hard.stderr.trim() || 'SIGKILL failed');
    await scope.sleep(300);
    return processExists(pid)
        ? actionResult(false, `PID ${pid} survived SIGKILL`)
        : actionResult(true, `Force-killed PID ${pid}`);
}
