// SPDX-License-Identifier: MIT

import {matchesSession} from '../../sources/ssh.js';
import {button, chip, emptyState, hbox, label, vbox} from '../widgets.js';
import {SourceView} from './base.js';

export class SshView extends SourceView {
    constructor(ctx) {
        super(ctx, 'ssh', {searchHint: 'Filter by user, host or TTY'});
    }

    showToolbar(data) {
        return data.incoming.length + data.outgoing.length > 0;
    }

    build(list, {incoming, outgoing}) {
        const inc = incoming.filter(s => matchesSession(s, this.query));
        const out = outgoing.filter(s => matchesSession(s, this.query));

        if (!inc.length && !out.length) {
            list.add_child(emptyState({
                iconName: 'network-idle-symbolic',
                title: this.query ? `Nothing matches “${this.query.trim()}”` : 'No SSH sessions',
                hint: this.query ? '' : 'Remote logins to this machine and ssh connections you open appear here.',
            }));
            return;
        }

        if (inc.length) {
            this.heading(list, `Incoming · ${inc.length}`);
            for (const s of inc)
                list.add_child(this._row(s, `${s.user}@${s.from}`, `${s.tty} · since ${s.since}`, `in:${s.tty}`));
        }
        if (out.length) {
            this.heading(list, `Outgoing · ${out.length}`);
            for (const s of out) {
                const peer = s.host.includes(':') ? `[${s.host}]:${s.port}` : `${s.host}:${s.port}`;
                list.add_child(this._row(s, s.target, `${peer} · PID ${s.pid}`, `out:${s.pid}`));
            }
        }
    }

    _row(session, title, meta, keySuffix) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        row.add_child(chip(session.direction === 'in' ? 'IN' : 'OUT', session.direction === 'in' ? 'in' : 'out'));
        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        info.add_child(label(title, 'opsdeck-row-title'));
        info.add_child(label(meta, 'opsdeck-meta'));
        row.add_child(info);

        if (!session.own) {
            row.add_child(label('other user', 'opsdeck-meta'));
            return row;
        }
        const key = `ssh:end:${keySuffix}`;
        const busy = this.ctx.isBusy(key);
        const armed = this.ctx.confirm.isArmed(key);
        row.add_child(button({
            label: busy ? 'Ending…' : armed ? 'End?' : 'End',
            styleClass: `opsdeck-button opsdeck-button-danger ${armed ? 'opsdeck-armed' : ''}`,
            accessibleName: `End SSH session ${title}`,
            sensitive: !busy,
            onClick: () => {
                if (this.ctx.confirm.confirm(key))
                    this.ctx.runAction('ssh', key, () => this.ctx.hub.sources.ssh.terminate(session));
            },
        }));
        return row;
    }
}
