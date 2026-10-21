// SPDX-License-Identifier: MIT

import {matchesContainer} from '../../sources/docker.js';
import {copyButton, hbox, label, vbox} from '../widgets.js';
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

        const hiddenStopped = !showStopped && containers.length > 0;
        this.renderFiltered(list, shown, c => this._row(c), {
            maxRows: MAX_ROWS,
            emptyIcon: 'package-x-generic-symbolic',
            emptyTitle: hiddenStopped ? 'No running containers' : 'No containers',
            emptyHint: hiddenStopped ? `${containers.length} stopped (hidden in Settings)` : '',
        });
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
        const stats = c.running ? this.ctx.hub.state.docker.details?.get(c.id) : null;
        if (stats)
            side.add_child(label(`CPU ${stats.cpu} · ${stats.mem}`, 'opsdeck-meta opsdeck-stats'));
        top.add_child(side);
        row.add_child(top);

        const actions = hbox({style_class: 'opsdeck-row-actions opsdeck-row-actions-below'});
        const docker = this.ctx.hub.sources.docker;
        const verb = (v, text, destructive) => this.actionButton({
            key: `docker:${v}:${c.id}`, text, busyText: `${text}…`,
            confirmText: destructive ? `${text}?` : undefined,
            variant: destructive ? 'danger' : 'suggested',
            accessibleName: `${text} ${c.name}`,
            run: () => docker.act(v, c),
        });
        const window = (v, text, accessibleName, open) => this.actionButton({
            key: `docker:${v}:${c.id}`, text, accessibleName, closesMenu: true, refresh: false, run: open,
        });
        if (c.running) {
            actions.add_child(verb('stop', 'Stop', true));
            actions.add_child(verb('restart', 'Restart', true));
            actions.add_child(window('shell', 'Shell', `Open a shell in ${c.name}`, () => docker.openShell(c)));
        } else {
            actions.add_child(verb('start', 'Start', false));
        }
        actions.add_child(window('logs', 'Logs', `Follow logs of ${c.name}`, () => docker.openLogs(c)));
        actions.add_child(copyButton(() => c.id, `Copy ID of ${c.name}`));
        row.add_child(actions);
        return row;
    }
}
