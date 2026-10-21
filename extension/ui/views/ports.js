// SPDX-License-Identifier: MIT

import Gio from 'gi://Gio';

import {describePort, matchesPort, visiblePorts} from '../../sources/ports.js';
import {button, chip, copyToClipboard, emptyState, hbox, label, vbox} from '../widgets.js';
import {SourceView} from './base.js';

const MAX_ROWS = 60;

export class PortsView extends SourceView {
    constructor(ctx) {
        super(ctx, 'ports', {searchHint: 'Filter by port, process or PID'});
        this.addToolbarButton(button({
            iconName: 'edit-copy-symbolic',
            styleClass: 'opsdeck-button opsdeck-button-icon-only',
            accessibleName: 'Copy visible ports',
            onClick: () => copyToClipboard(this._visible.map(describePort).join('\n')),
        }));
        this._visible = [];
    }

    build(list, entries) {
        const shown = visiblePorts(entries, this.ctx.settings);
        this._visible = shown.filter(e => matchesPort(e, this.query));

        const hidden = entries.length - shown.length;
        if (hidden)
            list.add_child(label(`${hidden} hidden by range/UDP settings`, 'opsdeck-note'));

        if (!this._visible.length) {
            list.add_child(emptyState({
                iconName: 'network-wired-disconnected-symbolic',
                title: this.query ? `Nothing matches “${this.query.trim()}”` : 'No listening ports',
            }));
            return;
        }

        for (const e of this._visible.slice(0, MAX_ROWS))
            list.add_child(this._row(e));
        if (this._visible.length > MAX_ROWS)
            list.add_child(label(`… ${this._visible.length - MAX_ROWS} more, refine the filter`, 'opsdeck-note'));
    }

    _row(e) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        row.add_child(label(`${e.port}`, 'opsdeck-port'));

        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        const proc = e.processes[0];
        const title = hbox();
        // ss only reveals processes we may inspect; others belong to root/system users.
        title.add_child(label(proc ? proc.name : 'system process',
            proc ? 'opsdeck-row-title' : 'opsdeck-row-title opsdeck-dim'));
        title.add_child(chip(e.proto.toUpperCase()));
        if (e.localOnly)
            title.add_child(chip('local', 'muted'));
        info.add_child(title);
        const pids = e.processes.map(p => p.pid).join(', ');
        info.add_child(label([pids && `PID ${pids}`, e.hosts.join(' ')].filter(Boolean).join(' · '),
            'opsdeck-meta'));
        row.add_child(info);

        const actions = hbox({style_class: 'opsdeck-row-actions'});
        if (e.proto === 'tcp') {
            actions.add_child(button({
                iconName: 'web-browser-symbolic',
                styleClass: 'opsdeck-button opsdeck-button-icon-only',
                accessibleName: `Open localhost:${e.port} in browser`,
                onClick: () => {
                    this.ctx.closeMenu();
                    Gio.AppInfo.launch_default_for_uri_async(`http://localhost:${e.port}`, null, null, null);
                },
            }));
        }
        actions.add_child(button({
            iconName: 'edit-copy-symbolic',
            styleClass: 'opsdeck-button opsdeck-button-icon-only',
            accessibleName: `Copy port ${e.port} details`,
            onClick: () => copyToClipboard(describePort(e)),
        }));
        // Only a single owned process can be killed unambiguously.
        if (e.processes.length === 1 && proc.own)
            actions.add_child(this._killButton(proc));
        row.add_child(actions);
        return row;
    }

    _killButton(proc) {
        const key = `ports:kill:${proc.pid}`;
        const busy = this.ctx.isBusy(key);
        const armed = this.ctx.confirm.isArmed(key);
        return button({
            label: busy ? '…' : armed ? 'Kill?' : undefined,
            iconName: busy || armed ? undefined : 'process-stop-symbolic',
            styleClass: `opsdeck-button opsdeck-button-danger ${armed ? 'opsdeck-armed' : 'opsdeck-button-icon-only'}`,
            accessibleName: armed ? `Confirm killing ${proc.name} (PID ${proc.pid})` : `Kill ${proc.name} (PID ${proc.pid})`,
            sensitive: !busy,
            onClick: () => {
                if (this.ctx.confirm.confirm(key))
                    this.ctx.runAction('ports', key, () => this.ctx.hub.sources.ports.kill(proc.pid));
            },
        });
    }
}
