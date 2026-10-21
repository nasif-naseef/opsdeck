// SPDX-License-Identifier: MIT
//
// Pure formatting helpers shared by sources, views and tests.

/** "just now", "42s ago", "5m ago", "3h ago". */
export function formatAgo(timestampMs, nowMs = Date.now()) {
    if (!timestampMs)
        return 'never';
    const s = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
    if (s < 5)
        return 'just now';
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
}

/** Compact duration: "45m", "2h 05m", "3d 4h". */
export function formatDuration(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    if (totalMin < 60)
        return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    if (h < 24)
        return `${h}h ${String(totalMin % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Usage level used to colour bars and counters. */
export function usageLevel(pct) {
    if (pct >= 90)
        return 'critical';
    if (pct >= 70)
        return 'warn';
    return 'ok';
}

/** Case-insensitive "does any field contain the query". */
export function matchesQuery(query, ...fields) {
    const q = query.trim().toLowerCase();
    if (!q)
        return true;
    return fields.some(f => f !== null && f !== undefined && String(f).toLowerCase().includes(q));
}
