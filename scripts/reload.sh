#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Update OpsDeck in the running GNOME Shell without logging out.
#
# GNOME Shell caches JavaScript modules by file path, so a new version must be
# loaded from a fresh folder. This script:
#   1. installs the build normally (the next login uses it too)
#   2. copies it to ~/.cache/opsdeck-live/<timestamp>/<uuid>
#   3. prints the one line to paste into Looking Glass (Alt+F2 → lg)
#
#   scripts/reload.sh [path/to/opsdeck.zip]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/extension/metadata.json")"
ZIP="${1:-$ROOT/dist/$UUID.shell-extension.zip}"
[[ -f "$ZIP" ]] || { echo "missing $ZIP (run: make pack)"; exit 2; }

gnome-extensions install --force "$ZIP"
INSTALLED="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

LIVE="${XDG_CACHE_HOME:-$HOME/.cache}/opsdeck-live"
NEW="$LIVE/$(date +%Y%m%d-%H%M%S)/$UUID"
mkdir -p "$NEW"
cp -r "$INSTALLED/." "$NEW/"
# Keep this copy and the one currently running (its icons are still read
# from disk); remove anything older.
find "$LIVE" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +3 | cut -d' ' -f2- |
    xargs -r rm -rf

LINE="const u = '$UUID', m = Main.extensionManager; await m.unloadExtension(m.lookup(u)); await m.loadExtension(m.createExtensionObject(u, Gio.File.new_for_path('$NEW'), 2)); m.lookup(u).state"
echo "$NEW" > "$LIVE/latest"

echo
echo "Press Alt+F2, type lg, press Enter, paste this line and press Enter:"
echo
echo "    $LINE"
echo
echo "It should print 1 (active). Esc closes Looking Glass."
if command -v wl-copy >/dev/null && [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
    printf '%s' "$LINE" | wl-copy && echo "(The line is on your clipboard.)"
fi
