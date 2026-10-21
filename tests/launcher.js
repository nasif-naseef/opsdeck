// SPDX-License-Identifier: MIT
//
// launchInTerminal() fallback test, run with a sandboxed PATH of fake
// launchers (see `make test`), so no real terminal is ever opened:
//   xdg-terminal-exec  exits 1 at once (like one with no terminal configured)
//   ptyxis             records its argv and exits 0 (hands off to a server)

import GLib from 'gi://GLib';
import System from 'system';

import {Scope} from '../extension/lib/scope.js';
import {launchInTerminal} from '../extension/lib/subprocess.js';

const log = GLib.getenv('OPSDECK_LAUNCH_LOG');
const loop = new GLib.MainLoop(null, false);
let failed = 0;
const check = (name, cond, detail = '') => {
    print(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
    failed += cond ? 0 : 1;
};

(async () => {
    const scope = new Scope();
    const t0 = Date.now();
    const r = await launchInTerminal(['docker', 'logs', '--follow', 'abc123'], scope);
    const took = Date.now() - t0;
    // Real terminals are not waited on, so give the fake one a moment to log.
    let calls = [];
    for (let i = 0; i < 20 && calls.length < 2; i++) {
        await scope.sleep(50);
        const [, bytes] = GLib.file_get_contents(log);
        calls = new TextDecoder().decode(bytes).trim().split('\n').filter(Boolean);
    }
    check('falls back past a launcher that exits non-zero at once', r.ok && r.message === 'Opened in ptyxis',
        JSON.stringify(r));
    check('both launchers were tried, in order', calls.length === 2 &&
        calls[0].startsWith('xdg-terminal-exec') && calls[1].startsWith('ptyxis'), calls.join(' | '));
    check('ptyxis receives a safely quoted command', calls[1] === "ptyxis --new-window -x 'docker' 'logs' '--follow' 'abc123'",
        calls[1]);
    check('a fast failure costs well under the 1.5s wait', took < 1400, `${took}ms`);

    scope.dispose();
})().catch(e => {
    print(`✗ crashed: ${e.stack}`);
    failed++;
}).finally(() => loop.quit());

loop.run();
System.exit(failed ? 1 : 0);
