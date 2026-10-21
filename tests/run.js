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
import {inRange, matchesPort, parseListening} from '../extension/sources/ports.js';
import {parseEstablished, parseSshTarget, parseWho} from '../extension/sources/ssh.js';
import {classifyDockerError, parseContainers, parseLabels, publishedPorts} from '../extension/sources/docker.js';
import {panelPercent, parseCredentials, parseUsage} from '../extension/sources/claude.js';

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
    eq(ports.filter(p => inRange(p, 1024, 9999)).map(p => p.port), [1900, 5173, 5353, 8080, 9000]);
    eq(ports.filter(p => matchesPort(p, 'nginx')).map(p => p.port), [8080]);
    eq(ports.filter(p => matchesPort(p, '4242')).map(p => p.port), [5173]);
    eq(ports.filter(p => matchesPort(p, 'udp')).length, 3);
});

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
    eq(parseSshTarget(['ssh', 'deploy@web-1']), 'deploy@web-1');
    eq(parseSshTarget(['ssh', '-p', '2222', '-i', '/k', 'web-1', 'uptime']), 'web-1');
    eq(parseSshTarget(['/usr/bin/ssh', '-l', 'root', '-A', 'db']), 'root@db');
    eq(parseSshTarget(['ssh', '-lroot', 'db']), 'root@db');
    eq(parseSshTarget(['ssh', '-NL', '8080:localhost:80', 'bastion']), 'bastion');
    eq(parseSshTarget(['ssh', '-o', 'StrictHostKeyChecking=no', '--', 'h']), 'h');
    eq(parseSshTarget(['ssh', 'ssh://me@h:2200']), 'ssh://me@h:2200');
    eq(parseSshTarget(['ssh', '-v']), null);
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

test('panelPercent preference', () => {
    const w = parseUsage({five_hour: {utilization: 20}, seven_day: {utilization: 60}});
    eq([panelPercent(w, '5h'), panelPercent(w, '7d'), panelPercent(w, 'max')], [20, 60, 60]);
    eq(panelPercent(parseUsage({seven_day: {utilization: 5}}), '5h'), 5);
    eq(panelPercent([], 'max'), null);
});

// ── report ────────────────────────────────────────────────────────────────
for (const f of failures)
    print(f);
print(`\n${passed} passed, ${failures.length} failed`);
System.exit(failures.length ? 1 : 0);
