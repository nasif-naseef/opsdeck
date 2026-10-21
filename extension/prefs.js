// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODULES = [
    {id: 'claude', title: 'Claude Usage', icon: 'claude',
        subtitle: 'Plan limits of the account Claude Code is signed in with. Reads the token read-only and never modifies it.'},
    {id: 'ports', title: 'Listening Ports', icon: 'ports',
        subtitle: 'TCP and UDP sockets from ss, with process, kill and open-in-browser.'},
    {id: 'ssh', title: 'SSH Sessions', icon: 'ssh',
        subtitle: 'Incoming logins (who) and outgoing ssh clients (ss).'},
    {id: 'docker', title: 'Docker', icon: 'docker',
        subtitle: 'Containers via the docker CLI: start, stop, restart, shell.'},
];

export default class OpsDeckPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        window.set_default_size(640, 760);

        const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
        iconTheme.add_search_path(this.dir.get_child('icons').get_path());

        window.add(this._generalPage(settings));
        window.add(this._modulesPage(settings));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const panel = new Adw.PreferencesGroup({
            title: 'Top Bar',
            description: 'Counters shown next to the OpsDeck icon.',
        });
        page.add(panel);
        panel.add(this._switch(settings, 'show-panel-counters', 'Show counters'));
        for (const m of MODULES) {
            const row = this._switch(settings, `show-${m.id}-counter`, m.title);
            settings.bind('show-panel-counters', row, 'sensitive', Gio.SettingsBindFlags.GET);
            panel.add(row);
        }
        panel.add(this._switch(settings, 'hide-zero-counters', 'Hide zero counters',
            'Only show a counter when there is something running.'));

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);
        behaviour.add(this._switch(settings, 'confirm-destructive', 'Confirm destructive actions',
            'Kill, end, stop and restart need a second click.'));

        return page;
    }

    _modulesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Modules', icon_name: 'view-grid-symbolic'});

        for (const m of MODULES) {
            const group = new Adw.PreferencesGroup({title: m.title, description: m.subtitle});
            page.add(group);

            const enable = this._switch(settings, `enable-${m.id}`, 'Enabled');
            enable.add_prefix(new Gtk.Image({icon_name: `${m.icon}-symbolic`}));
            group.add(enable);

            const extra = [this._spin(settings, `refresh-interval-${m.id}`, 'Refresh every', 'Seconds')];
            if (m.id === 'claude')
                extra.push(this._claudeWindowRow(settings));
            if (m.id === 'ports') {
                extra.push(this._switch(settings, 'ports-show-udp', 'Include UDP',
                    'UDP sockets are mostly system services (mDNS, DNS, media).'));
                extra.push(this._spin(settings, 'port-range-min', 'Lowest port', 'Hide ports below this'));
                extra.push(this._spin(settings, 'port-range-max', 'Highest port', 'Hide ports above this'));
            }
            if (m.id === 'docker')
                extra.push(this._switch(settings, 'docker-show-stopped', 'Show stopped containers'));

            for (const row of extra) {
                settings.bind(`enable-${m.id}`, row, 'sensitive', Gio.SettingsBindFlags.GET);
                group.add(row);
            }
        }
        return page;
    }

    _switch(settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spin(settings, key, title, subtitle) {
        const range = settings.settings_schema.get_key(key).get_range().deepUnpack()[1].deepUnpack();
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({lower: range[0], upper: range[1], step_increment: 1, page_increment: 10}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _claudeWindowRow(settings) {
        const values = ['max', '5h', '7d'];
        const row = new Adw.ComboRow({
            title: 'Top bar shows',
            model: Gtk.StringList.new(['Closest to limit', 'Session (5h)', 'Weekly (7d)']),
        });
        row.selected = Math.max(0, values.indexOf(settings.get_string('claude-panel-window')));
        row.connect('notify::selected', () => settings.set_string('claude-panel-window', values[row.selected]));
        return row;
    }
}
