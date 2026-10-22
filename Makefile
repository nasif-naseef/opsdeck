UUID := $(shell python3 -c 'import json;print(json.load(open("extension/metadata.json"))["uuid"])')
ZIP  := dist/$(UUID).shell-extension.zip
SRCS := $(shell find extension -type f ! -name gschemas.compiled)

.PHONY: all lint test pack install uninstall smoke screenshots prefs log clean

all: lint test pack

lint:
	npx eslint extension tests scripts eslint.config.js

test:
	gjs -m tests/run.js
	@# Terminal fallback, against fake launchers on a sandboxed PATH.
	@set -e; d=$$(mktemp -d); trap 'rm -rf "$$d"' EXIT; \
	printf '#!/bin/sh\necho "xdg-terminal-exec $$*" >> "%s/log"\nexit 1\n' "$$d" > "$$d/xdg-terminal-exec"; \
	printf '#!/bin/sh\necho "ptyxis $$*" >> "%s/log"\nexit 0\n' "$$d" > "$$d/ptyxis"; \
	chmod +x "$$d"/*; OPSDECK_LAUNCH_LOG="$$d/log" PATH="$$d" "$$(command -v gjs)" -m tests/launcher.js
	glib-compile-schemas --strict --dry-run extension/schemas

pack: $(ZIP)

$(ZIP): $(SRCS)
	@mkdir -p dist
	gnome-extensions pack extension --force --out-dir dist \
		--extra-source=lib --extra-source=sources --extra-source=ui --extra-source=icons

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed $(UUID). On Wayland, log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

smoke: pack
	scripts/smoke-test.sh $(ZIP)

screenshots: pack
	scripts/screenshots.sh $(ZIP)

prefs:
	gnome-extensions prefs $(UUID)

log:
	journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered opsdeck

clean:
	rm -rf dist
