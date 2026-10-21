// SPDX-License-Identifier: MIT

import {matchesContainer} from '../../sources/docker.js';
import {button, copyToClipboard, emptyState, hbox, label, vbox} from '../widgets.js';
import {SourceView} from './base.js';

const MAX_ROWS = 40;

export class DockerView extends SourceView {
    constructor(ctx) {
        super(ctx, 'docker', {searchHint: 'Filter by name, image, project or port'});
    }

    showToolbar(containers) {
        return containers.length > 0;
    }

    build(list, containers) {
        const showStopped = this.ctx.settings.get_boolean('docker-show-stopped');
        const shown = containers
            .filter(c => showStopped || c.running)
            .filter(c => matchesContainer(c, this.query));

        if (!shown.length) {
            const hiddenStopped = !showStopped && containers.length > 0;
            list.add_child(emptyState({
                iconName: 'package-x-generic-symbolic',
                title: this.query ? `Nothing matches “${this.query.trim()}”`
                    : hiddenStopped ? 'No running containers' : 'No containers',
                hint: hiddenStopped && !this.query ? `${containers.length} stopped (hidden in Settings)` : '',
            }));
            return;
        }

        for (const c of shown.slice(0, MAX_ROWS))
            list.add_child(this._row(c));
        if (shown.length > MAX_ROWS)
            list.add_child(label(`… ${shown.length - MAX_ROWS} more, refine the filter`, 'opsdeck-note'));
    }

    _row(c) {
        const row = vbox({style_class: 'opsdeck-row opsdeck-row-stacked', x_expand: true});

        const top = hbox({x_expand: true});
        top.add_child(label('●', `opsdeck-dot opsdeck-state-${c.state}`));
        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        info.add_child(label(c.name, 'opsdeck-row-title'));
        const image = c.image.split('/').pop();
        info.add_child(label([c.project, image, ...c.ports].filter(Boolean).join(' · '), 'opsdeck-meta'));
        top.add_child(info);
        const side = vbox({style_class: 'opsdeck-row-side'});
        side.add_child(label(c.status, `opsdeck-status opsdeck-state-${c.state}`));
        const stats = c.running ? this.ctx.hub.sources.docker.stats.get(c.id) : null;
        if (stats)
            side.add_child(label(`CPU ${stats.cpu} · ${stats.mem}`, 'opsdeck-meta opsdeck-stats'));
        top.add_child(side);
        row.add_child(top);

        const actions = hbox({style_class: 'opsdeck-row-actions opsdeck-row-actions-below'});
        if (c.running) {
            actions.add_child(this._verbButton(c, 'stop', 'Stop', true));
            actions.add_child(this._verbButton(c, 'restart', 'Restart', true));
            actions.add_child(button({
                label: 'Shell',
                accessibleName: `Open a shell in ${c.name}`,
                onClick: () => {
                    this.ctx.closeMenu();
                    this.ctx.runAction('docker', `docker:shell:${c.id}`,
                        async () => this.ctx.hub.sources.docker.openShell(c));
                },
            }));
        } else {
            actions.add_child(this._verbButton(c, 'start', 'Start', false));
        }
        actions.add_child(button({
            label: 'Logs',
            accessibleName: `Follow logs of ${c.name}`,
            onClick: () => {
                this.ctx.closeMenu();
                this.ctx.runAction('docker', `docker:logs:${c.id}`,
                    async () => this.ctx.hub.sources.docker.openLogs(c));
            },
        }));
        actions.add_child(button({
            iconName: 'edit-copy-symbolic',
            styleClass: 'opsdeck-button opsdeck-button-icon-only',
            accessibleName: `Copy ID of ${c.name}`,
            onClick: () => copyToClipboard(c.id),
        }));
        row.add_child(actions);
        return row;
    }

    _verbButton(c, verb, text, destructive) {
        const key = `docker:${verb}:${c.id}`;
        const busy = this.ctx.isBusy(key);
        const armed = destructive && this.ctx.confirm.isArmed(key);
        return button({
            label: busy ? `${text}…` : armed ? `${text}?` : text,
            styleClass: `opsdeck-button ${destructive ? 'opsdeck-button-danger' : 'opsdeck-button-suggested'} ${armed ? 'opsdeck-armed' : ''}`,
            accessibleName: `${text} ${c.name}`,
            sensitive: !busy,
            onClick: () => {
                if (!destructive || this.ctx.confirm.confirm(key))
                    this.ctx.runAction('docker', key, () => this.ctx.hub.sources.docker.act(verb, c));
            },
        });
    }
}
