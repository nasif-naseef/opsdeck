#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Boot a throw-away headless GNOME Shell with OpsDeck installed, let the
# test-only driver extension (scripts/smoke-driver) open the menu on every
# tab and cycle disable/enable, then fail on any OpsDeck JS error.
#
# Runs on a private D-Bus session with a temporary HOME, so it never touches
# your real shell, settings or Claude credentials.
#
#   scripts/smoke-test.sh [path/to/opsdeck.zip] [screenshot-dir]
#   SMOKE_LOG=/path/to/shell.log scripts/smoke-test.sh   # keep the full log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uuid"])' "$ROOT/extension/metadata.json")"
DRIVER="opsdeck-smoke-driver@local"
ZIP="${1:-}"
ZIP="${ZIP:-$ROOT/dist/$UUID.shell-extension.zip}"
[[ -f "$ZIP" ]] || { echo "missing $ZIP (run: make pack)"; exit 2; }

SANDBOX="$(mktemp -d -t opsdeck-smoke.XXXXXX)"
LOG="$SANDBOX/shell.log"
trap '[[ -n "${SMOKE_LOG:-}" ]] && cp "$LOG" "$SMOKE_LOG" 2>/dev/null; rm -rf "$SANDBOX" 2>/dev/null || true' EXIT

export HOME="$SANDBOX/home" XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" \
       XDG_CACHE_HOME="$SANDBOX/cache" XDG_RUNTIME_DIR="$SANDBOX/run" XDG_STATE_HOME="$SANDBOX/state"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Same path a real install takes (this also compiles the GSettings schema).
gnome-extensions install --force "$ZIP"
cp -r "$ROOT/scripts/smoke-driver" "$XDG_DATA_HOME/gnome-shell/extensions/$DRIVER"

export OPSDECK_UUID="$UUID" OPSDECK_SHOTS="${2:-}" LOG DRIVER
dbus-run-session -- bash -euo pipefail -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$OPSDECK_UUID\", \"$DRIVER\"]"
    # Claude is opt-in; turn it on here so its tab (signed-out path) is covered.
    gsettings --schemadir "$XDG_DATA_HOME/gnome-shell/extensions/$OPSDECK_UUID/schemas" \
        set org.gnome.shell.extensions.opsdeck enable-claude true
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 >"$LOG" 2>&1 &
    SHELL_PID=$!
    for _ in $(seq 120); do
        grep -qE "SMOKE (DONE|FAIL)" "$LOG" && break
        sleep 0.5
    done
    kill "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true
' >/dev/null 2>&1 || true

echo "── smoke log ──"
grep -E 'SMOKE|OpsDeck|opsdeck' "$LOG" | grep -vE 'Activating service|Successfully activated' || true

# GJS prints the error text and its stack (with the file path) on separate
# lines, so judge each error line together with the stack frames under it.
ERRORS="$(awk '
    { line[NR] = $0 }
    END {
        for (i = 1; i <= NR; i++) {
            if (line[i] !~ /JS ERROR|JS WARNING|TypeError|ReferenceError|already disposed|was not found when attempting|CRITICAL/)
                continue
            # The error line plus the stack frames ("fn@file.js:12:3") under it.
            block = line[i]
            for (j = i + 1; j <= NR && line[j] ~ /@.*\.js:[0-9]+/; j++)
                block = block "\n" line[j]
            if (tolower(block) ~ /opsdeck/)
                print block "\n---"
        }
    }
' "$LOG")"
if ! grep -q 'SMOKE DONE' "$LOG"; then
    echo "FAIL: driver did not finish"
    exit 1
fi
if [[ -n "$ERRORS" ]]; then
    echo "FAIL: OpsDeck errors in shell log:"
    echo "$ERRORS"
    exit 1
fi
echo "PASS"
