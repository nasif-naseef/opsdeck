// SPDX-License-Identifier: MIT
//
// The dropdown: a nav rail of modules on the left, the active module's view
// on the right, with a header carrying freshness info and actions.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {formatAgo} from '../lib/format.js';
import {SOURCE_IDS} from '../lib/hub.js';
import {CancelledError} from '../lib/scope.js';
import {ConfirmTracker} from './confirm.js';
import {button, hbox, label, vbox} from './widgets.js';
import {ClaudeView} from './views/claude.js';
import {DockerView} from './views/docker.js';
import {PortsView} from './views/ports.js';
import {SshView} from './views/ssh.js';
import {SystemView} from './views/system.js';

const MODULES = {
    claude: {title: 'Claude', heading: 'Claude Usage', View: ClaudeView},
    system: {title: 'System', heading: 'This Machine', View: SystemView},
    ports: {title: 'Ports', heading: 'Listening Ports', View: PortsView},
    ssh: {title: 'SSH', heading: 'SSH Sessions', View: SshView},
    docker: {title: 'Docker', heading: 'Docker Containers', View: DockerView},
};

export class Deck {
    /**
     * @param {object} o
     * @param {import('../lib/hub.js').Hub} o.hub
     * @param {import('gi://Gio').default.Settings} o.settings
     * @param {import('../lib/scope.js').Scope} o.scope
     * @param {(name: string) => import('gi://Gio').default.Icon} o.icon
     * @param {() => void} o.openPreferences
     * @param {() => void} o.closeMenu
     */
    constructor({hub, settings, scope, icon, openPreferences, closeMenu}) {
        this._hub = hub;
        this._settings = settings;
        this._scope = scope;
        this._icon = icon;
        this._open = false;
        this._busy = new Set();
        this._tickId = 0;

        this._renderId = 0;
        // Arming a confirm happens inside a button's click handler; re-render
        // on the next main-loop turn so the clicked button isn't destroyed
        // while its own handler is still running.
        this._confirm = new ConfirmTracker(scope, settings, () => this._renderSoon());
        const ctx = {
            hub,
            settings,
            confirm: this._confirm,
            isBusy: key => this._busy.has(key),
            runAction: (id, key, fn, opts) => this._runAction(id, key, fn, opts),
            openPreferences,
            closeMenu,
        };

        this.actor = hbox({style_class: 'opsdeck-deck'});
        this._nav = vbox({style_class: 'opsdeck-nav'});
        this.actor.add_child(this._nav);

        const main = vbox({style_class: 'opsdeck-main', x_expand: true});
        this.actor.add_child(main);

        // Header: title + freshness, then refresh & settings.
        const header = hbox({style_class: 'opsdeck-header', x_expand: true});
        const titles = vbox({x_expand: true});
        this._title = label('', 'opsdeck-title');
        this._subtitle = label('', 'opsdeck-subtitle');
        titles.add_child(this._title);
        titles.add_child(this._subtitle);
        header.add_child(titles);
        header.add_child(button({
            iconName: 'view-refresh-symbolic',
            styleClass: 'opsdeck-button opsdeck-button-icon-only',
            accessibleName: 'Refresh now',
            onClick: () => this._hub.refresh(this._active, {force: true}),
        }));
        header.add_child(button({
            iconName: 'emblem-system-symbolic',
            styleClass: 'opsdeck-button opsdeck-button-icon-only',
            accessibleName: 'OpsDeck settings',
            onClick: openPreferences,
        }));
        main.add_child(header);

        this._scroll = new St.ScrollView({
            style_class: 'opsdeck-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._stack = vbox({x_expand: true});
        this._scroll.set_child(this._stack);
        main.add_child(this._scroll);

        this._views = {};
        this._navButtons = {};
        for (const id of SOURCE_IDS) {
            const view = new MODULES[id].View(ctx);
            view.actor.visible = false;
            this._stack.add_child(view.actor);
            this._views[id] = view;
            this._navButtons[id] = this._makeNavButton(id);
            this._nav.add_child(this._navButtons[id].actor);
        }

        this._hubIds = [
            hub.connect('changed', id => this._onChanged(id)),
            // A fetch starting only changes the "refreshing" note, not the list.
            hub.connect('loading', id => this._open && id === this._active && this._updateSubtitle()),
            hub.connect('enabled-changed', () => this._syncNav()),
        ];
        // The tab the user last chose. It is only ever written on a click, so
        // falling back while sources are still starting up (or disabled)
        // never overwrites it.
        const saved = settings.get_string('last-tab');
        this._wanted = SOURCE_IDS.includes(saved) ? saved : SOURCE_IDS[0];
        this._syncNav();
    }

    _makeNavButton(id) {
        const box = hbox({style_class: 'opsdeck-nav-content'});
        box.add_child(new St.Icon({gicon: this._icon(id), style_class: 'opsdeck-nav-icon'}));
        box.add_child(label(MODULES[id].title, 'opsdeck-nav-label', {x_expand: true}));
        const badge = label('', 'opsdeck-nav-badge', {visible: false});
        box.add_child(badge);
        const actor = new St.Button({
            style_class: 'opsdeck-nav-button',
            child: box,
            can_focus: true,
            toggle_mode: false,
            accessible_name: MODULES[id].heading,
            x_expand: true,
        });
        actor.connect('clicked', () => this.select(id));
        return {actor, badge};
    }

    /** User picked a tab: remember it and show it. */
    select(id) {
        this._wanted = id;
        if (this._settings.get_string('last-tab') !== id)
            this._settings.set_string('last-tab', id);
        this._show(this._effectiveTab());
    }

    /** The wanted tab if its module is on, else the first enabled one. */
    _effectiveTab() {
        if (this._hub.state[this._wanted].enabled)
            return this._wanted;
        return SOURCE_IDS.find(s => this._hub.state[s].enabled) ?? this._wanted;
    }

    _show(id) {
        this._active = id;
        for (const sid of SOURCE_IDS) {
            this._views[sid].actor.visible = sid === id;
            if (sid === id)
                this._navButtons[sid].actor.add_style_pseudo_class('checked');
            else
                this._navButtons[sid].actor.remove_style_pseudo_class('checked');
        }
        this._title.text = MODULES[id].heading;
        this._syncVisibility();
        this._renderActive();
    }

    /** Only the source on screen gathers its expensive details. */
    _syncVisibility() {
        this._hub.setVisible(this._open ? this._active : null);
    }

    onMenuOpened() {
        this._open = true;
        this._syncVisibility();
        this._renderActive();
        // Keep "updated 12s ago" honest while the menu is visible.
        this._tickId = this._scope.interval(5, () => this._updateSubtitle());
    }

    onMenuClosed() {
        this._open = false;
        this._syncVisibility();
        this._tickId = this._scope.clear(this._tickId);
        this._confirm.clear();
    }

    _onChanged(id) {
        this._updateBadge(id);
        // The Ports view labels Docker-published ports, so it depends on docker data.
        if (id === this._active || (id === 'docker' && this._active === 'ports'))
            this._renderActive();
    }

    _renderSoon() {
        if (!this._renderId) {
            this._renderId = this._scope.timeout(0, () => {
                this._renderId = 0;
                this._renderActive();
            });
        }
    }

    _renderActive() {
        if (!this._open || !this._active)
            return;
        // Lists are rebuilt on every poll; keep the reader's scroll position.
        const adj = this._scroll.vadjustment;
        const keep = this._lastRendered === this._active ? adj.value : 0;
        this._views[this._active].render();
        this._lastRendered = this._active;
        adj.value = keep;
        this._updateSubtitle();
    }

    _updateSubtitle() {
        const s = this._hub.state[this._active];
        if (!s.enabled)
            this._subtitle.text = 'Disabled';
        else if (s.loading && !s.updatedAt)
            this._subtitle.text = 'Loading…';
        else if (!s.updatedAt)
            this._subtitle.text = s.error ? 'Unavailable' : 'Waiting for first update';
        else
            this._subtitle.text = `Updated ${formatAgo(s.data?.fetchedAt ?? s.updatedAt)}${s.loading ? ' · refreshing' : ''}`;
    }

    _updateBadge(id) {
        const {badge} = this._navButtons[id];
        const d = this._hub.display(id);
        badge.visible = d !== null && !d.quiet;
        badge.style_class = 'opsdeck-nav-badge';
        if (!badge.visible)
            return;
        badge.text = d.text;
        if (d.level && d.level !== 'ok')
            badge.add_style_class_name(`opsdeck-level-${d.level}`);
    }

    _syncNav() {
        for (const id of SOURCE_IDS) {
            this._navButtons[id].actor.visible = this._hub.state[id].enabled;
            this._updateBadge(id);
        }
        // Follow modules turning on/off without touching the saved choice.
        const tab = this._effectiveTab();
        if (tab !== this._active)
            this._show(tab);
    }

    /**
     * @param {string} id - source to refresh afterwards
     * @param {string} key - busy-state key
     * @param {() => Promise<{ok: boolean, message: string}>} fn
     * @param {{refresh?: boolean}} [opts]
     */
    async _runAction(id, key, fn, {refresh = true} = {}) {
        if (this._busy.has(key))
            return;
        this._busy.add(key);
        this._renderSoon();
        try {
            const result = await fn();
            if (!result.ok)
                Main.notifyError('OpsDeck', result.message);
        } catch (e) {
            if (e instanceof CancelledError || this._scope.disposed)
                return;
            console.error(`[OpsDeck] action ${key} failed: ${e.stack ?? e}`);
            Main.notifyError('OpsDeck', String(e.message ?? e));
        } finally {
            if (!this._scope.disposed) {
                this._busy.delete(key);
                if (refresh)
                    this._hub.refresh(id, {force: true});
                else
                    this._renderSoon();
            }
        }
    }

    destroy() {
        for (const hid of this._hubIds)
            this._hub.disconnect(hid);
        this._tickId = this._scope.clear(this._tickId);
        this._renderId = this._scope.clear(this._renderId);
        this._confirm.clear();
        this.actor.destroy();
    }
}
