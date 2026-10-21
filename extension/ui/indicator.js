// SPDX-License-Identifier: MIT
//
// Top-bar button: one compact counter per module, and the Deck dropdown.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SOURCE_IDS} from '../lib/hub.js';
import {Deck} from './deck.js';
import {hbox} from './widgets.js';

const COUNTER_SETTINGS = ['show-panel-counters', 'hide-zero-counters',
    ...SOURCE_IDS.map(id => `show-${id}-counter`)];

export const OpsDeckIndicator = GObject.registerClass(
class OpsDeckIndicator extends PanelMenu.Button {
    /**
     * @param {object} o
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} o.extension
     * @param {import('gi://Gio').default.Settings} o.settings
     * @param {import('../lib/hub.js').Hub} o.hub
     * @param {import('../lib/scope.js').Scope} o.scope
     */
    _init({extension, settings, hub, scope}) {
        super._init(0.5, 'OpsDeck', false);
        this.add_style_class_name('opsdeck-indicator');
        this._settings = settings;
        this._hub = hub;

        const iconCache = new Map();
        const icon = name => {
            if (!iconCache.has(name)) {
                const file = extension.dir.get_child('icons').get_child(`${name}-symbolic.svg`);
                iconCache.set(name, new Gio.FileIcon({file}));
            }
            return iconCache.get(name);
        };

        // Top bar
        const box = hbox({style_class: 'panel-status-indicators-box opsdeck-counters'});
        this._fallbackIcon = new St.Icon({gicon: icon('opsdeck'), style_class: 'system-status-icon'});
        box.add_child(this._fallbackIcon);
        this._counters = {};
        for (const id of SOURCE_IDS) {
            const counter = hbox({style_class: 'opsdeck-counter', y_align: Clutter.ActorAlign.CENTER});
            counter.add_child(new St.Icon({gicon: icon(id), style_class: 'opsdeck-counter-icon'}));
            const text = new St.Label({style_class: 'opsdeck-counter-label', y_align: Clutter.ActorAlign.CENTER});
            counter.add_child(text);
            box.add_child(counter);
            this._counters[id] = {actor: counter, text};
        }
        this.add_child(box);

        // Dropdown
        this.menu.box.add_style_class_name('opsdeck-menu');
        this._deck = new Deck({
            hub, settings, scope, icon,
            openPreferences: () => {
                this.menu.close();
                extension.openPreferences();
            },
            closeMenu: () => this.menu.close(),
        });
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false,
            style_class: 'opsdeck-menu-item'});
        item.add_child(this._deck.actor);
        this.menu.addMenuItem(item);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                hub.refreshAll();
                this._deck.onMenuOpened();
            } else {
                this._deck.onMenuClosed();
            }
        });

        this._hubId = hub.connect('changed', id => this._updateCounter(id));
        this._settingsIds = COUNTER_SETTINGS.map(k =>
            settings.connect(`changed::${k}`, () => this._updateAll()));
        this._updateAll();
    }

    _updateAll() {
        for (const id of SOURCE_IDS)
            this._updateCounter(id);
    }

    _updateCounter(id) {
        const {actor, text} = this._counters[id];
        const d = this._hub.display(id);
        const show = this._settings.get_boolean('show-panel-counters') &&
            this._settings.get_boolean(`show-${id}-counter`) &&
            d !== null &&
            !(d.quiet && this._settings.get_boolean('hide-zero-counters'));
        actor.visible = show;
        if (show) {
            text.text = d.text;
            actor.style_class = 'opsdeck-counter';
            if (d.level)
                actor.add_style_class_name(`opsdeck-level-${d.level}`);
        }
        // Never leave an empty button in the top bar.
        this._fallbackIcon.visible = SOURCE_IDS.every(sid => !this._counters[sid].actor.visible);
    }

    destroy() {
        this._hub.disconnect(this._hubId);
        for (const sid of this._settingsIds)
            this._settings.disconnect(sid);
        this._deck.destroy();
        super.destroy();
    }
});
