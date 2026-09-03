// App-bar behaviour shared by both pages: page nav with the pending-suggestions
// badge, the filter field, the refresh button, the shortcuts sheet, and the
// site switcher row (preset tabs, custom-path tab with crumbs, "Path…" popover).

import { el, icon, apiJson, keys, debounce, setUrlState, urlParams, store, fmt } from './common.js';
import { showShortcuts, positionPopover } from './ui.js';

// ---------------------------------------------------------------- nav + pending badge

let lastCounts = null;

export function pendingCount(counts) {
    return Object.values(counts || {}).reduce((n, c) => n + ((c && c.pending) || 0), 0);
}

export function applyPendingBadge(counts) {
    lastCounts = counts;
    const chip = document.getElementById('pending-chip');
    const sr = document.getElementById('pending-sr');
    if (!chip) return;
    const n = pendingCount(counts);
    chip.textContent = String(n);
    chip.classList.toggle('chip--pending', n > 0);
    if (sr) sr.textContent = n ? `, ${fmt.plural(n, 'pending suggestion')}` : '';
}

// Fetches suggestion counts and updates the badge. Never throws; returns counts or null.
export async function refreshPendingBadge() {
    try {
        const counts = await apiJson('suggestions/counts');
        applyPendingBadge(counts);
        return counts;
    } catch {
        return lastCounts;
    }
}

// Re-check the badge when the tab becomes visible again (another tab may have acted).
export function watchPendingBadge() {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshPendingBadge(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) refreshPendingBadge(); });
}

export function setNavLinks({ site = null, prefix = null } = {}) {
    const files = document.querySelector('[data-nav=files]');
    const sugg = document.querySelector('[data-nav=suggestions]');
    if (files) files.href = prefix ? `index.html?prefix=${encodeURIComponent(prefix)}` : 'index.html';
    if (sugg) sugg.href = site ? `suggestions.html?site=${encodeURIComponent(site)}` : 'suggestions.html';
}

// ---------------------------------------------------------------- refresh

export function initRefresh(onRefresh) {
    const btn = document.getElementById('refresh-btn');
    if (!btn) return { markRefreshed() {}, setBusy() {} };
    let lastAt = null;
    const updateTitle = () => {
        btn.title = lastAt ? `Refresh (r) · updated ${fmt.relative(lastAt)}` : 'Refresh (r)';
    };
    updateTitle();
    setInterval(updateTitle, 30000);
    btn.addEventListener('click', () => onRefresh());
    keys.on('r', () => onRefresh());
    return {
        markRefreshed() { lastAt = new Date().toISOString(); updateTitle(); },
        setBusy(busy) { btn.classList.toggle('is-busy', busy); btn.setAttribute('aria-busy', busy ? 'true' : 'false'); },
    };
}

// ---------------------------------------------------------------- filter

// initFilter({onChange(value), enabled()}) -> {get, set, clear, focus}
export function initFilter({ onChange, enabled = () => true, param = 'q' }) {
    const input = document.getElementById('filter');
    const clearBtn = document.getElementById('filter-clear');
    const toggle = document.getElementById('filter-toggle');
    const appbar = document.getElementById('appbar');
    if (!input) return { get: () => '', set() {}, clear() {}, focus() {} };

    const reflect = () => { if (clearBtn) clearBtn.hidden = !input.value; };
    const emit = debounce(() => {
        setUrlState({ [param]: input.value.trim() });
        onChange(input.value.trim());
    }, 150);
    input.addEventListener('input', () => { reflect(); emit(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            if (input.value) { input.value = ''; reflect(); setUrlState({ [param]: '' }); onChange(''); }
            else input.blur();
        } else if (e.key === 'Enter') {
            input.blur();
        }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; reflect(); setUrlState({ [param]: '' }); onChange(''); input.focus(); });
    if (toggle && appbar) {
        toggle.addEventListener('click', () => {
            const open = appbar.classList.toggle('is-filter-open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) input.focus();
        });
    }
    keys.on('/', () => {
        if (!enabled()) return false;
        if (appbar && toggle && getComputedStyle(toggle).display !== 'none') {
            appbar.classList.add('is-filter-open');
            toggle.setAttribute('aria-expanded', 'true');
        }
        input.focus();
        input.select();
    });

    const initial = urlParams().get(param) || '';
    if (initial) { input.value = initial; reflect(); }

    return {
        get: () => input.value.trim(),
        set(v, { silent = false } = {}) { input.value = v || ''; reflect(); setUrlState({ [param]: input.value.trim() }); if (!silent) onChange(input.value.trim()); },
        clear({ silent = false } = {}) { this.set('', { silent }); },
        focus() { input.focus(); },
    };
}

// ---------------------------------------------------------------- shortcuts sheet

export function initHelp(sections) {
    const btn = document.getElementById('help-btn');
    const open = () => showShortcuts(sections);
    if (btn) btn.addEventListener('click', open);
    keys.on('?', open);
}

// ---------------------------------------------------------------- site switcher

// renderSwitcher(container, {items: [{id, label, href, badge, badgeClass, title}], currentId,
//   extra: null | {crumbs: [{label, id, current}], backId, backLabel}, onSelect(id)})
export function renderSwitcher(container, { items, currentId, extra = null, onSelect }) {
    container.replaceChildren();
    let activeEl = null;
    for (const it of items) {
        const active = !extra && it.id === currentId;
        const a = el('a', {
            class: `tab${it.cls ? ' ' + it.cls : ''}`, href: it.href, title: it.title || null, 'aria-current': active ? 'page' : null,
            onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onSelect(it.id); },
        }, it.icon ? icon(it.icon) : null, it.label);
        if (it.badge != null) {
            a.append(el('span', { class: `chip${it.badgeClass ? ' ' + it.badgeClass : ''}`, 'aria-hidden': 'true' }, String(it.badge)));
            if (it.badgeLabel) a.append(el('span', { class: 'visually-hidden', text: `, ${it.badgeLabel}` }));
        }
        container.append(a);
        if (active) activeEl = a;
    }
    if (extra) {
        const tab = el('span', { class: 'tab tab--custom is-active', 'aria-current': 'page' });
        extra.crumbs.forEach((c, i) => {
            if (i > 0) tab.append(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
            if (c.current) tab.append(el('span', { class: 'crumb', 'aria-current': 'page' }, c.label));
            else tab.append(el('button', { type: 'button', class: 'crumb', title: `Go to ${c.id}`, onclick: () => onSelect(c.id) }, c.label));
        });
        if (extra.backId) {
            tab.append(el('button', { type: 'button', class: 'btn btn--icon btn--sm btn--ghost', 'aria-label': extra.backLabel || `Back to ${extra.backId}`, onclick: () => onSelect(extra.backId) }, icon('x')));
        }
        container.append(tab);
        activeEl = tab;
    }
    // Centre the active tab in a scrollable rail without touching the page's
    // vertical scroll (scrollIntoView would drag the page up on silent reloads).
    if (activeEl) {
        const centre = () => {
            if (container.scrollWidth <= container.clientWidth) return;
            container.scrollLeft = activeEl.offsetLeft - (container.clientWidth - activeEl.offsetWidth) / 2;
        };
        centre();
        requestAnimationFrame(centre);
    }
}

// [ and ] hop between preset items.
export function bindPresetKeys({ getItems, getCurrentId, onSelect }) {
    const move = (dir) => {
        const items = getItems();
        if (!items.length) return;
        const i = items.findIndex(x => x.id === getCurrentId());
        const next = i < 0 ? (dir > 0 ? 0 : items.length - 1) : (i + dir + items.length) % items.length;
        if (items[next].id === getCurrentId()) return;   // single site: nothing to hop to
        onSelect(items[next].id);
    };
    keys.on('[', () => move(-1));
    keys.on(']', () => move(1));
}

// "Path…" popover: type any prefix. Returns {open()}.
export function initPathPopover({ button, getCurrent, onSubmit }) {
    if (!button) return { open() {} };
    const input = el('input', { type: 'text', id: 'path-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'site/folder/', 'aria-describedby': 'path-hint' });
    const pop = el('form', { class: 'path-pop', popover: 'auto', id: 'path-pop' },
        el('label', { class: 'label', for: 'path-input', text: 'Go to prefix' }),
        el('div', { class: 'path-pop__row' },
            el('span', { class: 'field field--mono' }, icon('folder'), input),
            el('button', { type: 'submit', class: 'btn btn--primary' }, 'Go'),
        ),
        el('p', { class: 'form-hint', id: 'path-hint', text: 'Any prefix in the bucket, e.g. dokinomicon/archive. A trailing slash is added.' }),
    );
    document.body.append(pop);
    const open = () => {
        input.value = getCurrent();
        positionPopover(pop, button, { align: 'end' });
        pop.showPopover();
    };
    pop.addEventListener('toggle', (e) => {
        const isOpen = e.newState === 'open';
        button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) { input.focus(); input.select(); }
        else if (button.isConnected && document.activeElement === document.body) button.focus({ preventScroll: true });
    });
    pop.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = input.value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
        pop.hidePopover();
        if (raw) onSubmit(raw + '/');
    });
    button.addEventListener('click', () => { if (pop.matches(':popover-open')) pop.hidePopover(); else open(); });
    return { open };
}

// Presets are cached so the switcher paints before the first response.
export const PREFIX_CACHE_KEY = 'cm_prefixes';
export function cachedPrefixes() { return store.get(PREFIX_CACHE_KEY, []) || []; }
export function cachePrefixes(list) { if (Array.isArray(list) && list.length) store.set(PREFIX_CACHE_KEY, list); }
