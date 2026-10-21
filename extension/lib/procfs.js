// SPDX-License-Identifier: MIT
//
// Pure parsers for /proc, /sys and a few CLI outputs used by the System
// module. Same sources as Termix's Host Metrics collectors, read locally.

const KIB = 1024;

/**
 * /proc/stat cpu lines → cumulative jiffies.
 *
 * @returns {{total: number[], cores: number[][]}} each entry [busy, idle]
 */
export function parseProcStat(text) {
    const out = {total: null, cores: []};
    for (const line of text.split('\n')) {
        const m = line.match(/^cpu(\d*)\s+(.+)$/);
        if (!m)
            continue;
        // user nice system idle iowait irq softirq steal guest guest_nice
        const v = m[2].trim().split(/\s+/).map(Number);
        const idle = (v[3] ?? 0) + (v[4] ?? 0);
        // guest time is already included in user/nice
        const busy = v.slice(0, 8).reduce((a, b) => a + b, 0) - idle;
        if (m[1] === '')
            out.total = [busy, idle];
        else
            out.cores[Number(m[1])] = [busy, idle];
    }
    return out;
}

/** Busy percentage between two [busy, idle] samples. */
export function cpuPercent(prev, cur) {
    if (!prev || !cur)
        return null;
    const busy = cur[0] - prev[0];
    const total = busy + (cur[1] - prev[1]);
    return total > 0 ? Math.max(0, Math.min(100, (busy / total) * 100)) : 0;
}

/** /proc/meminfo → bytes. Used = total − available, as free(1) does. */
export function parseMeminfo(text) {
    const kv = {};
    for (const m of text.matchAll(/^(\w+(?:\(\w+\))?):\s+(\d+)/gm))
        kv[m[1]] = Number(m[2]) * KIB;
    const total = kv.MemTotal ?? 0;
    const available = kv.MemAvailable ?? (kv.MemFree ?? 0) + (kv.Cached ?? 0) + (kv.Buffers ?? 0);
    const swapTotal = kv.SwapTotal ?? 0;
    return {
        total,
        used: Math.max(0, total - available),
        available,
        swapTotal,
        swapUsed: Math.max(0, swapTotal - (kv.SwapFree ?? 0)),
    };
}

/** /proc/loadavg → [1, 5, 15] minute load. */
export function parseLoadavg(text) {
    return text.trim().split(/\s+/).slice(0, 3).map(Number);
}

/** /proc/uptime → seconds. */
export function parseUptime(text) {
    return Math.floor(Number(text.trim().split(/\s+/)[0]) || 0);
}

// Virtual interfaces that would only double-count traffic.
const VIRTUAL_IF = /^(lo|docker\d*|br-[0-9a-f]+|veth.*|virbr\d*.*|vnet\d+|cni\d*|flannel.*|cali.*|kube-.*|podman\d*|lxc.*|lxdbr\d*|dummy\d*)$/;

/**
 * /proc/net/dev → cumulative byte counters for real interfaces.
 *
 * @returns {Map<string, {rx: number, tx: number}>}
 */
export function parseNetDev(text) {
    const out = new Map();
    for (const line of text.split('\n').slice(2)) {
        const m = line.match(/^\s*([^:\s]+):\s*(.+)$/);
        if (!m || VIRTUAL_IF.test(m[1]))
            continue;
        const v = m[2].trim().split(/\s+/).map(Number);
        out.set(m[1], {rx: v[0] ?? 0, tx: v[8] ?? 0});
    }
    return out;
}

/** Bytes/second between two parseNetDev() samples taken `seconds` apart. */
export function netRates(prev, cur, seconds) {
    const out = [];
    for (const [name, c] of cur) {
        const p = prev?.get(name);
        if (!p || seconds <= 0)
            continue;
        // Counters reset when an interface goes down and up again.
        out.push({name, rx: Math.max(0, (c.rx - p.rx) / seconds), tx: Math.max(0, (c.tx - p.tx) / seconds)});
    }
    return out.sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || a.name.localeCompare(b.name));
}

const DISK_FS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'zfs', 'vfat', 'exfat',
    'ntfs', 'ntfs3', 'fuseblk', 'bcachefs', 'reiserfs', 'jfs']);

/**
 * /proc/mounts → real, user-visible filesystems, one per block device.
 *
 * @returns {{device: string, mount: string, fstype: string}[]}
 */
export function parseMounts(text) {
    const out = [];
    const seen = new Set();
    for (const line of text.split('\n')) {
        const [device, rawMount, fstype] = line.split(' ');
        if (!device || !DISK_FS.has(fstype))
            continue;
        // /proc/mounts escapes spaces and friends as octal.
        const mount = rawMount.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
        if (/^\/(snap|var\/lib\/(docker|containers|snapd))\//.test(mount))
            continue;
        // btrfs subvolumes share a device; keep the first (usually "/").
        if (seen.has(device))
            continue;
        seen.add(device);
        out.push({device, mount, fstype});
    }
    return out;
}

/** "754844" (KiB), "1.8g", "11.2g", "512m" → bytes. top's RES column. */
export function parseTopMem(value) {
    const m = String(value).trim().match(/^([\d.]+)([kmgtpe]?)$/i);
    if (!m)
        return 0;
    const exp = {'': 1, k: 1, m: 2, g: 3, t: 4, p: 5, e: 6}[m[2].toLowerCase()];
    return Math.round(Number(m[1]) * KIB ** exp);
}

/**
 * Parse `top -b -n 2 ...`: the second iteration has real, current CPU usage
 * (the first is an average since each process started).
 *
 * @returns {{pid: number, user: string, cpu: number, mem: number, rss: number, command: string}[]}
 */
export function parseTop(text) {
    const blocks = text.split(/^\s*PID\s+USER\b.*$/m);
    const body = blocks.length > 2 ? blocks[2] : blocks[blocks.length - 1] ?? '';
    const out = [];
    for (const line of body.split('\n')) {
        const f = line.trim().split(/\s+/);
        // PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND...
        if (f.length < 12 || !/^\d+$/.test(f[0]))
            continue;
        out.push({
            pid: Number(f[0]),
            user: f[1],
            cpu: Number(f[8]) || 0,
            mem: Number(f[9]) || 0,
            rss: parseTopMem(f[5]),
            command: f.slice(11).join(' '),
        });
    }
    return out;
}

const INTERPRETERS = /^(python[\d.]*|node|nodejs|bun|deno|ruby|perl|php|java|bash|sh|zsh|dash|gjs|uv|npx|pnpm|npm|yarn)$/;

/**
 * Short, distinguishing label from a process's argv (NUL-split cmdline):
 * "python worker.py", "node vite", "java app.jar", or just the program.
 */
export function describeCmdline(argv) {
    const base = s => s.split('/').filter(Boolean).pop() ?? s;
    if (!argv.length)
        return null;
    const prog = base(argv[0]);
    if (!INTERPRETERS.test(prog))
        return prog;
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-m' || a === '-jar')
            return `${prog} ${base(argv[i + 1] ?? '')}`.trim();
        if (a === '-c' || a === '-e')
            return `${prog} ${a}`;
        if (!a.startsWith('-'))
            return `${prog} ${base(a)}`;
    }
    return prog;
}

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits` */
export function parseNvidiaSmi(text) {
    const num = s => {
        const n = Number(String(s).trim());
        return Number.isFinite(n) && String(s).trim() !== '' ? n : null;
    };
    const out = [];
    for (const line of text.split('\n')) {
        const f = line.split(',');
        if (f.length < 6)
            continue;
        // The name may contain commas; the five numeric fields are last.
        const tail = f.slice(-5);
        out.push({
            name: f.slice(0, f.length - 5).join(',').trim(),
            util: num(tail[0]),
            memUsed: num(tail[1]) === null ? null : num(tail[1]) * KIB * KIB,
            memTotal: num(tail[2]) === null ? null : num(tail[2]) * KIB * KIB,
            temp: num(tail[3]),
            power: num(tail[4]),
        });
    }
    return out;
}

/**
 * Pick the most meaningful CPU temperature from thermal zones / hwmon.
 *
 * @param {{source: string, label: string, celsius: number}[]} sensors
 */
export function pickCpuTemp(sensors) {
    const rank = s => {
        const k = `${s.source}/${s.label}`.toLowerCase();
        if (/x86_pkg_temp|package id|tctl|tdie|cpu_thermal|soc_thermal/.test(k))
            return 0;
        if (/coretemp|k10temp|zenpower|tcpu\b/.test(k))
            return 1;
        if (/acpitz|cpu/.test(k))
            return 2;
        return 9;
    };
    const best = [...sensors].filter(s => s.celsius > 0 && s.celsius < 150)
        .sort((a, b) => rank(a) - rank(b))[0];
    return best && rank(best) < 9 ? best.celsius : null;
}

/** 1536 → "1.5 KiB"; IEC units like free(1) -h and df -h. */
export function formatBytes(bytes, digits = 1) {
    if (!Number.isFinite(bytes))
        return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

/** Network rate, bits are what people compare against their link speed. */
export function formatRate(bytesPerSecond) {
    const bits = bytesPerSecond * 8;
    const units = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'];
    let i = 0;
    let v = bits;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
