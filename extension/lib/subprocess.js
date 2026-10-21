// SPDX-License-Identifier: MIT
//
// Async subprocess helpers. Nothing here ever blocks the compositor's main
// loop: commands run through Gio.Subprocess, carry a hard deadline and are
// force-killed when the owning Scope's cancellable fires.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

// gnome-shell's PATH can be narrower than a login shell's.
const FALLBACK_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const _whichCache = new Map();

/** Absolute path of an executable, or null. */
export function which(name) {
    if (_whichCache.has(name))
        return _whichCache.get(name);
    let path = GLib.find_program_in_path(name);
    if (!path) {
        path = FALLBACK_DIRS
            .map(dir => `${dir}/${name}`)
            .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }
    _whichCache.set(name, path);
    return path;
}

/**
 * Run a command and collect its output. Never throws.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {Gio.Cancellable} [opts.cancellable]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok: boolean, status: number, stdout: string, stderr: string,
 *                    timedOut: boolean, cancelled: boolean}>}
 */
export async function run(argv, {cancellable = null, timeoutMs = 5000} = {}) {
    const result = {ok: false, status: -1, stdout: '', stderr: '', timedOut: false, cancelled: false};
    if (cancellable?.is_cancelled()) {
        result.cancelled = true;
        return result;
    }

    let proc;
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        // Stable, parseable output regardless of the user's locale.
        launcher.setenv('LC_ALL', 'C', true);
        proc = launcher.spawnv(argv);
    } catch (e) {
        result.stderr = e.message;
        return result;
    }

    const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        result.timedOut = true;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    const cancelId = cancellable ? cancellable.connect(() => proc.force_exit()) : 0;

    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        result.stdout = stdout ?? '';
        result.stderr = stderr ?? '';
        result.status = proc.get_if_exited() ? proc.get_exit_status() : -1;
        result.ok = !result.timedOut && proc.get_successful();
    } catch (e) {
        result.stderr = e.message;
    } finally {
        if (!result.timedOut)
            GLib.source_remove(timerId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }

    result.cancelled = cancellable?.is_cancelled() ?? false;
    if (result.timedOut)
        result.stderr = `${argv[0]} timed out after ${timeoutMs / 1000}s`;
    return result;
}

/** Spawn a long-lived process (e.g. a terminal) without capturing output. */
export function spawnDetached(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        // Reap the child when it exits so it never lingers as a zombie.
        proc.wait_async(null).catch(() => {});
        return true;
    } catch (e) {
        console.warn(`[OpsDeck] failed to spawn ${argv[0]}: ${e.message}`);
        return false;
    }
}

/** Read a small text file asynchronously. Resolves null if it can't be read. */
export async function readText(path, cancellable = null) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/** UID owning a process, or null if the process is gone or unreadable. */
export async function processUid(pid, cancellable = null) {
    const status = await readText(`/proc/${pid}/status`, cancellable);
    const match = status?.match(/^Uid:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
}

export function processExists(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

export const MY_UID = new Gio.Credentials().get_unix_user();
export const MY_PID = new Gio.Credentials().get_unix_pid();
