UUID := $(shell python3 -c 'import json;print(json.load(open("extension/metadata.json"))["uuid"])')
ZIP  := dist/$(UUID).shell-extension.zip
SRCS := $(shell find extension -type f ! -name gschemas.compiled)

.PHONY: all test pack install uninstall smoke prefs log clean

all: test pack

test:
	gjs -m tests/run.js
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

prefs:
	gnome-extensions prefs $(UUID)

log:
	journalctl --user -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered opsdeck

clean:
	rm -rf dist
