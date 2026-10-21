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

/**
 * Absolute path of an executable, or null. Only hits are cached, so a tool
 * installed after login (docker, nvidia-smi, ...) is picked up on next use.
 */
export function which(name) {
    if (_whichCache.has(name))
        return _whichCache.get(name);
    let path = GLib.find_program_in_path(name);
    if (!path) {
        path = FALLBACK_DIRS
            .map(dir => `${dir}/${name}`)
            .find(p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }
    if (path)
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

// Terminal emulators, most preferred first. Each maps the command argv to
// the terminal's own argv. xdg-terminal-exec honours the user's choice.
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
// A launcher that can't open anything (e.g. xdg-terminal-exec with no
// terminal configured) exits non-zero almost at once.
const EARLY_FAILURE_MS = 1500;

/**
 * Run `cmd` in a new terminal window, falling back through TERMINALS when a
 * launcher fails straight away.
 *
 * @param {string[]} cmd
 * @param {import('./scope.js').Scope} scope
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function launchInTerminal(cmd, scope) {
    for (const [bin, build] of TERMINALS) {
        const path = which(bin);
        if (!path)
            continue;
        let proc;
        try {
            proc = Gio.Subprocess.new([path, ...build(cmd)], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`[OpsDeck] ${bin} failed to start: ${e.message}`);
            continue;
        }
        // Reap the child whenever it exits so it never lingers as a zombie.
        const exited = proc.wait_async(null).then(() => true, () => true);
        const quickExit = await Promise.race([exited, scope.sleep(EARLY_FAILURE_MS).then(() => false)]);
        // Still running: a terminal is open. Exited 0: it handed off to a
        // terminal server (gnome-terminal, ptyxis). Exited non-zero: next.
        if (!quickExit || proc.get_successful())
            return {ok: true, message: `Opened in ${bin}`};
        console.warn(`[OpsDeck] ${bin} exited with status ${proc.get_exit_status()}; trying the next terminal`);
    }
    return {ok: false, message: 'No working terminal emulator found'};
}

/** Open a URI with the user's default handler, reporting failure. */
export function openUri(uri) {
    return new Promise(resolve => {
        Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_src, res) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(res);
                resolve({ok: true, message: `Opened ${uri}`});
            } catch (e) {
                resolve({ok: false, message: `Could not open ${uri}: ${e.message}`});
            }
        });
    });
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

let _self = null;

/** {uid, pid} of gnome-shell itself, resolved on first use (not at import). */
export function self() {
    if (!_self) {
        const c = new Gio.Credentials();
        _self = {uid: c.get_unix_user(), pid: c.get_unix_pid()};
    }
    return _self;
}
