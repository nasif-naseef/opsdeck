// SPDX-License-Identifier: MIT
//
// Small St widget factories so views read as layout, not boilerplate.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

export function vbox(props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, ...props});
}

export function hbox(props = {}) {
    return new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, ...props});
}

export function label(text, styleClass = '', props = {}) {
    const l = new St.Label({text: String(text), style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER, ...props});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

export function spacer() {
    return new St.Widget({x_expand: true});
}

/**
 * @param {object} o
 * @param {string} [o.label]
 * @param {string} [o.iconName] - themed icon name
 * @param {import('gi://Gio').default.Icon} [o.gicon]
 * @param {string} [o.styleClass]
 * @param {string} o.accessibleName
 * @param {boolean} [o.sensitive]
 * @param {() => void} o.onClick
 */
export function button({label: text, iconName, gicon, styleClass = 'opsdeck-button',
    accessibleName, sensitive = true, onClick}) {
    let child;
    if (iconName || gicon) {
        // Pass only one of icon_name/gicon: setting the other to null clears it.
        child = new St.Icon({style_class: 'opsdeck-button-icon',
            ...(gicon ? {gicon} : {icon_name: iconName})});
    }
    const b = new St.Button({
        style_class: styleClass,
        accessible_name: accessibleName ?? text,
        can_focus: true,
        reactive: sensitive,
        y_align: Clutter.ActorAlign.CENTER,
    });
    // Set exactly one of child/label: setting a label replaces the child.
    if (child)
        b.set_child(child);
    else
        b.set_label(text);
    if (!sensitive)
        b.add_style_pseudo_class('insensitive');
    b.connect('clicked', () => onClick());
    return b;
}

export function chip(text, variant = '') {
    return label(text, `opsdeck-chip ${variant ? `opsdeck-chip-${variant}` : ''}`);
}

/** Horizontal usage bar; `level` is ok | warn | critical. */
export function usageBar(pct, level) {
    // A box packs from the start, so the fill grows from the left edge.
    const track = hbox({style_class: 'opsdeck-bar', x_expand: true});
    const fill = new St.Widget({style_class: `opsdeck-bar-fill opsdeck-level-${level}`, y_expand: true});
    track.add_child(fill);
    track.connect('notify::width', () => {
        fill.width = Math.round(track.width * Math.min(100, Math.max(0, pct)) / 100);
    });
    return track;
}

/** Centered placeholder for empty, error and disabled states. */
export function emptyState({iconName = 'dialog-information-symbolic', title, hint = '',
    actionLabel, onAction, variant = ''}) {
    const box = vbox({style_class: `opsdeck-empty ${variant ? `opsdeck-empty-${variant}` : ''}`,
        x_expand: true});
    box.add_child(new St.Icon({icon_name: iconName, style_class: 'opsdeck-empty-icon',
        x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(label(title, 'opsdeck-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
    if (hint) {
        const h = label(hint, 'opsdeck-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        h.clutter_text.line_wrap = true;
        h.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(h);
    }
    if (actionLabel) {
        box.add_child(button({label: actionLabel, styleClass: 'opsdeck-button opsdeck-button-flat',
            onClick: onAction}));
    }
    return box;
}

/** Thin warning strip shown above stale data. */
export function banner(text, variant = 'warn') {
    const b = hbox({style_class: `opsdeck-banner opsdeck-banner-${variant}`, x_expand: true});
    b.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'opsdeck-banner-icon'}));
    const l = label(text, 'opsdeck-banner-text', {x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    b.add_child(l);
    return b;
}

export function copyToClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

/**
 * Small history chart. Each series is drawn in its widget's CSS `color`
 * (so it follows the theme); `fill` shades the area under the first series.
 *
 * @param {number[][]} series
 * @param {object} [o]
 * @param {number|null} [o.max] - fixed top of the scale (e.g. 100 for %), or auto
 * @param {string[]} [o.styleClasses] - one per series, for colours
 */
export function sparkline(series, {max = null, styleClasses = ['opsdeck-spark-a', 'opsdeck-spark-b']} = {}) {
    const box = new St.Widget({style_class: 'opsdeck-spark', x_expand: true,
        layout_manager: new Clutter.BinLayout()});
    const peak = Math.max(max ?? 0, ...series.flat(), 1e-9);
    series.forEach((values, i) => {
        const area = new St.DrawingArea({style_class: styleClasses[i] ?? '', x_expand: true, y_expand: true});
        area.connect('repaint', () => {
            const cr = area.get_context();
            try {
                const [w, h] = area.get_surface_size();
                const n = values.length;
                if (n < 2 || w <= 0)
                    return;
                const c = area.get_theme_node().get_foreground_color();
                const rgba = a => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, a);
                const x = k => (k / (n - 1)) * w;
                const y = v => h - 1 - (Math.min(v, peak) / peak) * (h - 2);
                cr.moveTo(x(0), y(values[0]));
                for (let k = 1; k < n; k++)
                    cr.lineTo(x(k), y(values[k]));
                if (i === 0) {
                    // Shade the area under the first series.
                    cr.lineTo(w, h);
                    cr.lineTo(0, h);
                    cr.closePath();
                    rgba(0.18);
                    cr.fill();
                    cr.moveTo(x(0), y(values[0]));
                    for (let k = 1; k < n; k++)
                        cr.lineTo(x(k), y(values[k]));
                }
                rgba(1);
                cr.setLineWidth(1.5);
                cr.stroke();
            } finally {
                cr.$dispose();
            }
        });
        box.add_child(area);
    });
    return box;
}

/** One thin vertical bar per CPU thread. */
export function coreStrip(percents) {
    const strip = new St.BoxLayout({style_class: 'opsdeck-cores', x_expand: true});
    const height = 22;
    const width = Math.max(2, Math.min(8, Math.floor(380 / Math.max(1, percents.length)) - 2));
    for (const pct of percents) {
        const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok';
        // Spacer on top, fill at the bottom.
        const track = vbox({style_class: 'opsdeck-core', width, height});
        track.add_child(new St.Widget({y_expand: true}));
        track.add_child(new St.Widget({
            style_class: `opsdeck-core-fill opsdeck-level-${level}`,
            x_expand: true,
            height: Math.max(1, Math.round((height * pct) / 100)),
        }));
        strip.add_child(track);
    }
    return strip;
}
