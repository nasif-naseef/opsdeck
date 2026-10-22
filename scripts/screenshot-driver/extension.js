// SPDX-License-Identifier: MIT
//
// Test-only: replaces every OpsDeck source's fetch with made-up but realistic
// data, so screenshots show the real UI without anything from this machine.
// Used by scripts/screenshots.sh inside a sandboxed headless shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = GLib.getenv('OPSDECK_UUID');
const OUT = GLib.getenv('OPSDECK_SHOTS');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HOUR = 3_600_000;

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

/** Smooth-ish made-up history so sparklines look like a real minute. */
const wave = (n, base, amp, period, noise = 0) => Array.from({length: n}, (_, i) =>
    Math.max(0, base + amp * Math.sin(i / period) + noise * Math.sin(i * 2.7) * Math.cos(i * 0.9)));

const now = Date.now();

const FAKE = {
    claude: () => ({
        fetchedAt: Date.now(),
        stale: null,
        windows: [
            {id: 'five_hour', label: 'Session (5h)', pct: 34, resetsAt: now + 2.2 * HOUR},
            {id: 'seven_day', label: 'Weekly (7d)', pct: 61, resetsAt: now + 3.4 * 24 * HOUR},
            {id: 'seven_day_opus', label: 'Weekly · Opus', pct: 12, resetsAt: now + 3.4 * 24 * HOUR},
        ],
    }),

    system: () => ({
        hostname: 'devbox',
        kernel: '6.12.8-generic',
        uptime: 3 * 86400 + 5 * 3600,
        load: [2.14, 1.87, 1.62],
        cpu: {total: 23, cores: [38, 12, 64, 8, 21, 45, 6, 17, 29, 11, 73, 9, 15, 33, 4, 19]},
        cpuTemp: 58,
        mem: {total: 32 * GiB, used: 13.6 * GiB, available: 18.4 * GiB, swapTotal: 8 * GiB, swapUsed: 0.4 * GiB},
        memPct: 42.5,
        net: [{name: 'wlan0', rx: 2.4e6, tx: 310e3}, {name: 'eth0', rx: 0, tx: 0}],
        history: {
            cpu: wave(60, 24, 9, 6, 5),
            mem: wave(60, 42, 1, 20),
            rx: wave(60, 1.6e6, 1.1e6, 4, 4e5),
            tx: wave(60, 3e5, 1.5e5, 5, 6e4),
        },
    }),
    systemDetails: () => ({
        disks: [
            {device: '/dev/nvme0n1p2', mount: '/', fstype: 'ext4', used: 212 * GiB, free: 251 * GiB, size: 476 * GiB, pct: 45.8},
            {device: '/dev/nvme0n1p1', mount: '/boot/efi', fstype: 'vfat', used: 64 * MiB, free: 448 * MiB, size: 512 * MiB, pct: 12.5},
        ],
        gpus: [{vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', util: 18, memUsed: 2.1 * GiB, memTotal: 8 * GiB, temp: 52, power: 21.4}],
        battery: {capacity: 87, status: 'Discharging', watts: 14.2},
        processes: [
            {pid: 48211, user: 'alex', cpu: 96, rss: 1.2 * GiB, command: 'node', label: 'node vite', own: true},
            {pid: 51877, user: 'alex', cpu: 71, rss: 840 * MiB, command: 'cargo', label: 'cargo', own: true},
            {pid: 30442, user: 'alex', cpu: 34, rss: 2.3 * GiB, command: 'python3', label: 'python3 train.py', own: true},
            {pid: 2210, user: 'alex', cpu: 12, rss: 610 * MiB, command: 'code', label: 'code', own: true},
            {pid: 1874, user: 'postgres', cpu: 6, rss: 180 * MiB, command: 'postgres', label: 'postgres: shop shop', own: false},
        ],
    }),

    ports: () => [
        {proto: 'tcp', port: 22, hosts: ['0.0.0.0', '::'], localOnly: false, processes: []},
        {proto: 'tcp', port: 3000, hosts: ['127.0.0.1'], localOnly: true, processes: [{name: 'node', pid: 48390, own: true}]},
        {proto: 'tcp', port: 5173, hosts: ['127.0.0.1', '::1'], localOnly: true, processes: [{name: 'node', pid: 48211, own: true}]},
        {proto: 'tcp', port: 5432, hosts: ['127.0.0.1'], localOnly: true, processes: []},
        {proto: 'tcp', port: 6379, hosts: ['127.0.0.1'], localOnly: true, processes: []},
        {proto: 'tcp', port: 8080, hosts: ['0.0.0.0'], localOnly: false, processes: []},
        {proto: 'tcp', port: 8888, hosts: ['127.0.0.1'], localOnly: true, processes: [{name: 'python3', pid: 30455, own: true}]},
        {proto: 'tcp', port: 15432, hosts: ['127.0.0.1'], localOnly: true, processes: [{name: 'ssh', pid: 61207, own: true}]},
    ],

    ssh: () => ({
        incoming: [{direction: 'in', user: 'alex', tty: 'pts/3', from: '192.0.2.24', since: '2026-10-22 09:12', own: true}],
        outgoing: [
            {direction: 'out', pid: 61207, host: '198.51.100.10', port: 22, target: 'deploy@bastion', own: true,
                forwards: [{type: 'L', listen: '15432', to: 'db.internal:5432'}, {type: 'D', listen: '1080', to: null}]},
            {direction: 'out', pid: 61530, host: '198.51.100.31', port: 22, target: 'alex@build-01', own: true, forwards: []},
        ],
    }),

    docker: () => {
        const c = (id, name, image, state, status, ports, published, project = 'shop') =>
            ({id, name, image, state, status, running: state === 'running', project, ports, published});
        return [
            c('3f9a1c0d2b7e', 'shop-api-1', 'shop/api:dev', 'running', 'Up 3 hours', ['3001→3000/tcp'],
                [{hostPort: 3001, proto: 'tcp', containerPort: '3000'}]),
            c('8c41e2f05a93', 'shop-cache-1', 'redis:7', 'running', 'Up 3 hours', ['6379→6379/tcp'],
                [{hostPort: 6379, proto: 'tcp', containerPort: '6379'}]),
            c('a07d93b1c6f4', 'shop-db-1', 'postgres:17', 'running', 'Up 3 hours (healthy)', ['5432→5432/tcp'],
                [{hostPort: 5432, proto: 'tcp', containerPort: '5432'}]),
            c('d2e58f7a0c11', 'shop-web-1', 'nginx:1.27', 'running', 'Up 3 hours', ['8080→80/tcp'],
                [{hostPort: 8080, proto: 'tcp', containerPort: '80'}]),
            c('5b6c7d8e9f01', 'mailpit', 'axllent/mailpit', 'exited', 'Exited (0) 2 days ago', [], [], null),
        ];
    },
    dockerDetails: () => new Map([
        ['3f9a1c0d2b7e', {cpu: '4.12%', mem: '182.4MiB', memPct: 0.6}],
        ['8c41e2f05a93', {cpu: '0.31%', mem: '9.8MiB', memPct: 0.03}],
        ['a07d93b1c6f4', {cpu: '1.07%', mem: '96.2MiB', memPct: 0.3}],
        ['d2e58f7a0c11', {cpu: '0.02%', mem: '7.1MiB', memPct: 0.02}],
    ]),
};

function screenshot(name) {
    const stream = Gio.File.new_for_path(`${OUT}/${name}.png`)
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

export default class ScreenshotDriver extends Extension {
    enable() {
        this._run().then(
            () => console.log('SHOTS DONE'),
            e => console.log(`SHOTS FAIL ${e?.stack ?? e}`));
    }

    async _run() {
        await sleep(3000);
        const indicator = Main.panel.statusArea[TARGET];
        const hub = indicator._hub;
        for (const id of ['claude', 'system', 'ports', 'ssh', 'docker']) {
            hub.sources[id].fetch = async () => FAKE[id]();
            if (FAKE[`${id}Details`])
                hub.sources[id].fetchDetails = async () => FAKE[`${id}Details`]();
        }
        hub.refreshAll({force: true});
        await sleep(1500);

        indicator.menu.open();
        await sleep(1500);
        for (const tab of ['claude', 'system', 'ports', 'ssh', 'docker']) {
            indicator._deck.select(tab);
            await sleep(1800);
            await screenshot(tab);
            if (tab === 'system') {
                const adj = indicator._deck._scroll.vadjustment;
                adj.value = adj.upper;
                await sleep(800);
                await screenshot('system-lower');
                adj.value = 0;
            }
        }
        indicator._deck.select('system');
        indicator.menu.close();
        await sleep(600);
        await screenshot('panel');
    }

    disable() {}
}
