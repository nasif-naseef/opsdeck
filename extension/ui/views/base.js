// SPDX-License-Identifier: MIT
//
// Base class for a tab. Owns a persistent toolbar (search entry, buttons)
// and a list area that is rebuilt on every render, so typing in the search
// box is never interrupted by background refreshes.

import St from 'gi://St';

import {banner, button, emptyState, hbox, label, vbox} from '../widgets.js';
import {openUri} from '../../lib/subprocess.js';

const ERROR_ICONS = {
    'missing': 'dialog-question-symbolic',
    'daemon': 'system-shutdown-symbolic',
    'permission': 'changes-prevent-symbolic',
    'signed-out': 'avatar-default-symbolic',
    'expired': 'preferences-system-time-symbolic',
    'network': 'network-offline-symbolic',
};

/**
 * @typedef {object} ViewContext
 * @property {import('../../lib/hub.js').Hub} hub
 * @property {import('gi://Gio').default.Settings} settings
 * @property {import('../confirm.js').ConfirmTracker} confirm
 * @property {(key: string) => boolean} isBusy
 * @property {(sourceId: string, key: string, fn: () => Promise<{ok: boolean, message: string}>) => void} runAction
 * @property {() => void} openPreferences
 * @property {() => void} closeMenu
 * @property {(name: string) => import('gi://Gio').default.Icon} icon
 */

export class SourceView {
    /**
     * @param {ViewContext} ctx
     * @param {string} id - source id
     * @param {object} [opts]
     * @param {string} [opts.searchHint] - adds a search entry when set
     */
    constructor(ctx, id, {searchHint} = {}) {
        this.ctx = ctx;
        this.id = id;
        this.actor = vbox({style_class: 'opsdeck-view', x_expand: true});

        this._toolbar = hbox({style_class: 'opsdeck-toolbar', x_expand: true, visible: false});
        if (searchHint) {
            this._entry = new St.Entry({
                style_class: 'opsdeck-search',
                hint_text: searchHint,
                can_focus: true,
                x_expand: true,
                primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'opsdeck-search-icon'}),
            });
            this._entry.clutter_text.connect('text-changed', () => this.render());
            this._toolbar.add_child(this._entry);
        }
        this.actor.add_child(this._toolbar);

        this._list = vbox({style_class: 'opsdeck-list', x_expand: true});
        this.actor.add_child(this._list);
    }

    get query() {
        return this._entry?.get_text() ?? '';
    }

    /** Add a button to the right of the search entry. */
    addToolbarButton(widget) {
        this._toolbar.add_child(widget);
    }

    render() {
        const s = this.ctx.hub.state[this.id];
        this._list.destroy_all_children();

        if (!s.enabled) {
            this._toolbar.visible = false;
            this._list.add_child(emptyState({
                iconName: 'action-unavailable-symbolic',
                title: 'Module disabled',
                actionLabel: 'Open Settings',
                onAction: () => this.ctx.openPreferences(),
            }));
            return;
        }

        if (s.data === null) {
            this._toolbar.visible = false;
            if (s.error) {
                this._list.add_child(emptyState({
                    iconName: ERROR_ICONS[s.error.kind] ?? 'dialog-error-symbolic',
                    title: s.error.message,
                    hint: s.error.hint,
                    variant: 'error',
                }));
            } else {
                this._list.add_child(emptyState({iconName: 'content-loading-symbolic', title: 'Loading…'}));
            }
            return;
        }

        this._toolbar.visible = this.showToolbar(s.data);
        if (s.error)
            this._list.add_child(banner(`${s.error.message}. Showing last known data.`));
        this.build(this._list, s.data);
    }

    /** Whether the toolbar is useful for this data set. */
    showToolbar(_data) {
        return true;
    }

    /** Subclasses fill `list` from `data`. */
    build(_list, _data) {
        throw new Error('not implemented');
    }

    /**
     * A button that runs one of this source's actions, with a busy state and,
     * when `confirmText` is given, a two-click confirmation.
     *
     * @param {object} o
     * @param {string} o.key - unique per entity and verb, e.g. "docker:stop:<id>"
     * @param {string} [o.text] - label; omit for an icon-only button
     * @param {string} [o.iconName] - icon for the idle, icon-only state
     * @param {string} [o.confirmText] - armed label; makes the action destructive
     * @param {string} [o.busyText]
     * @param {string} o.accessibleName
     * @param {'danger'|'suggested'} [o.variant]
     * @param {boolean} [o.closesMenu] - e.g. for actions that open a window
     * @param {boolean} [o.refresh] - refresh the source afterwards (default true)
     * @param {() => any} o.run - returns (a promise of) an actionResult
     */
    actionButton({key, text, iconName, confirmText, busyText = '…', accessibleName, variant,
        closesMenu = false, refresh = true, run}) {
        const busy = this.ctx.isBusy(key);
        const armed = Boolean(confirmText) && this.ctx.confirm.isArmed(key);
        const shown = busy ? busyText : armed ? confirmText : text;
        return button({
            label: shown,
            iconName: shown ? undefined : iconName,
            styleClass: ['opsdeck-button', variant && `opsdeck-button-${variant}`,
                armed && 'opsdeck-armed', !shown && 'opsdeck-button-icon-only'].filter(Boolean).join(' '),
            accessibleName: armed ? `Confirm: ${accessibleName}` : accessibleName,
            sensitive: !busy,
            onClick: () => {
                if (confirmText && !this.ctx.confirm.confirm(key))
                    return;
                if (closesMenu)
                    this.ctx.closeMenu();
                this.ctx.runAction(this.id, key, async () => run(), {refresh});
            },
        });
    }

    openUrlButton(url, accessibleName) {
        return this.actionButton({
            key: `open:${url}`, iconName: 'web-browser-symbolic', accessibleName,
            closesMenu: true, refresh: false, run: () => openUri(url),
        });
    }

    /**
     * Rows for `items`, capped at `maxRows`, or an empty state that says
     * whether the search or the data is the reason.
     */
    renderFiltered(list, items, rowFn, {maxRows, emptyIcon, emptyTitle, emptyHint = ''}) {
        if (!items.length) {
            const q = this.query.trim();
            list.add_child(emptyState({
                iconName: emptyIcon,
                title: q ? `Nothing matches “${q}”` : emptyTitle,
                hint: q ? '' : emptyHint,
            }));
            return;
        }
        for (const item of items.slice(0, maxRows))
            list.add_child(rowFn(item));
        if (items.length > maxRows)
            list.add_child(label(`… ${items.length - maxRows} more, refine the filter`, 'opsdeck-note'));
    }

    /** Section heading inside a list. */
    heading(list, text) {
        list.add_child(new St.Label({text, style_class: 'opsdeck-heading'}));
    }

    destroy() {
        this.actor.destroy();
    }
}
