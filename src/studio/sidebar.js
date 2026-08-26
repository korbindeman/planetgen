/*
 * Collapsible, resizable sidebar. Width and collapsed state persist.
 * First paint is restored from the same key in index.html so the
 * panel does not jump after JS loads.
 */
'use strict';

const STORE_KEY = 'planetgen.sidebar';
const DEFAULT_REM = 17;
const MIN_REM = 14;
const MAX_REM = 36;
const MAX_VIEW_RATIO = 0.5;
const NUDGE_PX = 16;


function remSize() {
    if (typeof getComputedStyle === 'undefined') return 16;
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}


function clampWidth(px, viewWidth, rem) {
    const r = rem > 0 ? rem : 16;
    const min = MIN_REM * r;
    const max = Math.max(min, Math.min(MAX_REM * r, Math.max(0, viewWidth) * MAX_VIEW_RATIO));
    const n = Number(px);
    if (!Number.isFinite(n)) return Math.round(min);
    return Math.round(Math.min(max, Math.max(min, n)));
}


function readStored() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {width: null, collapsed: false};
        }
        const width = typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0
            ? raw.width
            : null;
        return {width, collapsed: !!raw.collapsed};
    } catch (_) {
        return {width: null, collapsed: false};
    }
}


function writeStored(width, collapsed) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({width, collapsed}));
    } catch (_) { /* private mode / quota */ }
}


function createSidebar() {
    const stored = readStored();
    const rem = remSize();
    let widthPx = stored.width != null
        ? clampWidth(stored.width, window.innerWidth, rem)
        : Math.round(DEFAULT_REM * rem);
    let collapsed = stored.collapsed;
    let drag = null;

    const sidebar = document.getElementById('sidebar');
    const inner = sidebar && sidebar.querySelector('.sidebar-inner');
    const toggle = document.getElementById('sidebar-toggle');
    const handle = document.getElementById('sidebar-resize');
    if (!sidebar || !inner || !toggle || !handle) return null;

    function apply() {
        if (collapsed) document.body.classList.add('sidebar-collapsed');
        else document.body.classList.remove('sidebar-collapsed');
        document.body.style.setProperty('--sidebar-width', `${widthPx}px`);
        inner.toggleAttribute('inert', collapsed);
        inner.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
        toggle.title = collapsed ? 'Show sidebar ([)' : 'Hide sidebar ([)';
        const remNow = remSize();
        const min = Math.round(MIN_REM * remNow);
        const max = Math.round(Math.max(min, Math.min(MAX_REM * remNow, window.innerWidth * MAX_VIEW_RATIO)));
        handle.setAttribute('aria-valuemin', String(min));
        handle.setAttribute('aria-valuemax', String(max));
        handle.setAttribute('aria-valuenow', String(widthPx));
    }

    function persist() {
        writeStored(widthPx, collapsed);
    }

    function setWidth(next) {
        widthPx = clampWidth(next, window.innerWidth, remSize());
        apply();
    }

    function setCollapsed(next, options) {
        const want = !!next;
        if (want === collapsed) return;
        collapsed = want;
        if (collapsed) {
            const active = document.activeElement;
            if (active && sidebar.contains(active) && active !== toggle && active !== handle) {
                toggle.focus();
            }
        } else if (options && options.focusToggle) {
            toggle.focus();
        }
        apply();
        persist();
    }

    function toggleCollapsed(options) {
        setCollapsed(!collapsed, options);
    }

    function endDrag() {
        if (!drag) return;
        if (drag.pointerId != null) {
            try { handle.releasePointerCapture(drag.pointerId); } catch (_) { /* already released */ }
        }
        drag = null;
        document.body.classList.remove('is-resizing');
        persist();
    }

    handle.addEventListener('pointerdown', (event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing');
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: collapsed ? 0 : widthPx,
            moved: false,
            wasCollapsed: collapsed,
        };
    });

    handle.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const delta = event.clientX - drag.startX;
        if (!drag.moved && Math.abs(delta) < 3) return;
        drag.moved = true;
        const next = drag.startWidth + delta;
        if (drag.wasCollapsed) {
            if (next < MIN_REM * remSize() * 0.5) return;
            collapsed = false;
        }
        setWidth(next);
    });

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    handle.addEventListener('dblclick', (event) => {
        event.preventDefault();
        collapsed = false;
        setWidth(DEFAULT_REM * remSize());
        persist();
    });

    handle.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (collapsed && event.key === 'ArrowRight') {
                setCollapsed(false);
                return;
            }
            if (collapsed && event.key === 'ArrowLeft') return;
            setWidth(widthPx + (event.key === 'ArrowRight' ? NUDGE_PX : -NUDGE_PX));
            persist();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleCollapsed();
        } else if (event.key === 'Home') {
            event.preventDefault();
            collapsed = false;
            setWidth(MIN_REM * remSize());
            persist();
        } else if (event.key === 'End') {
            event.preventDefault();
            collapsed = false;
            setWidth(MAX_REM * remSize());
            persist();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== '[') return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (document.documentElement.classList.contains('is-picker')) return;
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
        if (event.target && event.target.isContentEditable) return;
        event.preventDefault();
        toggleCollapsed();
    });

    window.addEventListener('resize', () => {
        if (collapsed) return;
        const next = clampWidth(widthPx, window.innerWidth, remSize());
        if (next === widthPx) return;
        widthPx = next;
        apply();
        persist();
    });

    apply();
    return {toggle: toggleCollapsed, setWidth, setCollapsed};
}


function mount() {
    return createSidebar();
}


module.exports = {
    STORE_KEY,
    DEFAULT_REM,
    MIN_REM,
    MAX_REM,
    clampWidth,
    readStored,
    writeStored,
    mount,
};
