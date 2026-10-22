#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Store screenshots with made-up data: boots a throw-away headless GNOME Shell
# (private D-Bus, temporary HOME), lets scripts/screenshot-driver feed OpsDeck
# fake data, then crops each tab to the top bar + menu into docs/screenshots/.
#
#   scripts/screenshots.sh [path/to/opsdeck.zip]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/extension/metadata.json")"
DRIVER="opsdeck-screenshot-driver@local"
ZIP="${1:-$ROOT/dist/$UUID.shell-extension.zip}"
OUT="$ROOT/docs/screenshots"
[[ -f "$ZIP" ]] || { echo "missing $ZIP (run: make pack)"; exit 2; }

SANDBOX="$(mktemp -d -t opsdeck-shots.XXXXXX)"
trap 'rm -rf "$SANDBOX" 2>/dev/null || true' EXIT
export HOME="$SANDBOX/home" XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" \
       XDG_CACHE_HOME="$SANDBOX/cache" XDG_RUNTIME_DIR="$SANDBOX/run" XDG_STATE_HOME="$SANDBOX/state"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$SANDBOX/raw" "$OUT"
chmod 700 "$XDG_RUNTIME_DIR"

gnome-extensions install --force "$ZIP"
cp -r "$ROOT/scripts/screenshot-driver" "$XDG_DATA_HOME/gnome-shell/extensions/$DRIVER"

export OPSDECK_UUID="$UUID" OPSDECK_SHOTS="$SANDBOX/raw" LOG="$SANDBOX/shell.log" DRIVER
dbus-run-session -- bash -euo pipefail -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$OPSDECK_UUID\", \"$DRIVER\"]"
    gsettings --schemadir "$XDG_DATA_HOME/gnome-shell/extensions/$OPSDECK_UUID/schemas" \
        set org.gnome.shell.extensions.opsdeck enable-claude true
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 >"$LOG" 2>&1 &
    SHELL_PID=$!
    for _ in $(seq 120); do
        grep -qE "SHOTS (DONE|FAIL)" "$LOG" && break
        sleep 0.5
    done
    kill "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true
' >/dev/null 2>&1 || true

grep -q 'SHOTS DONE' "$LOG" || { grep SHOTS "$LOG"; echo "FAIL: driver did not finish"; exit 1; }

# Crop to the top-right corner (top bar + menu) and build a 3-up overview.
gjs -c "
const {GdkPixbuf} = imports.gi;
const raw = '$SANDBOX/raw', out = '$OUT';
const crop = (name, x = 1000, y = 0, w = 600, h = 566) => {
    const src = GdkPixbuf.Pixbuf.new_from_file(\`\${raw}/\${name}.png\`);
    const c = src.new_subpixbuf(x, y, w, h).copy();
    c.savev(\`\${out}/\${name}.png\`, 'png', [], []);
    return c;
};
const tabs = ['claude', 'system', 'system-lower', 'ports', 'ssh', 'docker'].map(t => crop(t));
crop('panel', 1180, 0, 420, 34);
const pick = [tabs[1], tabs[3], tabs[5]];
const gap = 24, w = 600, h = 566;
const hero = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, w * 3 + gap * 4, h + gap * 2);
hero.fill(0x1e1e24ff);
pick.forEach((p, i) => p.copy_area(0, 0, w, h, hero, gap + i * (w + gap), gap));
hero.savev(\`\${out}/overview.png\`, 'png', [], []);
"
ls -la "$OUT"
