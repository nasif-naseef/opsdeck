// SPDX-License-Identifier: MIT
//
// OpsDeck: listening ports, SSH sessions, Docker containers and Claude plan
// usage in one GNOME Shell top-bar menu.
//
//   sources/*  fetch + parse + actions (no UI, unit tested under gjs)
//   lib/hub    polling, per-source state, settings reactions
//   ui/*       indicator counters and the dropdown deck
//
// Every async resource hangs off a single Scope that disable() disposes first,
// so no timer, subprocess or HTTP callback outlives the extension.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Hub} from './lib/hub.js';
import {Scope} from './lib/scope.js';
import {ClaudeSource} from './sources/claude.js';
import {DockerSource} from './sources/docker.js';
import {PortsSource} from './sources/ports.js';
import {SshSource} from './sources/ssh.js';
import {OpsDeckIndicator} from './ui/indicator.js';

export default class OpsDeckExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._scope = new Scope();
        this._sources = {
            claude: new ClaudeSource(this._scope),
            ports: new PortsSource(this._scope),
            ssh: new SshSource(this._scope),
            docker: new DockerSource(this._scope),
        };
        this._hub = new Hub(this._settings, this._scope, this._sources);
        this._indicator = new OpsDeckIndicator({
            extension: this,
            settings: this._settings,
            hub: this._hub,
            scope: this._scope,
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._hub.start();
    }

    disable() {
        // Cancel I/O and timers first so nothing calls back into torn-down UI.
        this._scope.dispose();
        this._indicator.destroy();
        this._hub.destroy();
        for (const source of Object.values(this._sources))
            source.destroy();

        this._indicator = null;
        this._hub = null;
        this._sources = null;
        this._scope = null;
        this._settings = null;
    }
}
