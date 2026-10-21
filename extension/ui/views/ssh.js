// SPDX-License-Identifier: MIT

import {matchesSession} from '../../sources/ssh.js';
import {chip, copyButton, hbox, label, vbox} from '../widgets.js';
import {SourceView} from './base.js';

const FORWARD_KIND = {L: ['LOCAL', 'in'], R: ['REMOTE', 'out'], D: ['SOCKS', 'muted']};

/** "8080" → "localhost:8080"; keep explicit bind addresses. */
function listenAddress(listen) {
    return /^\d+$/.test(listen) ? `localhost:${listen}` : listen;
}

function describeForward(f, via) {
    const what = f.type === 'D' ? `SOCKS proxy on ${listenAddress(f.listen)}`
        : f.type === 'L' ? `${listenAddress(f.listen)} → ${f.to}`
            : `remote ${f.listen} → ${f.to ?? 'SOCKS'}`;
    return `${what} (via ${via})`;
}

export class SshView extends SourceView {
    constructor(ctx) {
        super(ctx, 'ssh', {searchHint: 'Filter by user, host, TTY or port'});
    }

    showToolbar(data) {
        return data.incoming.length + data.outgoing.length > 0;
    }

    build(list, {incoming, outgoing}) {
        const inc = incoming.filter(s => matchesSession(s, this.query));
        const out = outgoing.filter(s => matchesSession(s, this.query));

        if (!inc.length && !out.length) {
            this.emptyResult(list, 'network-idle-symbolic', 'No SSH sessions',
                'Remote logins to this machine and ssh connections you open appear here.');
            return;
        }

        const tunnels = out.flatMap(s => s.forwards.map(f => ({f, s})));
        if (tunnels.length) {
            this.heading(list, `Tunnels · ${tunnels.length}`);
            for (const {f, s} of tunnels)
                list.add_child(this._tunnelRow(f, s));
        }
        if (inc.length) {
            this.heading(list, `Incoming · ${inc.length}`);
            for (const s of inc)
                list.add_child(this._row(s, `${s.user}@${s.from}`, `${s.tty} · since ${s.since}`));
        }
        if (out.length) {
            this.heading(list, `Outgoing · ${out.length}`);
            for (const s of out) {
                const peer = s.host.includes(':') ? `[${s.host}]:${s.port}` : `${s.host}:${s.port}`;
                const fw = s.forwards.length ? ` · ${s.forwards.length} tunnel${s.forwards.length > 1 ? 's' : ''}` : '';
                list.add_child(this._row(s, s.target, `${peer} · PID ${s.pid}${fw}`));
            }
        }
    }

    _tunnelRow(f, session) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        const [kind, variant] = FORWARD_KIND[f.type];
        row.add_child(chip(kind, variant));

        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        // Short listen address as the title; where it leads on the second line.
        const title = f.type === 'R' ? `remote :${f.listen}` : listenAddress(f.listen);
        const to = f.type === 'D' ? 'SOCKS proxy' : `→ ${f.to ?? 'SOCKS proxy'}`;
        info.add_child(label(title, 'opsdeck-row-title'));
        info.add_child(label(`${to} · via ${session.target}`, 'opsdeck-meta'));
        row.add_child(info);

        const actions = hbox({style_class: 'opsdeck-row-actions'});
        const localPort = f.type === 'L' ? f.listen.match(/(\d+)$/)?.[1] : null;
        if (localPort)
            actions.add_child(this.openUrlButton(`http://localhost:${localPort}`, `Open localhost:${localPort} in browser`));
        actions.add_child(copyButton(() => describeForward(f, session.target), 'Copy tunnel details'));
        row.add_child(actions);
        // A tunnel lives as long as its ssh client, so "End" ends that session.
        row.add_child(this._endButton(session, `${session.target} (closes its tunnels)`));
        return row;
    }

    _row(session, title, meta) {
        const row = hbox({style_class: 'opsdeck-row', x_expand: true});
        row.add_child(chip(session.direction === 'in' ? 'IN' : 'OUT', session.direction === 'in' ? 'in' : 'out'));
        const info = vbox({x_expand: true, style_class: 'opsdeck-row-info'});
        info.add_child(label(title, 'opsdeck-row-title'));
        info.add_child(label(meta, 'opsdeck-meta'));
        row.add_child(info);
        row.add_child(this._endButton(session, title));
        return row;
    }

    _endButton(session, title) {
        if (!session.own)
            return label('other user', 'opsdeck-meta');
        return this.actionButton({
            key: `ssh:end:${session.direction === 'in' ? `in:${session.tty}` : `out:${session.pid}`}`,
            text: 'End', confirmText: 'End?', busyText: 'Ending…', variant: 'danger',
            accessibleName: `End SSH session ${title}`,
            run: () => this.ctx.hub.sources.ssh.terminate(session),
        });
    }
}
