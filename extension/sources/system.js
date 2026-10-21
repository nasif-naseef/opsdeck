// SPDX-License-Identifier: MIT
//
// Local host metrics: the same data Termix's Host Metrics plugin gathers
// over SSH (CPU, memory, disk, network, temperature, GPU, processes), read
// directly from /proc and /sys on this machine.
//
// Cheap readings (CPU, memory, load, temperature, network counters) run on
// every poll so the top-bar counter and history stay continuous. Expensive
// ones (disks, GPU, battery, top processes) only run while the tab is open.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {procInfo, signalBlocker, signalLadder} from '../lib/process.js';
import {cpuPercent, describeCmdline, netRates, parseLoadavg, parseMeminfo, parseMounts, parseNetDev, parseNvidiaSmi,
    parseProcStat, parseTop, parseUptime, pickCpuTemp} from '../lib/procfs.js';
import {SourceError} from '../lib/source.js';
import {readText, run, which} from '../lib/subprocess.js';
import {usageLevel} from '../lib/format.js';

Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');

const HISTORY = 60;            // samples kept for sparklines
const DETAILS_MIN_GAP_MS = 2500;
const TOP_ROWS = 6;

/** Synchronous sysfs directory listing; only used once, for discovery. */
function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
    } catch {
        // missing on this machine
    }
    return names.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Every temperature sensor we can read, as {source, label, path}. */
function discoverTempSensors() {
    const sensors = [];
    for (const zone of listDir('/sys/class/thermal').filter(n => n.startsWith('thermal_zone'))) {
        const base = `/sys/class/thermal/${zone}`;
        if (exists(`${base}/temp`))
            sensors.push({source: 'thermal', typePath: `${base}/type`, label: null, path: `${base}/temp`});
    }
    for (const hw of listDir('/sys/class/hwmon')) {
        const base = `/sys/class/hwmon/${hw}`;
        for (const f of listDir(base).filter(n => /^temp\d+_input$/.test(n))) {
            sensors.push({source: 'hwmon', typePath: `${base}/name`,
                labelPath: `${base}/${f.replace('_input', '_label')}`, path: `${base}/${f}`});
        }
    }
    return sensors;
}

/** DRM cards with their vendor, e.g. {vendor: 'nvidia', card: '/sys/class/drm/card2'}. */
function discoverGpus() {
    const vendors = {'0x10de': 'nvidia', '0x8086': 'intel', '0x1002': 'amd'};
    const gpus = [];
    for (const card of listDir('/sys/class/drm').filter(n => /^card\d+$/.test(n))) {
        const base = `/sys/class/drm/${card}`;
        const [ok, bytes] = (() => {
            try {
                return GLib.file_get_contents(`${base}/device/vendor`);
            } catch {
                return [false, null];
            }
        })();
        const vendor = ok ? vendors[new TextDecoder().decode(bytes).trim()] : null;
        if (vendor)
            gpus.push({vendor, card: base});
    }
    return gpus;
}

export class SystemSource {
    id = 'system';
    displayKeys = ['system-panel-metric'];

    constructor(scope) {
        this._scope = scope;
        this._prevStat = null;
        this._prevNet = null;
        this._sensors = null;
        this._gpus = null;
        this._history = {cpu: [], mem: [], rx: [], tx: []};
        this._hostname = GLib.get_host_name();
        this._kernel = null;
    }

    async fetch() {
        const read = p => readText(p, this._scope.cancellable);

        let stat = await read('/proc/stat');
        if (stat === null)
            throw new SourceError('missing', '/proc is not readable');
        stat = parseProcStat(stat);
        if (!this._prevStat) {
            // First reading: take a short second sample so CPU % is real.
            this._prevStat = stat;
            this._prevNet = {at: GLib.get_monotonic_time(), dev: parseNetDev(await read('/proc/net/dev') ?? '')};
            await this._scope.sleep(400);
            stat = parseProcStat(await read('/proc/stat') ?? '');
        }

        const [meminfo, loadavg, uptime, netdev, cpuTemp] = await Promise.all([
            read('/proc/meminfo'), read('/proc/loadavg'), read('/proc/uptime'), read('/proc/net/dev'),
            this._cpuTemp(),
        ]);
        this._kernel ??= (await read('/proc/sys/kernel/osrelease'))?.trim() ?? '';

        const cpu = {
            total: cpuPercent(this._prevStat.total, stat.total) ?? 0,
            // Online CPUs in id order; a CPU that just came online reads 0 once.
            cores: [...stat.cores].sort(([a], [b]) => a - b)
                .map(([id, c]) => cpuPercent(this._prevStat.cores.get(id), c) ?? 0),
        };
        this._prevStat = stat;

        const now = GLib.get_monotonic_time();
        const dev = parseNetDev(netdev ?? '');
        const net = netRates(this._prevNet?.dev, dev, (now - (this._prevNet?.at ?? now)) / 1e6);
        this._prevNet = {at: now, dev};

        const mem = parseMeminfo(meminfo ?? '');
        const memPct = mem.total ? (mem.used / mem.total) * 100 : 0;
        this._push('cpu', cpu.total);
        this._push('mem', memPct);
        this._push('rx', net.reduce((a, n) => a + n.rx, 0));
        this._push('tx', net.reduce((a, n) => a + n.tx, 0));

        return {
            hostname: this._hostname,
            kernel: this._kernel,
            uptime: parseUptime(uptime ?? '0'),
            load: parseLoadavg(loadavg ?? '0 0 0'),
            cpu,
            cpuTemp,
            mem,
            memPct,
            net,
            // Snapshot for the sparklines (the ring buffers keep mutating).
            history: Object.fromEntries(Object.entries(this._history).map(([k, v]) => [k, [...v]])),
        };
    }

    _push(key, value) {
        const h = this._history[key];
        h.push(value);
        if (h.length > HISTORY)
            h.shift();
    }

    async _cpuTemp() {
        this._sensors ??= discoverTempSensors();
        const read = p => readText(p, this._scope.cancellable);
        const readings = await Promise.all(this._sensors.map(async s => {
            const [raw, type, label] = await Promise.all([
                read(s.path), s.type === undefined ? read(s.typePath) : s.type,
                s.labelPath ? read(s.labelPath) : null]);
            s.type = type?.trim() ?? ''; // cache: sensor names don't change
            return {source: s.type, label: label?.trim() ?? '', celsius: Number(raw) / 1000};
        }));
        const t = pickCpuTemp(readings);
        return t === null ? null : Math.round(t);
    }

    /** Disks, GPUs, battery and top processes; the Hub only asks while the tab is open. */
    async fetchDetails() {
        const [disks, gpus, battery, processes] = await Promise.all([
            this._disks(), this._gpuStats(), this._battery(), this._topProcesses()]);
        return {disks, gpus, battery, processes};
    }

    async _disks() {
        const mounts = parseMounts(await readText('/proc/mounts', this._scope.cancellable) ?? '');
        const out = await Promise.all(mounts.map(async m => {
            try {
                const info = await Gio.File.new_for_path(m.mount).query_filesystem_info_async(
                    'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_DEFAULT,
                    this._scope.cancellable);
                const used = info.get_attribute_uint64('filesystem::used');
                const free = info.get_attribute_uint64('filesystem::free');
                // Like df: percentage of what's usable by non-root users.
                return {...m, used, free, size: info.get_attribute_uint64('filesystem::size'),
                    pct: used + free ? (used / (used + free)) * 100 : 0};
            } catch {
                return null;
            }
        }));
        return out.filter(d => d && d.size > 0);
    }

    async _gpuStats() {
        this._gpus ??= discoverGpus();
        const read = p => readText(p, this._scope.cancellable);
        const out = [];
        let nvidiaDone = false;
        for (const g of this._gpus) {
            if (g.vendor === 'nvidia') {
                if (nvidiaDone)
                    continue;
                nvidiaDone = true;
                // Calling nvidia-smi wakes a runtime-suspended dGPU (and drains
                // the battery on hybrid laptops), so leave a sleeping one alone.
                const state = (await read(`${g.card}/device/power/runtime_status`))?.trim();
                if (state === 'suspended' || state === 'suspending') {
                    out.push({vendor: 'nvidia', name: 'NVIDIA GPU', asleep: true});
                    continue;
                }
                const smi = which('nvidia-smi');
                if (!smi)
                    continue;
                const r = await run([smi, '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
                    '--format=csv,noheader,nounits'], {cancellable: this._scope.cancellable, timeoutMs: 4000});
                if (r.ok)
                    out.push(...parseNvidiaSmi(r.stdout).map(x => ({vendor: 'nvidia', ...x})));
            } else if (g.vendor === 'intel') {
                const [cur, max] = await Promise.all([read(`${g.card}/gt_act_freq_mhz`), read(`${g.card}/gt_max_freq_mhz`)]);
                if (cur !== null)
                    out.push({vendor: 'intel', name: 'Intel graphics', freq: Number(cur), maxFreq: Number(max) || null});
            } else if (g.vendor === 'amd') {
                const dev = `${g.card}/device`;
                const [busy, used, total] = await Promise.all([read(`${dev}/gpu_busy_percent`),
                    read(`${dev}/mem_info_vram_used`), read(`${dev}/mem_info_vram_total`)]);
                if (busy !== null) {
                    out.push({vendor: 'amd', name: 'AMD GPU', util: Number(busy),
                        memUsed: used === null ? null : Number(used), memTotal: total === null ? null : Number(total)});
                }
            }
        }
        return out;
    }

    async _battery() {
        const bat = listDir('/sys/class/power_supply').find(n => /^BAT\d+$/.test(n));
        if (!bat)
            return null;
        const base = `/sys/class/power_supply/${bat}`;
        const read = f => readText(`${base}/${f}`, this._scope.cancellable).then(v => v?.trim() ?? null);
        const [capacity, status, powerNow, currentNow, voltageNow] = await Promise.all(
            ['capacity', 'status', 'power_now', 'current_now', 'voltage_now'].map(read));
        let watts = powerNow !== null ? Number(powerNow) / 1e6 : null;
        if (watts === null && currentNow !== null && voltageNow !== null)
            watts = (Number(currentNow) * Number(voltageNow)) / 1e12;
        return {capacity: Number(capacity), status: status ?? 'Unknown', watts};
    }

    async _topProcesses() {
        const top = which('top');
        if (!top)
            return null;
        const r = await run([top, '-b', '-n', '2', '-d', '0.5', '-w', '512', '-o', '%CPU'],
            {cancellable: this._scope.cancellable, timeoutMs: 5000});
        if (!r.ok)
            return null;
        const rows = parseTop(r.stdout).filter(p => p.command !== 'top').slice(0, TOP_ROWS);
        // One /proc read per row: real ownership (top truncates long user
        // names) and what the process is running (top only has its name).
        await Promise.all(rows.map(async p => {
            const info = await procInfo(p.pid, this._scope.cancellable);
            p.own = signalBlocker(info, {expectComm: p.command}) === null;
            p.label = (info && describeCmdline(info.argv)) || p.command;
        }));
        return rows;
    }

    count(data, settings) {
        const pref = settings.get_string('system-panel-metric');
        // Machines without a readable CPU sensor fall back to CPU %.
        this._unit = pref === 'temp' && data.cpuTemp !== null ? '°' : '%';
        if (this._unit === '°')
            return data.cpuTemp;
        return Math.round(pref === 'memory' ? data.memPct : data.cpu.total);
    }

    formatCount(value) {
        return `${value}${this._unit ?? '%'}`;
    }

    level(value) {
        if (this._unit === '°')
            return value >= 90 ? 'critical' : value >= 80 ? 'warn' : 'ok';
        return usageLevel(value);
    }

    /** @param {{pid: number, command: string}} proc - as listed, so a recycled PID is refused */
    kill(proc) {
        return signalLadder(proc.pid, this._scope, {expectComm: proc.command});
    }

    destroy() {}
}
