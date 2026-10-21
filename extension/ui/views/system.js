// SPDX-License-Identifier: MIT
//
// Local host metrics, laid out like Termix's Host Metrics widgets:
// CPU, memory, GPU, network, disks, battery and top processes.

import {formatDuration, usageLevel} from '../../lib/format.js';
import {formatBytes, formatRate} from '../../lib/procfs.js';
import {coreStrip, hbox, label, sparkline, usageBar, vbox} from '../widgets.js';
import {SourceView} from './base.js';

function card(title, value = '', level = null) {
    const box = vbox({style_class: 'opsdeck-usage', x_expand: true});
    const head = hbox({x_expand: true});
    head.add_child(label(title, 'opsdeck-usage-title', {x_expand: true}));
    if (value)
        head.add_child(label(value, `opsdeck-usage-pct ${level ? `opsdeck-level-${level}` : 'opsdeck-usage-plain'}`));
    box.add_child(head);
    return box;
}

const pct = v => `${Math.round(v)}%`;

export class SystemView extends SourceView {
    constructor(ctx) {
        super(ctx, 'system');
    }

    showToolbar() {
        return false;
    }

    build(list, d) {
        const details = this.ctx.hub.state.system.details;
        const [l1, l5, l15] = d.load;

        list.add_child(label(`${d.hostname} · Linux ${d.kernel} · up ${formatDuration(d.uptime * 1000)} · ` +
            `load ${l1.toFixed(2)} ${l5.toFixed(2)} ${l15.toFixed(2)}`, 'opsdeck-note'));

        // CPU
        const cpu = card('CPU', pct(d.cpu.total), usageLevel(d.cpu.total));
        cpu.add_child(label([`${d.cpu.cores.length} threads`,
            d.cpuTemp !== null && `${d.cpuTemp} °C`].filter(Boolean).join(' · '), 'opsdeck-meta'));
        cpu.add_child(sparkline([d.history.cpu], {max: 100}));
        cpu.add_child(coreStrip(d.cpu.cores));
        list.add_child(cpu);

        // Memory
        const mem = card('Memory', pct(d.memPct), usageLevel(d.memPct));
        mem.add_child(usageBar(d.memPct, usageLevel(d.memPct)));
        mem.add_child(label(`${formatBytes(d.mem.used)} of ${formatBytes(d.mem.total)}` +
            (d.mem.swapTotal ? ` · swap ${formatBytes(d.mem.swapUsed)} of ${formatBytes(d.mem.swapTotal)}` : ''),
        'opsdeck-meta'));
        list.add_child(mem);

        // GPU(s)
        for (const g of details?.gpus ?? [])
            list.add_child(this._gpuCard(g));

        // Network
        const rx = d.net.reduce((a, n) => a + n.rx, 0);
        const tx = d.net.reduce((a, n) => a + n.tx, 0);
        const net = card('Network', `↓ ${formatRate(rx)}  ↑ ${formatRate(tx)}`);
        net.add_child(sparkline([d.history.rx, d.history.tx]));
        for (const n of d.net.filter(i => i.rx + i.tx > 0).slice(0, 4))
            net.add_child(label(`${n.name}  ↓ ${formatRate(n.rx)}  ↑ ${formatRate(n.tx)}`, 'opsdeck-meta'));
        list.add_child(net);

        if (!details) {
            list.add_child(label('Reading disks, GPU, battery and processes…', 'opsdeck-note'));
            return;
        }

        // Disks
        if (details.disks.length) {
            const disks = card('Disks');
            for (const k of details.disks) {
                const row = hbox({x_expand: true});
                row.add_child(label(k.mount, 'opsdeck-row-title', {x_expand: true}));
                row.add_child(label(pct(k.pct), `opsdeck-meta opsdeck-level-${usageLevel(k.pct)}`));
                disks.add_child(row);
                disks.add_child(usageBar(k.pct, usageLevel(k.pct)));
                disks.add_child(label(`${formatBytes(k.used)} of ${formatBytes(k.used + k.free)} · ${k.fstype} · ${k.device}`,
                    'opsdeck-meta'));
            }
            list.add_child(disks);
        }

        // Battery
        const b = details.battery;
        if (b) {
            const level = b.status === 'Discharging' ? usageLevel(100 - b.capacity) : null;
            const bat = card('Battery', `${b.capacity}%`, level);
            bat.add_child(label([b.status, b.watts ? `${b.watts.toFixed(1)} W` : null].filter(Boolean).join(' · '),
                'opsdeck-meta'));
            list.add_child(bat);
        }

        // Processes
        if (details.processes?.length) {
            this.heading(list, 'Top processes · CPU');
            for (const p of details.processes)
                list.add_child(this._processRow(p));
        }
    }

    _gpuCard(g) {
        if (g.asleep) {
            const c = card(g.name, 'asleep');
            c.add_child(label('Not polled while suspended, so it stays asleep and saves battery.', 'opsdeck-meta'));
            return c;
        }
        if (g.vendor === 'intel') {
            // i915 has no utilisation counter; the current clock is the best proxy.
            const c = card(g.name, g.freq > 0 ? `${g.freq} MHz` : 'idle');
            if (g.maxFreq)
                c.add_child(usageBar((g.freq / g.maxFreq) * 100, 'ok'));
            c.add_child(label(g.freq > 0 ? `clock ${g.freq}${g.maxFreq ? ` of ${g.maxFreq}` : ''} MHz`
                : 'powered down (RC6)', 'opsdeck-meta'));
            return c;
        }
        const util = g.util ?? 0;
        const c = card(g.name, pct(util), usageLevel(util));
        c.add_child(usageBar(util, usageLevel(util)));
        c.add_child(label([
            g.memTotal ? `VRAM ${formatBytes(g.memUsed)} of ${formatBytes(g.memTotal)}` : null,
            g.temp !== null && g.temp !== undefined ? `${g.temp} °C` : null,
            g.power !== null && g.power !== undefined ? `${g.power.toFixed(1)} W` : null,
        ].filter(Boolean).join(' · '), 'opsdeck-meta'));
        return c;
    }

    _processRow(p) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        info.add_child(label(p.label ?? p.command, 'opsdeck-row-title'));
        info.add_child(label(`PID ${p.pid} · ${p.user} · ${formatBytes(p.rss)}`, 'opsdeck-meta'));
        row.add_child(info);
        // top reports % of one core, so 400% means four busy cores.
        row.add_child(label(`${p.cpu.toFixed(0)}%`, `opsdeck-usage-pct opsdeck-proc-cpu`));
        if (p.own) {
            row.add_child(this.actionButton({
                key: `system:kill:${p.pid}`, iconName: 'process-stop-symbolic', confirmText: 'Kill?',
                variant: 'danger', accessibleName: `Kill ${p.label ?? p.command} (PID ${p.pid})`,
                run: () => this.ctx.hub.sources.system.kill(p),
            }));
        }
        return row;
    }
}
