// SPDX-License-Identifier: MIT
//
// Unit tests for the data layer. Run with:  gjs -m tests/run.js
// Only pure parsers and helpers are exercised; nothing here kills, stops
// or contacts anything.

import GLib from 'gi://GLib';
import System from 'system';

import {formatAgo, formatDuration, matchesQuery, usageLevel} from '../extension/lib/format.js';
import {isLoopback, parseUsers, splitHostPort} from '../extension/lib/sockets.js';
import {Emitter} from '../extension/lib/emitter.js';
import {escalate, isGone, isSessionCritical, signalBlocker} from '../extension/lib/process.js';
import {self} from '../extension/lib/subprocess.js';
import {Scope} from '../extension/lib/scope.js';
import {Hub, SOURCE_IDS} from '../extension/lib/hub.js';
import {cpuPercent, describeCmdline, formatBytes, formatRate, netRates, parseLoadavg, parseMeminfo, parseMounts, parseNetDev,
    parseNvidiaSmi, parseProcStat, parseTop, parseTopMem, parseUptime, pickCpuTemp} from '../extension/lib/procfs.js';
import {matchesPort, parseListening, visiblePorts} from '../extension/sources/ports.js';
import {parseEstablished, parseSshArgs, parseWho} from '../extension/sources/ssh.js';
import {classifyDockerError, hostPortIndex, parseContainers, parseLabels, parsePublished, parseStats,
    publishedPorts} from '../extension/sources/docker.js';
import {ClaudeSource, panelPercent, parseCredentials, parseUsage, windowLabel} from '../extension/sources/claude.js';
import {SystemSource} from '../extension/sources/system.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const fixture = name => new TextDecoder().decode(
    GLib.file_get_contents(`${here}/fixtures/${name}`)[1]);

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failures.push(`✗ ${name}\n    ${e.message}`);
    }
}

function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what ? `${what}: ` : ''}expected ${b}, got ${a}`);
}

// ── lib ───────────────────────────────────────────────────────────────────
test('splitHostPort handles v4, v6, wildcard and zones', () => {
    eq(splitHostPort('0.0.0.0:22'), {host: '0.0.0.0', port: 22});
    eq(splitHostPort('[::]:80'), {host: '::', port: 80});
    eq(splitHostPort('*:5353'), {host: '*', port: 5353});
    eq(splitHostPort('127.0.0.53%lo:53'), {host: '127.0.0.53', port: 53});
    eq(splitHostPort('[fe80::1%eth0]:546'), {host: 'fe80::1', port: 546});
    eq(splitHostPort('nonsense'), null);
    eq(splitHostPort('host:99999'), null);
});

test('parseUsers dedupes pids and keeps names with spaces', () => {
    eq(parseUsers('users:(("nginx",pid=1,fd=6),("nginx",pid=2,fd=6),("nginx",pid=1,fd=7))'),
        [{name: 'nginx', pid: 1}, {name: 'nginx', pid: 2}]);
    eq(parseUsers('users:(("avahi daemon",pid=9,fd=1))'), [{name: 'avahi daemon', pid: 9}]);
    eq(parseUsers(''), []);
});

test('isLoopback', () => {
    eq([isLoopback('127.0.0.1'), isLoopback('::1'), isLoopback('0.0.0.0'), isLoopback('::')],
        [true, true, false, false]);
});

test('format helpers', () => {
    const now = 1_000_000_000;
    eq(formatAgo(0, now), 'never');
    eq(formatAgo(now - 2000, now), 'just now');
    eq(formatAgo(now - 42_000, now), '42s ago');
    eq(formatAgo(now - 5 * 60_000, now), '5m ago');
    eq(formatAgo(now - 3 * 3_600_000, now), '3h ago');
    eq(formatDuration(45 * 60_000), '45m');
    eq(formatDuration(125 * 60_000), '2h 05m');
    eq(formatDuration(76 * 3_600_000), '3d 4h');
    eq([usageLevel(10), usageLevel(70), usageLevel(95)], ['ok', 'warn', 'critical']);
    eq(matchesQuery(' NGI ', 'nginx', 80), true);
    eq(matchesQuery('', null), true);
    eq(matchesQuery('zzz', 'nginx', null, 80), false);
});

test('Emitter connect/emit/disconnect', () => {
    const e = new Emitter();
    const seen = [];
    const id = e.connect('changed', v => seen.push(v));
    e.connect('other', () => seen.push('no'));
    e.emit('changed', 1);
    e.disconnect(id);
    e.emit('changed', 2);
    eq(seen, [1]);
});

// ── ports ─────────────────────────────────────────────────────────────────
test('parseListening merges duplicate sockets and v4/v6 binds', () => {
    const ports = parseListening(fixture('ss-listening.txt'));
    eq(ports.map(p => `${p.proto}/${p.port}`),
        ['tcp/22', 'udp/53', 'udp/1900', 'tcp/5173', 'udp/5353', 'tcp/8080', 'tcp/9000']);
    const ssh = ports.find(p => p.port === 22);
    eq(ssh.hosts, ['0.0.0.0', '::']);
    eq(ssh.processes, []);
    eq(ssh.localOnly, false);
    const vite = ports.find(p => p.port === 5173);
    eq(vite.hosts, ['127.0.0.1', '::1']);
    eq(vite.localOnly, true);
    eq(ports.find(p => p.port === 1900).processes, [{name: 'spotify', pid: 2032548}]);
    eq(ports.find(p => p.port === 8080).processes.map(p => p.pid), [310, 311]);
    eq(ports.find(p => p.port === 9000).hosts, ['fe80::1']);
    eq(ports.find(p => p.port === 5353).processes[0].name, 'avahi daemon');
});

test('port range + query filters', () => {
    const ports = parseListening(fixture('ss-listening.txt'));
    const range = {get_int: k => ({'port-range-min': 1024, 'port-range-max': 9999})[k], get_boolean: () => true};
    eq(visiblePorts(ports, range).map(p => p.port), [1900, 5173, 5353, 8080, 9000]);
    eq(ports.filter(p => matchesPort(p, 'nginx')).map(p => p.port), [8080]);
    eq(ports.filter(p => matchesPort(p, '4242')).map(p => p.port), [5173]);
    eq(ports.filter(p => matchesPort(p, 'udp')).length, 3);
});

const target = argv => parseSshArgs(argv).target;

// ── ssh ───────────────────────────────────────────────────────────────────
test('parseWho keeps only remote logins', () => {
    const s = parseWho(fixture('who.txt'));
    eq(s.map(x => `${x.user}@${x.from}/${x.tty}`),
        ['deploy@203.0.113.50/pts/3', 'bob@fe80::1/pts/4', 'carol@laptop.example.lan/pts/5']);
    eq(s[0].since, '2026-10-21 11:02');
});

test('parseWho accepts the traditional date format', () => {
    eq(parseWho('root     pts/0        Oct 21 09:15 (192.0.2.1)\n').map(s => s.from), ['192.0.2.1']);
});

test('parseEstablished finds ssh clients only, with or without State column', () => {
    const s = parseEstablished(fixture('ss-established.txt'));
    eq(s.map(x => [x.pid, x.host, x.port]),
        [[5150, '203.0.113.7', 22], [5151, '2001:db8::42', 2222], [5152, '198.51.100.9', 22]]);
});

test('parseSshTarget extracts the destination from argv', () => {
    eq(target(['ssh', 'deploy@web-1']), 'deploy@web-1');
    eq(target(['ssh', '-p', '2222', '-i', '/k', 'web-1', 'uptime']), 'web-1');
    eq(target(['/usr/bin/ssh', '-l', 'root', '-A', 'db']), 'root@db');
    eq(target(['ssh', '-lroot', 'db']), 'root@db');
    eq(target(['ssh', '-NL', '8080:localhost:80', 'bastion']), 'bastion');
    eq(target(['ssh', '-o', 'StrictHostKeyChecking=no', '--', 'h']), 'h');
    eq(target(['ssh', 'ssh://me@h:2200']), 'ssh://me@h:2200');
    eq(target(['ssh', '-v']), null);
});

test('parseSshArgs: options after the destination, remote command stops parsing', () => {
    eq(target(['ssh', 'bastion', '-L', '8080:db:5432']), 'bastion');
    eq(parseSshArgs(['ssh', 'bastion', '-L', '8080:db:5432']).forwards,
        [{type: 'L', listen: '8080', to: 'db:5432'}]);
    eq(parseSshArgs(['ssh', 'host', 'ls', '-L', '1:a:2']).forwards, []);
});

test('parseSshArgs forwards: -L/-R/-D, combined flags, binds, IPv6, sockets, -o', () => {
    const {target, forwards} = parseSshArgs(['ssh', '-fNL', '5433:db.internal:5432', '-L127.0.0.1:8080:web:80',
        '-D', '1080', '-R', '9000:localhost:3000', '-L', '[::1]:6000:[fd00::5]:6379',
        '-L', '7000:/run/app.sock', '-R', '2222',
        '-o', 'LocalForward 4000 api:443', '-o', 'DynamicForward=127.0.0.1:1081', '-o', 'ServerAliveInterval=30',
        'deploy@jump']);
    eq(target, 'deploy@jump');
    eq(forwards, [
        {type: 'L', listen: '5433', to: 'db.internal:5432'},
        {type: 'L', listen: '127.0.0.1:8080', to: 'web:80'},
        {type: 'D', listen: '1080', to: null},
        {type: 'R', listen: '9000', to: 'localhost:3000'},
        {type: 'L', listen: '[::1]:6000', to: '[fd00::5]:6379'},
        {type: 'L', listen: '7000', to: '/run/app.sock'},
        {type: 'R', listen: '2222', to: null},
        {type: 'L', listen: '4000', to: 'api:443'},
        {type: 'D', listen: '127.0.0.1:1081', to: null},
    ]);
});

// ── docker ────────────────────────────────────────────────────────────────
test('parseContainers', () => {
    const c = parseContainers(fixture('docker-ps.jsonl'));
    eq(c.map(x => x.name), ['shop-cache-1', 'shop-db-1', 'api']);
    eq(c[0].project, 'shop');
    eq(c[0].ports, ['32918→6379/tcp']);
    eq(c[2].running, false);
    eq(c[2].state, 'exited');
    eq(c[2].ports, ['8080→80/tcp']);
    eq(c[2].project, null);
});

test('docker helpers', () => {
    eq(parseLabels('a=1,b=x=y'), {a: '1', b: 'x=y'});
    eq(publishedPorts('0.0.0.0:3000-3002->3000-3002/tcp'), ['3000-3002→3000-3002/tcp']);
    eq(classifyDockerError('permission denied while trying to connect to the Docker daemon socket').kind, 'permission');
    eq(classifyDockerError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?').kind, 'daemon');
    eq(classifyDockerError('failed to connect to the docker API at unix:///x.sock; check if the path is correct and if the daemon is running: dial unix /x.sock: connect: no such file or directory').kind, 'daemon');
    eq(classifyDockerError('Error: something odd\nmore').message, 'Error: something odd');
});

test('parsePublished expands ranges and dedupes v4/v6', () => {
    eq(parsePublished('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp, 127.0.0.1:5353->53/udp'),
        [{hostPort: 8080, proto: 'tcp', containerPort: '80'}, {hostPort: 5353, proto: 'udp', containerPort: '53'}]);
    eq(parsePublished('0.0.0.0:3000-3002->4000-4002/tcp').map(p => `${p.hostPort}:${p.containerPort}`),
        ['3000:4000', '3001:4001', '3002:4002']);
    eq(parsePublished('0.0.0.0:1-65535->1-65535/tcp').length, 1025);
});

test('hostPortIndex prefers running containers', () => {
    const c = parseContainers(fixture('docker-ps.jsonl'));
    const idx = hostPortIndex(c);
    eq(idx.get('tcp/32918'), {name: 'shop-cache-1', containerPort: '6379', running: true});
    eq(idx.get('tcp/8080').name, 'api');
    eq(idx.has('udp/8080'), false);
    const both = hostPortIndex([
        {name: 'new', running: true, published: [{hostPort: 80, proto: 'tcp', containerPort: '80'}]},
        {name: 'old', running: false, published: [{hostPort: 80, proto: 'tcp', containerPort: '80'}]},
    ]);
    eq(both.get('tcp/80').name, 'new');
    eq(hostPortIndex(null).size, 0);
});

test('parseStats', () => {
    const s = parseStats(fixture('docker-stats.jsonl'));
    eq(s.size, 2);
    eq(s.get('20e034387a26'), {cpu: '0.16%', mem: '6.379MiB', memPct: 0.02});
    eq(s.get('a5f9bcbca836').cpu, '7.75%');
});

// ── claude ────────────────────────────────────────────────────────────────
test('parseCredentials states', () => {
    const now = 1_700_000_000_000;
    eq(parseCredentials(null, now), {state: 'signed-out'});
    eq(parseCredentials('{not json', now), {state: 'signed-out'});
    eq(parseCredentials('{"claudeAiOauth":{}}', now), {state: 'signed-out'});
    eq(parseCredentials(JSON.stringify({claudeAiOauth: {accessToken: 't', expiresAt: now - 1}}), now).state, 'expired');
    eq(parseCredentials(JSON.stringify({claudeAiOauth: {accessToken: 't', expiresAt: now + 60_000}}), now).state, 'ok');
    eq(parseCredentials(JSON.stringify({claudeAiOauth: {accessToken: 't'}}), now).state, 'ok');
});

test('parseUsage orders, clamps and skips nulls', () => {
    const w = parseUsage({
        seven_day: {utilization: 41.6, resets_at: '2026-10-25T10:00:00Z'},
        five_hour: {utilization: 104, resets_at: null},
        seven_day_opus: null,
        extra_usage: {is_enabled: false},
        seven_day_sonnet: {utilization: 3},
    });
    eq(w.map(x => [x.id, x.pct]), [['five_hour', 100], ['seven_day', 42], ['seven_day_sonnet', 3]]);
    eq(w[0].resetsAt, null);
    eq(w[1].resetsAt, Date.parse('2026-10-25T10:00:00Z'));
});

test('windowLabel derives names for any model, including new ones', () => {
    eq(['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_opus', 'seven_day_sonnet',
        'seven_day_oauth_apps', 'five_hour_fable', 'monthly_thing'].map(windowLabel),
    ['Session (5h)', 'Weekly (7d)', 'Weekly · Fable', 'Weekly · Opus', 'Weekly · Sonnet',
        'Weekly · Apps', 'Session · Fable', 'Monthly Thing']);
    const order = parseUsage({seven_day_opus: {utilization: 1}, seven_day_fable: {utilization: 2},
        seven_day: {utilization: 3}, five_hour: {utilization: 4}, five_hour_fable: {utilization: 5}});
    eq(order.map(w => w.id), ['five_hour', 'seven_day', 'five_hour_fable', 'seven_day_fable', 'seven_day_opus']);
});

test('panelPercent preference', () => {
    const w = parseUsage({five_hour: {utilization: 20}, seven_day: {utilization: 60}});
    eq([panelPercent(w, '5h'), panelPercent(w, '7d'), panelPercent(w, 'max')], [20, 60, 60]);
    eq(panelPercent(parseUsage({seven_day: {utilization: 5}}), '5h'), 5);
    eq(panelPercent([], 'max'), null);
});

// ── system (procfs) ───────────────────────────────────────────────────────
test('parseProcStat + cpuPercent', () => {
    const a = parseProcStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\ncpu1 50 0 50 350 50 0 0 0 0 0\nintr 1 2\n');
    const b = parseProcStat('cpu  250 0 150 800 100 0 0 0 0 0\ncpu0 150 0 100 350 50 0 0 0 0 0\ncpu1 100 0 50 450 50 0 0 0 0 0\n');
    eq(a.total, [200, 800]);
    eq(a.cores.size, 2);
    eq(cpuPercent(a.total, b.total), 66.66666666666666);
    eq(cpuPercent(a.cores.get(0), b.cores.get(0)), 100);
    eq(cpuPercent(a.cores.get(1), b.cores.get(1)), 33.33333333333333);
    eq(cpuPercent(null, b.total), null);
    eq(cpuPercent(b.total, b.total), 0);
});

test('parseProcStat keys cores by id when CPUs are offline (nosmt / hotplug)', () => {
    const s = parseProcStat('cpu  1 0 1 8 0 0 0 0 0 0\ncpu0 1 0 1 8 0 0 0 0 0 0\ncpu2 1 0 1 8 0 0 0 0 0 0\ncpu6 1 0 1 8 0 0 0 0 0 0\n');
    eq([...s.cores.keys()], [0, 2, 6]);
    eq([...s.cores.values()].every(v => Array.isArray(v) && v.length === 2), true);
});

test('parseMeminfo uses MemAvailable', () => {
    const m = parseMeminfo('MemTotal:       32000000 kB\nMemFree:  1000000 kB\nMemAvailable:   24000000 kB\n' +
        'Buffers: 1 kB\nSwapTotal:      8000000 kB\nSwapFree:       6000000 kB\nHugePages_Total:       0\n');
    eq(m, {total: 32000000 * 1024, used: 8000000 * 1024, available: 24000000 * 1024,
        swapTotal: 8000000 * 1024, swapUsed: 2000000 * 1024});
});

test('loadavg, uptime', () => {
    eq(parseLoadavg('18.03 28.44 22.07 12/3307 3310823\n'), [18.03, 28.44, 22.07]);
    eq(parseUptime('195136.56 5422806.00\n'), 195136);
});

test('parseNetDev skips virtual interfaces; netRates', () => {
    const head = 'Inter-|   Receive |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes\n';
    const row = (n, rx, tx) => `${n}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`;
    const a = parseNetDev(head + row('lo', 9, 9) + row('wlp18s0', 1000, 500) + row('docker0', 5, 5) +
        row('br-ba748a51c46e', 5, 5) + row('veth2bb3762', 5, 5) + row('wg0', 0, 0));
    eq([...a.keys()], ['wlp18s0', 'wg0']);
    const b = parseNetDev(head + row('wlp18s0', 3000, 600) + row('wg0', 100, 0) + row('tun0', 1, 1));
    eq(netRates(a, b, 2), [{name: 'wlp18s0', rx: 1000, tx: 50}, {name: 'wg0', rx: 50, tx: 0}]);
    eq(netRates(b, a, 1).find(r => r.name === 'wlp18s0'), {name: 'wlp18s0', rx: 0, tx: 0});
});

test('parseMounts keeps real filesystems once each', () => {
    const m = parseMounts([
        '/dev/nvme0n1p4 / ext4 rw,relatime 0 0',
        'proc /proc proc rw 0 0',
        '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
        '/dev/sda1 /media/me/My\\040Disk exfat rw 0 0',
        '/dev/sdb1 /data btrfs rw,subvol=/@data 0 0',
        '/dev/sdb1 /home btrfs rw,subvol=/@home 0 0',
        '/dev/loop3 /snap/core22/1 squashfs ro 0 0',
        'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
        'tmpfs /run tmpfs rw 0 0',
    ].join('\n'));
    eq(m.map(x => x.mount), ['/', '/boot/efi', '/media/me/My Disk', '/data']);
});

test('parseTop reads the second iteration', () => {
    const block = (cpu1, cpu2) => `top - 15:00:00 up 2 days\nTasks: 3 total\n\n` +
        `    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n` +
        `3586289 nasif     20   0   11.2g 754844  19344 S ${cpu1}   2.4 220:10.58 python train.py\n` +
        `   1234 root      20   0 1108424   1.8g  26620 R ${cpu2}   3.0   1:04.60 Xwayland\n`;
    const p = parseTop(block('5.0', '1.0') + '\n' + block('959.3', '98.1'));
    eq(p.map(x => [x.pid, x.user, x.cpu, x.command]),
        [[3586289, 'nasif', 959.3, 'python train.py'], [1234, 'root', 98.1, 'Xwayland']]);
    eq(p[0].rss, 754844 * 1024);
    eq(parseTopMem('1.8g'), Math.round(1.8 * 1024 ** 3));
    eq(parseTopMem('512m'), 512 * 1024 ** 2);
    eq(parseTopMem('?'), 0);
});

test('parseNvidiaSmi handles commas in names and N/A', () => {
    eq(parseNvidiaSmi('NVIDIA GeForce RTX 5070 Laptop GPU, 0, 110, 8151, 57, 8.07\nWeird, Name GPU, 50, 1, 2, [N/A], [N/A]\n'), [
        {name: 'NVIDIA GeForce RTX 5070 Laptop GPU', util: 0, memUsed: 110 * 1024 * 1024,
            memTotal: 8151 * 1024 * 1024, temp: 57, power: 8.07},
        {name: 'Weird, Name GPU', util: 50, memUsed: 1024 * 1024, memTotal: 2 * 1024 * 1024, temp: null, power: null},
    ]);
});

test('pickCpuTemp prefers the package sensor', () => {
    eq(pickCpuTemp([{source: 'INT3400 Thermal', label: '', celsius: 20}, {source: 'SEN2', label: '', celsius: 86},
        {source: 'TCPU', label: '', celsius: 85}, {source: 'x86_pkg_temp', label: '', celsius: 86}]), 86);
    eq(pickCpuTemp([{source: 'k10temp', label: 'Tctl', celsius: 61.5}, {source: 'nvme', label: 'Composite', celsius: 40}]), 61.5);
    eq(pickCpuTemp([{source: 'TCPU', label: '', celsius: 70}, {source: 'acpitz', label: '', celsius: 30}]), 70);
    eq(pickCpuTemp([{source: 'nvme', label: 'Composite', celsius: 40}]), null);
    eq(pickCpuTemp([]), null);
});

test('session-critical processes are never offered for kill', () => {
    eq(['gnome-shell', 'gnome-session-b', 'Xwayland', 'pipewire-pulse', 'gsd-power', 'systemd'].map(isSessionCritical),
        [true, true, true, true, true, true]);
    eq(['python', 'node', 'nginx', 'gjs', 'code'].map(isSessionCritical), [false, false, false, false, false]);
});

test('describeCmdline names what an interpreter runs', () => {
    eq(describeCmdline(['/usr/bin/python3', '-u', '/srv/app/worker.py', '--n', '4']), 'python3 worker.py');
    eq(describeCmdline(['python', '-m', 'uvicorn', 'main:app']), 'python uvicorn');
    eq(describeCmdline(['/home/me/.local/bin/node', '/x/node_modules/.bin/vite']), 'node vite');
    eq(describeCmdline(['java', '-Xmx2g', '-jar', '/opt/app.jar']), 'java app.jar');
    eq(describeCmdline(['bash', '-c', 'sleep 1']), 'bash -c');
    eq(describeCmdline(['/usr/lib/firefox/firefox', '-contentproc']), 'firefox');
    eq(describeCmdline([]), null);
});

test('signalBlocker: every reason a process must not be signalled', () => {
    const me = self();
    const ok = {pid: 4242, uid: me.uid, comm: 'python', argv: ['python'], state: 'S'};
    eq(signalBlocker(ok), null);
    eq(signalBlocker(ok, {expectComm: 'python'}), null);
    eq(signalBlocker(null), 'The process has already exited');
    eq(signalBlocker({...ok, state: 'Z'}), 'The process has already exited');
    eq(signalBlocker({...ok, pid: 1}), 'PID 1 is protected');
    eq(signalBlocker({...ok, pid: me.pid}), `PID ${me.pid} is protected`);
    eq(signalBlocker({...ok, uid: me.uid + 1}), 'PID 4242 belongs to another user');
    eq(signalBlocker({...ok, comm: 'gnome-shell'}), 'gnome-shell is part of the desktop session');
    eq(signalBlocker({...ok, comm: 'bash'}, {expectComm: 'ssh'}), 'PID 4242 is now bash, not ssh');
    eq([isGone(null), isGone({...ok, state: 'Z'}), isGone(ok)], [true, true, false]);
});

test('formatBytes / formatRate', () => {
    eq([formatBytes(512), formatBytes(1536), formatBytes(8151 * 1024 * 1024), formatBytes(NaN)],
        ['512 B', '1.5 KiB', '8.0 GiB', '—']);
    eq([formatRate(0), formatRate(1250), formatRate(12.5e6)], ['0 bit/s', '10.0 kbit/s', '100 Mbit/s']);
});

// ── async: escalate() ladder (no real processes involved) ──────────────────
const loop = new GLib.MainLoop(null, false);
async function asyncTests() {
    const scope = new Scope();
    const sent = [];
    // Target dies after the second signal.
    let life = 2;
    let r = await escalate({signals: ['HUP', 'TERM', 'KILL'], scope, what: 'x',
        send: async sig => { sent.push(sig); life--; return {ok: true, status: 0, stderr: ''}; },
        alive: async () => life > 0});
    test('escalate stops as soon as the target is gone', () => {
        eq(sent, ['HUP', 'TERM']);
        eq(r, {ok: true, message: 'Stopped x'});
    });
    // Already gone: pkill-style status 1 counts as success.
    r = await escalate({signals: ['TERM'], scope, what: 'y',
        send: async () => ({ok: false, status: 1, stderr: ''}), alive: async () => false});
    test('escalate treats "nothing matched" as already gone', () => eq(r.ok, true));
    // A blocker mid-ladder (status 2) stops with its reason.
    r = await escalate({signals: ['TERM', 'KILL'], scope, what: 'z',
        send: async () => ({ok: false, status: 2, stderr: 'PID 9 is now bash, not ssh'}), alive: async () => true});
    test('escalate stops on a mid-ladder block and reports why', () =>
        eq(r, {ok: false, message: 'PID 9 is now bash, not ssh'}));

    // ── Hub: render discipline, coalescing, details gating ─────────────────
    const fakeSettings = (over = {}) => {
        const handlers = new Map();
        let next = 1;
        return {
            connect: (sig, fn) => { handlers.set(next, {sig, fn}); return next++; },
            disconnect: id => handlers.delete(id),
            get_boolean: k => over[k] ?? (k.startsWith('enable-') ? k === 'enable-ports' : true),
            get_int: () => 3600,
            get_string: () => '',
            fire: sig => [...handlers.values()].filter(h => h.sig === sig).forEach(h => h.fn()),
            set: (k, v) => { over[k] = v; },
        };
    };
    const deferred = () => { let resolve; const p = new Promise(r => { resolve = r; }); return {p, resolve}; };
    const makeSources = ports => Object.fromEntries(SOURCE_IDS.map(id => [id,
        id === 'ports' ? ports : {fetch: async () => null, count: () => 0}]));
    const tick = () => new Promise(r => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            r();
            return GLib.SOURCE_REMOVE;
        });
    });

    {
        const hubScope = new Scope();
        const calls = {fetch: 0, details: 0};
        let gate = deferred();
        const ports = {
            displayKeys: ['port-range-min'],
            detailsGapMs: 0,
            fetch: async () => { calls.fetch++; await gate.p; return ['p']; },
            fetchDetails: async () => { calls.details++; return {n: calls.details}; },
            count: d => d.length,
        };
        const settings = fakeSettings();
        const hub = new Hub(settings, hubScope, makeSources(ports));
        const events = [];
        hub.connect('changed', id => id === 'ports' && events.push('changed'));
        hub.connect('loading', id => id === 'ports' && events.push('loading'));
        hub.start();                       // enable → forced refresh starts (gated)
        hub.refresh('ports', {force: true}); // during flight: must coalesce, not spawn
        hub.refresh('ports');                // plain duplicate: ignored
        test('Hub never runs two fetches of a source at once', () => eq(calls.fetch, 1));
        events.length = 0;
        gate.resolve(); gate = deferred();
        await tick(); await tick();
        test('Hub emits exactly one changed per completed fetch (follow-up still in flight)', () => {
            eq(events.filter(e => e === 'changed').length, 1);
            eq(events.includes('loading'), true);
        });
        test('Hub runs the queued forced refresh once after the first finishes', () => eq(calls.fetch, 2));
        test('Hub does not fetch details for a source that is not visible', () => eq(calls.details, 0));
        hub.setVisible('ports');
        await tick();
        test('Hub fetches details as soon as a source becomes visible', () => {
            eq(calls.details, 1);
            eq(hub.state.ports.details, {n: 1});
        });
        events.length = 0;
        settings.fire('changed::port-range-min');
        test('Hub re-renders on a source\'s displayKeys without fetching', () => {
            eq(events, ['changed']);
            eq(calls.fetch, 2);
        });
        // Disable while a fetch is in flight: its late result must be dropped.
        settings.set('enable-ports', false);
        settings.fire('changed::enable-ports');
        gate.resolve();
        await tick(); await tick();
        test('Hub drops in-flight results and details when a source is disabled', () => {
            eq(hub.state.ports.data, null);
            eq(hub.state.ports.details, null);
            eq(hub.display('ports'), null);
        });
        hub.destroy();
        hubScope.dispose();
    }

    // ── hub.display(): one model for counts and gauges ─────────────────────
    {
        const sc = new Scope();
        const str = v => ({get_string: () => v});
        const sys = new SystemSource(sc);
        const data = {cpu: {total: 72.4}, memPct: 41.6, cpuTemp: 91};
        test('System gauge: cpu / memory / temp with matching unit and level', () => {
            eq(sys.gauge(data, str('cpu')), {value: 72, unit: '%', level: 'warn'});
            eq(sys.gauge(data, str('memory')), {value: 42, unit: '%', level: 'ok'});
            eq(sys.gauge(data, str('temp')), {value: 91, unit: '°', level: 'critical'});
            eq(sys.gauge({...data, cpuTemp: null}, str('temp')), {value: 72, unit: '%', level: 'warn'});
        });
        const claude = new ClaudeSource(sc);
        const usage = {windows: parseUsage({five_hour: {utilization: 95}, seven_day: {utilization: 10}})};
        test('Claude gauge follows the window preference', () => {
            eq(claude.gauge(usage, str('5h')), {value: 95, unit: '%', level: 'critical'});
            eq(claude.gauge(usage, str('7d')), {value: 10, unit: '%', level: 'ok'});
            eq(claude.gauge({windows: []}, str('max')), null);
        });
        const settings = fakeSettings({'enable-ports': true, 'enable-system': true});
        const sources = makeSources({fetch: async () => [1, 2, 3], count: d => d.length});
        sources.system = {fetch: async () => data, gauge: (d, st) => sys.gauge(d, st)};
        const hub = new Hub({...settings, get_string: () => 'temp'}, sc, sources);
        hub.start();
        await tick(); await tick();
        test('hub.display: counts and gauges share one shape', () => {
            eq(hub.display('ports'), {value: 3, text: '3', level: null, quiet: false});
            eq(hub.display('system'), {value: 91, text: '91°', level: 'critical', quiet: false});
            eq(hub.display('docker'), null); // disabled
        });
        hub.destroy();
        claude.destroy();
        sc.dispose();
    }
    scope.dispose();
}
asyncTests().catch(e => failures.push(`✗ async tests crashed: ${e.stack}`)).finally(() => loop.quit());
loop.run();

// ── report ────────────────────────────────────────────────────────────────
for (const f of failures)
    print(f);
print(`\n${passed} passed, ${failures.length} failed`);
System.exit(failures.length ? 1 : 0);
