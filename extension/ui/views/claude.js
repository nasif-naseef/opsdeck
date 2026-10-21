// SPDX-License-Identifier: MIT

import GLib from 'gi://GLib';

import {formatDuration, usageLevel} from '../../lib/format.js';
import {banner, emptyState, hbox, label, usageBar, vbox} from '../widgets.js';
import {SourceView} from './base.js';

const STALE_TEXT = {
    'rate-limited': 'Usage API is rate limiting; showing the last reading',
    'offline': 'Offline; showing the last reading',
    'error': 'Usage API error; showing the last reading',
};

export class ClaudeView extends SourceView {
    constructor(ctx) {
        super(ctx, 'claude');
    }

    showToolbar() {
        return false;
    }

    build(list, usage) {
        if (usage.stale)
            list.add_child(banner(STALE_TEXT[usage.stale] ?? 'Showing the last reading'));

        if (!usage.windows.length) {
            list.add_child(emptyState({title: 'No usage limits reported for this account'}));
            return;
        }

        for (const w of usage.windows) {
            const card = vbox({style_class: 'opsdeck-usage', x_expand: true});
            const level = usageLevel(w.pct);

            const top = hbox({x_expand: true});
            top.add_child(label(w.label, 'opsdeck-usage-title', {x_expand: true}));
            top.add_child(label(`${w.pct}%`, `opsdeck-usage-pct opsdeck-level-${level}`));
            card.add_child(top);
            card.add_child(usageBar(w.pct, level));

            if (w.resetsAt) {
                const left = w.resetsAt - Date.now();
                const at = GLib.DateTime.new_from_unix_local(Math.floor(w.resetsAt / 1000));
                const when = left > 86_400_000 ? at.format('%a %H:%M') : at.format('%H:%M');
                card.add_child(label(left > 0 ? `Resets in ${formatDuration(left)} · ${when}` : 'Resetting now',
                    'opsdeck-meta'));
            }
            list.add_child(card);
        }
    }
}
