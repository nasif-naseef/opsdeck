// SPDX-License-Identifier: MIT
//
// Test-only driver used by scripts/smoke-test.sh inside a sandboxed headless
// shell: opens OpsDeck, visits every tab, screenshots, and cycles
// disable/enable. Progress is logged with a "SMOKE" prefix.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = GLib.getenv('OPSDECK_UUID');
const SHOTS = GLib.getenv('OPSDECK_SHOTS');

const sleep = ms => new Promise(r => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        r();
        return GLib.SOURCE_REMOVE;
    });
});

function screenshot(name) {
    if (!SHOTS)
        return Promise.resolve();
    GLib.mkdir_with_parents(SHOTS, 0o755);
    const stream = Gio.File.new_for_path(`${SHOTS}/${name}.png`)
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    return new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
            try {
                shooter.screenshot_finish(res);
                stream.close(null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Disabling OpsDeck makes the shell re-enable extensions loaded after it,
// including this one; run the scenario only once per shell.
let started = false;

export default class SmokeDriver extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        this._run().then(
            () => console.log('SMOKE DONE'),
            e => console.log(`SMOKE FAIL ${e?.stack ?? e}`));
    }

    async _run() {
        await sleep(4000);
        const indicator = () => Main.panel.statusArea[TARGET];
        if (!indicator())
            throw new Error('OpsDeck indicator not in panel');
        console.log('SMOKE indicator present');
        await screenshot('panel');

        indicator().menu.open();
        await sleep(2500);
        // The sandbox has no Claude credentials, so also render a made-up
        // reading to exercise the usage view.
        const hub = indicator()._hub;
        indicator()._deck.select('claude');
        await sleep(800);
        await screenshot('claude-signed-out');
        const hour = 3_600_000;
        Object.assign(hub.state.claude, {error: null, updatedAt: Date.now(), data: {stale: null, fetchedAt: Date.now(),
            windows: [
                {id: 'five_hour', label: 'Session (5h)', pct: 34, resetsAt: Date.now() + 2.2 * hour},
                {id: 'seven_day', label: 'Weekly (7d)', pct: 78, resetsAt: Date.now() + 61 * hour},
                {id: 'seven_day_opus', label: 'Weekly · Opus', pct: 93, resetsAt: Date.now() + 61 * hour},
            ]}});
        hub.emit('changed', 'claude');

        // Same for SSH: a made-up outgoing session holding three tunnels. Its
        // PID is pid_max, which the kernel never assigns, so clicking End
        // exercises the whole confirm → signal path without touching anything.
        const pidMax = Number(new TextDecoder().decode(GLib.file_get_contents('/proc/sys/kernel/pid_max')[1]));
        const fakeSsh = {error: null, updatedAt: Date.now(), data: {incoming: [], outgoing: [{
            direction: 'out', pid: pidMax, host: '203.0.113.7', port: 22, target: 'deploy@bastion', own: true,
            forwards: [
                {type: 'L', listen: '5433', to: 'db.internal:5432'},
                {type: 'L', listen: '8080', to: 'grafana:3000'},
                {type: 'D', listen: '1080', to: null},
            ]}]}};

        for (const tab of ['claude', 'system', 'ports', 'ssh', 'docker']) {
            if (tab === 'ssh') {
                // re-apply right before the shot so a real poll can't replace it
                Object.assign(hub.state.ssh, fakeSsh);
                hub.emit('changed', 'ssh');
            }
            indicator()._deck.select(tab);
            // docker stats sample for a few seconds before they appear
            await sleep({docker: 9000, system: 7000}[tab] ?? 1500);
            await screenshot(tab);
            if (tab === 'ssh')
                await this._clickEndTwice(indicator, hub, fakeSsh);
            if (tab === 'system') {
                // Scroll down; the next poll's re-render must keep the position.
                const adj = indicator()._deck._scroll.vadjustment;
                adj.value = adj.upper;
                await sleep(4000);
                await screenshot('system-lower');
                if (adj.value < 50)
                    throw new Error(`scroll position lost on re-render (${adj.value})`);
                adj.value = 0;
            }
            console.log(`SMOKE tab ${tab} ok`);
        }
        indicator().menu.close();

        for (let i = 0; i < 3; i++) {
            await Main.extensionManager.disableExtension(TARGET);
            await sleep(500);
            if (indicator())
                throw new Error('indicator survived disable');
            await Main.extensionManager.enableExtension(TARGET);
            await sleep(1500);
            if (!indicator())
                throw new Error('indicator missing after re-enable');
            // The last tab the user clicked (docker) must survive re-enable.
            if (indicator()._deck._active !== 'docker')
                throw new Error(`last tab lost on re-enable: ${indicator()._deck._active}`);
            indicator().menu.open();
            await sleep(800);
            indicator().menu.close();
        }
        console.log('SMOKE enable/disable cycles ok');
        await Main.extensionManager.disableExtension(TARGET);
        await sleep(1500); // let any stray timers fire into a disabled extension
    }

    /** Two-click confirm on a real button; the deferred re-render must not throw. */
    async _clickEndTwice(indicator, hub, fakeSsh) {
        const findEnd = () => {
            const stack = [indicator()._deck._views.ssh.actor];
            while (stack.length) {
                const a = stack.pop();
                if (a instanceof St.Button && /^End\??$/.test(a.label ?? ''))
                    return a;
                stack.push(...a.get_children());
            }
            return null;
        };
        Object.assign(hub.state.ssh, fakeSsh);
        hub.emit('changed', 'ssh');
        await sleep(300);
        findEnd().emit('clicked', 1);
        await sleep(300);
        if (findEnd()?.label !== 'End?')
            throw new Error(`first click did not arm confirm (label: ${findEnd()?.label})`);
        console.log('SMOKE confirm armed');
        findEnd().emit('clicked', 1);
        await sleep(1500);
        if (indicator()._deck._busy.size !== 0)
            throw new Error('action left a busy state behind');
        console.log('SMOKE confirmed action ran and was refused safely');
    }

    disable() {}
}
