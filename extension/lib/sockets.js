// SPDX-License-Identifier: MIT
//
// Pure parsing helpers for `ss` output.

/**
 * Split "addr:port" as printed by ss. Handles "0.0.0.0:22", "[::]:80",
 * "*:5353", "127.0.0.53%lo:53" and "[fe80::1%eth0]:546".
 *
 * @returns {{host: string, port: number} | null}
 */
export function splitHostPort(token) {
    const i = token?.lastIndexOf(':') ?? -1;
    if (i <= 0)
        return null;
    const port = Number(token.slice(i + 1));
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        return null;
    let host = token.slice(0, i);
    if (host.startsWith('[') && host.endsWith(']'))
        host = host.slice(1, -1);
    const zone = host.indexOf('%');
    if (zone > 0)
        host = host.slice(0, zone);
    return {host, port};
}

/**
 * Parse the process column: users:(("nginx",pid=12,fd=6),("nginx",pid=13,fd=6))
 * Returns unique processes by pid, in order of appearance.
 *
 * @returns {{name: string, pid: number}[]}
 */
export function parseUsers(column) {
    const out = [];
    const seen = new Set();
    for (const m of (column ?? '').matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)) {
        const pid = Number(m[2]);
        if (seen.has(pid))
            continue;
        seen.add(pid);
        out.push({name: m[1], pid});
    }
    return out;
}

export function isLoopback(host) {
    return host === 'localhost' || host === '::1' || host.startsWith('127.') ||
        host.startsWith('::ffff:127.');
}
