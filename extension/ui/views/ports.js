// SPDX-License-Identifier: MIT

import {hostPortIndex} from '../../sources/docker.js';
import {describePort, matchesPort, visiblePorts} from '../../sources/ports.js';
import {matchesQuery} from '../../lib/format.js';
import {chip, copyButton, hbox, label, vbox} from '../widgets.js';
import {SourceView} from './base.js';

const MAX_ROWS = 60;

export class PortsView extends SourceView {
    constructor(ctx) {
        super(ctx, 'ports', {searchHint: 'Filter by port, process, PID or container'});
        this.addToolbarButton(copyButton(() => this._visible.map(describePort).join('\n'), 'Copy visible ports'));
        this._visible = [];
    }

    build(list, entries) {
        // Docker publishes ports through root-owned docker-proxy (or nftables),
        // which ss can't attribute; label them with the owning container.
        this._containers = hostPortIndex(this.ctx.hub.state.docker.data);
        const shown = visiblePorts(entries, this.ctx.settings);
        this._visible = shown.filter(e => matchesPort(e, this.query) ||
            matchesQuery(this.query, this._container(e)?.name));

        const hidden = entries.length - shown.length;
        if (hidden)
            list.add_child(label(`${hidden} hidden by range/UDP settings`, 'opsdeck-note'));

        this.renderFiltered(list, this._visible, e => this._row(e), {
            maxRows: MAX_ROWS,
            emptyIcon: 'network-wired-disconnected-symbolic',
            emptyTitle: 'No listening ports',
        });
    }

    _row(e) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        row.add_child(label(`${e.port}`, 'opsdeck-port'));

        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        const proc = e.processes[0];
        const container = this._container(e);
        const title = hbox();
        if (container) {
            title.add_child(label(container.name, 'opsdeck-row-title'));
            title.add_child(chip('docker', 'in'));
        } else {
            // ss only reveals processes we may inspect; others belong to root/system users.
            title.add_child(label(proc ? proc.name : 'system process',
                proc ? 'opsdeck-row-title' : 'opsdeck-row-title opsdeck-dim'));
        }
        title.add_child(chip(e.proto.toUpperCase()));
        if (e.localOnly)
            title.add_child(chip('local', 'muted'));
        if (proc?.name === 'ssh')
            title.add_child(chip('tunnel', 'out'));
        info.add_child(title);
        const pids = e.processes.map(p => p.pid).join(', ');
        info.add_child(label([
            container && `→ container port ${container.containerPort}`,
            pids && `PID ${pids}`,
            e.hosts.join(' '),
        ].filter(Boolean).join(' · '), 'opsdeck-meta'));
        row.add_child(info);

        const actions = hbox({style_class: 'opsdeck-row-actions'});
        if (e.proto === 'tcp')
            actions.add_child(this.openUrlButton(`http://localhost:${e.port}`, `Open localhost:${e.port} in browser`));
        actions.add_child(copyButton(() => describePort(e), `Copy port ${e.port} details`));
        // Only a single owned process can be killed unambiguously.
        if (e.processes.length === 1 && proc.own) {
            actions.add_child(this.actionButton({
                key: `ports:kill:${proc.pid}`, iconName: 'process-stop-symbolic', confirmText: 'Kill?',
                variant: 'danger', accessibleName: `Kill ${proc.name} (PID ${proc.pid})`,
                run: () => this.ctx.hub.sources.ports.kill(proc),
            }));
        }
        row.add_child(actions);
        return row;
    }

    /** Container publishing this port, unless a visible non-docker process owns it. */
    _container(e) {
        const c = this._containers?.get(`${e.proto}/${e.port}`);
        if (!c)
            return null;
        const proc = e.processes[0];
        return !proc || proc.name === 'docker-proxy' ? c : null;
    }
}
