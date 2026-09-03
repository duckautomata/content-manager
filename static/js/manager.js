// Files page: prefix navigation, data-file panel with spreadsheet sync, media
// tiles / file rows, preview dialog, uploads, delete + delayed delete, and the
// in-app viewer. One `state`, one idempotent render per load, in-place patches
// for single-item actions.

import {
    el, icon, apiJson, ApiError, fmt, timeEl, keys, setUrlState, urlParams, store, extOf,
    PREVIEWABLE_EXTENSIONS, TABLE_EXTENSIONS, PLAYABLE_VIDEO_EXTENSIONS, publicUrl, startTicker, srOnly,
    installImageFallback, getApiKey, requireLogin, isTypingTarget, FALLBACK_IMG,
} from './common.js';
import { mountShell, openDialog, topDialog, confirmDialog, toast, copyWithFeedback, setBusy, openMenu } from './ui.js';
import {
    refreshPendingBadge, watchPendingBadge, setNavLinks, initRefresh, initFilter, initHelp,
    renderSwitcher, bindPresetKeys, initPathPopover, cachedPrefixes, cachePrefixes,
} from './shell.js';
import { createUploader, replaceProblem } from './uploads.js';
import { createViewer } from './viewer.js';

const DEFAULT_PREFIX = 'home/';
const SECTION_KEY = 'cm_section';
const DATA_OPEN_KEY = 'cm_dataOpen';
const CHUNK_THRESHOLD = 1500;
const PREVIEW_CACHE_MAX = 24;

function normalizePrefix(p) {
    let s = String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!s) return DEFAULT_PREFIX;
    if (!s.endsWith('/')) s += '/';
    return s;
}

function readPrefix() {
    return normalizePrefix(urlParams().get('prefix') ?? DEFAULT_PREFIX);
}

const state = {
    prefix: readPrefix(),
    section: null,
    q: '',
    images: [],
    videos: [],
    others: [],
    publicUrlPrefix: '',
    prefixes: cachedPrefixes(),
    csvSources: new Map(),      // filename -> {file, sheet_url}
    scheduledByKey: new Map(),  // R2 key -> scheduled-delete record
    previewCache: new Map(),    // `${key}|${last_modified}|${size}` -> preview payload
    latestPreview: new Map(),   // key -> most recent preview payload (for sync deltas)
    mediaIndex: new Map(),      // slug -> {item, kind}
    loaded: false,
    loading: null,
    seq: 0,
    pendingView: urlParams().get('view') || null,
    pendingPrefix: '_suggestions/_pending/',   // confirmed by the listing response
    imageRefs: new Map(),                        // pending view: image id -> suggestions referencing it
    refsLoaded: false,
};

// ---------------------------------------------------------------- DOM

const $ = (id) => document.getElementById(id);
const dom = {
    main: $('main'), content: $('content'), viewer: $('viewer'),
    switcher: $('site-switcher'), pathBtn: $('path-btn'),
    folders: $('folders'), prefixNote: $('prefix-note'),
    dataPanel: $('data-panel'), dataCount: $('data-count'), dataFilterChip: $('data-filter-chip'),
    syncBtn: $('sync-btn'), dataToggle: $('data-toggle'), dataBody: $('data-body'), dataRows: $('data-rows'), syncResult: $('sync-result'),
    sectionbar: $('sectionbar'), filterChip: $('filter-chip'),
    tabs: { images: $('tab-images'), videos: $('tab-videos'), others: $('tab-others') },
    sections: { images: $('sec-images'), videos: $('sec-videos'), others: $('sec-others') },
    containers: { images: $('grid-images'), videos: $('grid-videos'), others: $('rows-others') },
    empty: $('content-empty'), error: $('content-error'),
    dropOverlay: $('drop-overlay'), dropText: $('drop-overlay-text'),
    fileInput: $('file-input'), replaceInput: $('replace-input'), uploadBtn: $('upload-btn'),
    preview: $('preview'), previewTitle: $('preview-title'), previewPos: $('preview-pos'),
    previewMedia: $('preview-media'), previewMeta: $('preview-meta'), previewActions: $('preview-actions'),
};

let refresh, filter, uploader, viewer;

// ---------------------------------------------------------------- helpers

const keyOf = (name) => state.prefix + name;
const urlFor = (key) => publicUrl(state.publicUrlPrefix, key);
const isDataFile = (name) => state.csvSources.has(name);
const siteOf = (prefix) => prefix.split('/').filter(Boolean)[0] || '';
// The public API parks visitor uploads under this prefix; the manager shows it as its own view.
const isPendingView = () => state.prefix === state.pendingPrefix;
const NO_UPLOAD_HERE = 'Pending uploads come from the public API. Switch to a site to upload files.';

function mediaKeys(item) {
    return [item.files.original, item.files.preview, item.files.thumbnail].filter(Boolean).map(keyOf);
}

function scheduledFor(item) {
    const keysToCheck = item.files ? mediaKeys(item) : [item.key];
    for (const k of keysToCheck) { const rec = state.scheduledByKey.get(k); if (rec) return rec; }
    return null;
}

function cacheKeyFor(other) { return `${other.key}|${other.last_modified}|${other.size}`; }

function otherByName(name) { return state.others.find(o => o.filename === name) || null; }

// Reads a preview through the cache (keyed on the listing's last_modified+size
// so a changed file is always re-read). `force` bypasses the cache.
async function fetchPreview(key, { force = false, signal = null } = {}) {
    const other = state.others.find(o => o.key === key);
    const ck = other ? cacheKeyFor(other) : key;
    if (!force && state.previewCache.has(ck)) return state.previewCache.get(ck);
    const p = await apiJson(`content/preview?key=${encodeURIComponent(key)}`, { signal });
    state.previewCache.set(ck, p);
    state.latestPreview.set(key, p);
    while (state.previewCache.size > PREVIEW_CACHE_MAX) state.previewCache.delete(state.previewCache.keys().next().value);
    return p;
}

function updateTitle() {
    document.title = `${state.prefix} — Content Manager`;
}

// ---------------------------------------------------------------- navigation

function navigate(prefix, { push = true } = {}) {
    prefix = normalizePrefix(prefix);
    state.pendingView = null;   // a deep-linked ?view= belongs to the prefix it was typed with
    if (viewer.isOpen()) viewer.close({ fromHistory: true });
    if (prefix === state.prefix && state.loaded) {
        setUrlState({ view: null, section: state.section }, { push: false });
        load({ silent: true });
        return;
    }
    state.prefix = prefix;
    state.section = null;
    setUrlState({ prefix, view: null, section: null }, { push });
    load();
}

window.addEventListener('popstate', () => {
    const p = urlParams();
    const prefix = normalizePrefix(p.get('prefix') ?? DEFAULT_PREFIX);
    const view = p.get('view');
    // The filter is part of the URL, so Back/Forward must restore it too.
    const q = (p.get('q') || '').trim();
    const qChanged = q !== state.q;
    if (qChanged) { state.q = q; filter.set(q, { silent: true }); }
    if (prefix !== state.prefix) {
        if (viewer.isOpen()) viewer.close({ fromHistory: true });
        state.prefix = prefix;
        state.section = null;
        state.pendingView = view;
        load();
        return;
    }
    state.pendingView = null;
    if (view) {
        if (!viewer.isOpen() || viewer.currentFile() !== view) viewer.open(view, { push: false });
    } else if (viewer.isOpen()) {
        viewer.close({ fromHistory: true });
    }
    const section = p.get('section');
    if (section && section !== state.section && isSection(section)) selectSection(section, { silent: true });
    if (qChanged && state.loaded) { applyFilter(); ensureVisibleSection(); renderEmptyState(); }
});

function renderSwitcherNow() {
    const presets = state.prefixes.length ? state.prefixes : [DEFAULT_PREFIX];
    const items = presets.map(p => ({ id: p, label: p.replace(/\/$/, ''), href: `?prefix=${encodeURIComponent(p)}`, title: p }));
    items.push({
        id: state.pendingPrefix, label: 'Pending uploads', icon: 'inbox', cls: 'tab--aside',
        href: `?prefix=${encodeURIComponent(state.pendingPrefix)}`,
        title: `Media uploaded through the public suggestion API (${state.pendingPrefix})`,
    });
    let extra = null;
    if (presets.includes(state.prefix)) {
        store.set('cm_lastPreset', state.prefix);
    } else if (!isPendingView()) {
        const segs = state.prefix.split('/').filter(Boolean);
        extra = {
            crumbs: segs.map((s, i) => ({ label: s, id: segs.slice(0, i + 1).join('/') + '/', current: i === segs.length - 1 })),
            backId: store.get('cm_lastPreset', presets[0]) || presets[0],
            backLabel: 'Back to a site',
        };
    }
    renderSwitcher(dom.switcher, { items, currentId: state.prefix, extra, onSelect: (id) => navigate(id) });
    setNavLinks({ site: isPendingView() ? null : siteOf(state.prefix) });
}

// ---------------------------------------------------------------- loading

async function load({ silent = false } = {}) {
    if (state.loading) state.loading.abort();
    const ac = new AbortController();
    state.loading = ac;
    const mySeq = ++state.seq;
    refresh.setBusy(true);
    dom.main.setAttribute('aria-busy', 'true');
    dom.error.hidden = true;
    updateTitle();
    renderSwitcherNow();
    if (!silent) {
        state.csvSources = new Map();
        state.mediaIndex = new Map();
        dom.dataRows.replaceChildren();
        dom.dataPanel.hidden = true;
        dom.syncResult.hidden = true;
        dom.folders.hidden = true;
        dom.empty.hidden = true;
        renderSkeletons();
    } else {
        dom.content.classList.add('is-loading');
    }
    try {
        const q = `prefix=${encodeURIComponent(state.prefix)}`;
        const wantRefs = isPendingView();
        const [data, sched, refs] = await Promise.all([
            apiJson(`content?${q}`, { signal: ac.signal }),
            apiJson(`scheduled-deletes?${q}`, { signal: ac.signal }).catch(() => ({ scheduled: [] })),
            wantRefs ? apiJson('suggestions/image-refs', { signal: ac.signal }).catch(() => null) : Promise.resolve(null),
        ]);
        if (mySeq !== state.seq) return;
        if (data.pending_prefix) state.pendingPrefix = normalizePrefix(data.pending_prefix);
        state.imageRefs = new Map(Object.entries(refs || {}));
        state.refsLoaded = wantRefs && refs !== null;
        state.images = data.images || [];
        state.videos = data.videos || [];
        state.others = data.others || [];
        state.publicUrlPrefix = data.public_url_prefix || '';
        if (Array.isArray(data.common_prefixes) && data.common_prefixes.length) {
            state.prefixes = data.common_prefixes.map(normalizePrefix);
            cachePrefixes(state.prefixes);
        }
        state.csvSources = new Map((data.csv_sources || []).map(s => [s.file, s]));
        state.scheduledByKey = new Map();
        for (const rec of sched.scheduled || []) for (const k of rec.keys || []) state.scheduledByKey.set(k, rec);
        state.loaded = true;
        render();
        refresh.markRefreshed();
        if (state.pendingView) {
            const v = state.pendingView;
            state.pendingView = null;
            viewer.open(v, { push: false });
        }
        prefetchPreviews();
    } catch (err) {
        if (mySeq !== state.seq || (err && err.name === 'AbortError')) return;
        renderError(err);
    } finally {
        if (mySeq === state.seq) {
            refresh.setBusy(false);
            dom.main.removeAttribute('aria-busy');
            dom.content.classList.remove('is-loading');
            state.loading = null;
        }
    }
}

// Every wipe of a container bumps its generation so a chunked fill still in
// flight for the previous listing stops instead of appending stale nodes.
function resetContainer(container, ...children) {
    container._gen = (container._gen || 0) + 1;
    container.replaceChildren(...children);
}

function renderSkeletons() {
    dom.sectionbar.hidden = true;
    for (const name of Object.keys(dom.sections)) { dom.sections[name].hidden = name !== 'images'; }
    resetContainer(dom.containers.images, ...Array.from({ length: 12 }, () => el('div', { class: 'skeleton skeleton--tile', 'aria-hidden': 'true' })));
    resetContainer(dom.containers.videos);
    resetContainer(dom.containers.others);
}

function renderError(err) {
    const detail = err instanceof ApiError ? err.detail : (err && err.message) || 'Unknown error';
    for (const c of Object.values(dom.containers)) resetContainer(c);
    for (const s of Object.values(dom.sections)) s.hidden = true;
    dom.sectionbar.hidden = true;
    dom.error.replaceChildren(
        icon('alert'),
        el('div', { class: 'notice__body' },
            el('div', null, el('strong', { text: `Could not load ${state.prefix}` }), ` — ${detail}`),
            el('div', { class: 'notice__line' },
                el('button', { type: 'button', class: 'btn btn--sm', onclick: () => load() }, icon('refresh'), 'Retry'),
                ...state.prefixes.filter(p => p !== state.prefix).map(p => el('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => navigate(p) }, p)),
            ),
        ),
    );
    dom.error.hidden = false;
}

// ---------------------------------------------------------------- render

function render() {
    dom.error.hidden = true;
    renderSwitcherNow();
    renderPrefixNote();
    dom.uploadBtn.disabled = isPendingView();
    dom.uploadBtn.title = isPendingView() ? NO_UPLOAD_HERE : '';
    renderFolders();
    renderDataPanel();
    renderMedia();
    applyFilter();
    const remembered = (store.get(SECTION_KEY, {}) || {})[state.prefix];
    selectSection(pickSection(state.section || urlParams().get('section') || remembered), { silent: true });
    renderEmptyState();
}

const SECTIONS = ['images', 'videos', 'others'];
// Own-key check: URL/localStorage values such as "constructor" must not pass as sections.
const isSection = (name) => typeof name === 'string' && SECTIONS.includes(name);

// The section to show: `preferred` when valid and non-empty, else the first non-empty one.
function pickSection(preferred) {
    const counts = { images: state.images.length, videos: state.videos.length, others: state.others.filter(o => !isDataFile(o.filename)).length };
    let s = preferred;
    if (!isSection(s) || (counts[s] === 0 && !state.q)) s = counts.images ? 'images' : counts.videos ? 'videos' : counts.others ? 'others' : 'images';
    return s;
}

// After an in-place change (delete, upload, filter) the active tab may have emptied and hidden itself.
function ensureVisibleSection() {
    if (isSection(state.section) && dom.tabs[state.section].hidden) selectSection(pickSection(null), { silent: true });
}

// Explains the pending-uploads view and how many items no suggestion claims.
function renderPrefixNote() {
    const note = dom.prefixNote;
    if (!isPendingView()) { note.hidden = true; return; }
    const all = state.images.concat(state.videos);
    const orphans = all.filter(it => !state.imageRefs.has(it.slug)).length;
    note.className = `notice ${state.refsLoaded ? 'notice--info' : 'notice--warn'}`;
    const body = el('div', { class: 'notice__body' },
        el('div', null, el('strong', { text: 'Pending uploads' }), ' — media visitors uploaded through the public suggestion API. Approving a suggestion moves its files to the site; everything left here expires after 30 days.'));
    if (state.refsLoaded) {
        body.append(el('div', null, orphans
            ? `${fmt.plural(orphans, 'item')} ${orphans === 1 ? 'is' : 'are'} not attached to any suggestion: abandoned submissions or abuse. Open one to see its upload time, or delete it from the preview.`
            : 'Every item here belongs to a suggestion.'));
    } else {
        body.append(el('div', { class: 'text-warn', text: 'Could not load which suggestions reference these files, so they are not grouped.' }));
    }
    note.replaceChildren(icon(state.refsLoaded ? 'info' : 'alert'), body);
    note.hidden = false;
}

function renderFolders() {
    const folders = new Map();
    const bump = (name) => {
        const i = name.indexOf('/');
        if (i <= 0) return;
        const seg = name.slice(0, i);
        folders.set(seg, (folders.get(seg) || 0) + 1);
    };
    state.images.forEach(m => bump(m.slug));
    state.videos.forEach(m => bump(m.slug));
    state.others.forEach(o => bump(o.filename));
    dom.folders.replaceChildren();
    if (!folders.size) { dom.folders.hidden = true; return; }
    dom.folders.append(el('span', null, icon('folder'), ' Folders'));
    for (const [seg, n] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
        dom.folders.append(el('button', { type: 'button', class: 'chip', onclick: () => navigate(state.prefix + seg + '/') }, `${seg}/`, el('span', { class: 'muted', text: String(n) })));
    }
    dom.folders.hidden = false;
}

// ---- data panel

function renderDataPanel() {
    dom.dataRows.replaceChildren();
    if (!state.csvSources.size) { dom.dataPanel.hidden = true; return; }
    dom.dataCount.textContent = String(state.csvSources.size);
    for (const src of state.csvSources.values()) {
        dom.dataRows.append(makeDataRow(src, otherByName(src.file)));
    }
    dom.dataPanel.hidden = false;
    const phone = matchMedia('(max-width: 640px)').matches;
    dom.dataToggle.hidden = !phone;
    setDataOpen(phone ? store.get(DATA_OPEN_KEY, true) !== false : true);
}

function setDataOpen(open) {
    dom.dataBody.hidden = !open;
    dom.dataToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    dom.dataToggle.setAttribute('aria-label', open ? 'Collapse data files' : 'Expand data files');
    dom.dataToggle.querySelector('use').setAttribute('href', open ? '#i-chevron-up' : '#i-chevron-down');
}

function makeDataRow(src, other) {
    const name = src.file;
    const sched = other ? scheduledFor(other) : null;
    const row = el('div', { class: `row row--data${other ? '' : ' row--missing'}${sched ? ' row--scheduled' : ''}`, dataset: { id: name, q: name.toLowerCase() } });
    row.append(icon('table', 'row__glyph'));

    const meta = el('div', { class: 'row__meta' });
    if (other) {
        meta.append(el('span', { class: 'row__rows', text: '— rows' }));
        meta.append(el('span', { text: fmt.bytes(other.size) }));
        meta.append(el('span', null, 'updated ', timeEl(other.last_modified)));
        if (sched) meta.append(el('span', { class: 'chip chip--warn' }, icon('clock'), 'deletes in ', el('span', { dataset: { until: sched.due_at }, text: fmt.until(sched.due_at) })));
    } else {
        meta.append(el('span', { class: 'text-warn', text: 'not in the bucket yet — press Update from spreadsheet' }));
    }
    const nameNode = other
        ? el('button', { type: 'button', class: 'row__name mono', dataset: { action: 'view' }, title: `View ${name}` }, name)
        : el('span', { class: 'row__name mono', text: name });
    row.append(el('div', { class: 'row__main' }, nameNode, meta));

    const actions = el('div', { class: 'row__actions' });
    if (sched) actions.append(el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'cancel-sched' } }, 'Cancel deletion'));
    if (other) actions.append(el('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'view' }, 'aria-label': `View ${name}` }, icon('eye'), el('span', { class: 'btn__label', text: 'View' })));
    if (src.sheet_url) actions.append(el('a', { class: 'btn btn--sm', href: src.sheet_url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open the Google Sheet for ${name}` }, el('span', { class: 'btn__label', text: 'Open sheet' }), icon('ext'), srOnly('(opens in a new tab)')));
    if (other) {
        const dl = urlFor(other.key);
        if (dl) actions.append(el('a', { class: 'btn btn--sm btn--ghost', href: dl, target: '_blank', rel: 'noopener noreferrer', title: 'Public CDN copy (may lag behind the bucket)', 'aria-label': `Download ${name}` }, icon('download'), el('span', { class: 'btn__label', text: 'Download' })));
        actions.append(el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--ghost', dataset: { action: 'menu' }, 'aria-label': `More actions for ${name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more')));
    }
    row.append(actions);
    return row;
}

function applyPreviewToRow(name, preview) {
    const row = dom.dataRows.querySelector(`.row[data-id="${CSS.escape(name)}"] .row__rows`);
    if (!row) return;
    if (!preview) { row.textContent = 'preview unavailable'; row.classList.add('text-warn'); return; }
    row.classList.remove('text-warn');
    row.textContent = preview.kind === 'table' ? `${fmt.int(preview.total_rows)} rows · ${preview.header.length} cols` : `${fmt.int(preview.total_chars)} chars`;
}

// Stamps a preview's row/col count onto a data row once it arrives, unless the
// listing has moved on (same-named files exist in several prefixes).
function stampRow(name, promise) {
    const seq = state.seq;
    promise.then(p => { if (state.seq === seq) applyPreviewToRow(name, p); })
        .catch(() => { if (state.seq === seq) applyPreviewToRow(name, null); });
}

function prefetchPreviews() {
    for (const src of state.csvSources.values()) {
        const other = otherByName(src.file);
        if (other) stampRow(src.file, fetchPreview(other.key));
    }
}

// ---- media + other files

function renderMedia() {
    state.mediaIndex = new Map();
    for (const it of state.images) state.mediaIndex.set(it.slug, { item: it, kind: 'image' });
    for (const it of state.videos) state.mediaIndex.set(it.slug, { item: it, kind: 'video' });
    if (isPendingView() && state.refsLoaded) {
        fillGrouped(dom.containers.images, state.images, 'image');
        fillGrouped(dom.containers.videos, state.videos, 'video');
    } else {
        fillContainer(dom.containers.images, state.images, (it) => makeTile(it, 'image'));
        fillContainer(dom.containers.videos, state.videos, (it) => makeTile(it, 'video'));
    }
    fillContainer(dom.containers.others, state.others.filter(o => !isDataFile(o.filename)), makeRow);
}

// Pending-uploads view: visitor uploads split by whether any suggestion references them,
// the unclaimed ones first because those are the ones worth a look.
function fillGrouped(container, items, kind) {
    resetContainer(container);
    const orphans = items.filter(it => !state.imageRefs.has(it.slug));
    const linked = items.filter(it => state.imageRefs.has(it.slug));
    const frag = document.createDocumentFragment();
    const group = (title, list, tone, hint) => {
        if (!list.length) return;
        frag.append(el('div', { class: 'grid__group', role: 'heading', 'aria-level': '3' },
            el('span', { text: title }),
            el('span', { class: `chip ${tone}`, dataset: { groupCount: '' }, text: String(list.length) }),
            hint ? el('span', { class: 'muted', text: hint }) : null));
        for (const it of list) frag.append(makeTile(it, kind));
    };
    group('Not in any suggestion', orphans, 'chip--warn', 'Uploaded through the public API but never attached to a suggestion.');
    group('In a suggestion', linked, 'chip--info', null);
    container.append(frag);
}

// Group headings show how many of their tiles the filter left visible, and hide when none.
function updateGroupHeaders(container, q) {
    for (const head of container.querySelectorAll('.grid__group')) {
        let shown = 0, total = 0, n = head.nextElementSibling;
        while (n && !n.classList.contains('grid__group')) {
            if (n.dataset.q) { total++; if (!n.hidden) shown++; }
            n = n.nextElementSibling;
        }
        const chip = head.querySelector('[data-group-count]');
        if (chip) chip.textContent = q ? `${shown}/${total}` : String(total);
        head.hidden = shown === 0;
    }
}

function fillContainer(container, items, make) {
    resetContainer(container);
    if (items.length <= CHUNK_THRESHOLD) {
        const frag = document.createDocumentFragment();
        for (const it of items) frag.append(make(it));
        container.append(frag);
        return;
    }
    const gen = container._gen;
    let i = 0;
    const step = () => {
        if (container._gen !== gen) return;   // superseded by a newer listing
        const frag = document.createDocumentFragment();
        const end = Math.min(i + 300, items.length);
        for (; i < end; i++) frag.append(make(items[i]));
        container.append(frag);
        applyFilter();
        if (i < items.length) requestAnimationFrame(step);
    };
    step();
}

function makeTile(item, kind) {
    const thumbKey = item.files.thumbnail || item.files.preview || item.files.original;
    const src = urlFor(keyOf(thumbKey)) || FALLBACK_IMG;
    const sched = scheduledFor(item);
    // Pending view: the caption shows the upload age and a chip names the suggestion, if any.
    const pending = isPendingView();
    const refIds = pending ? (state.imageRefs.get(item.slug) || []).map(r => r.suggestion_id) : [];
    const refLabel = pending ? (refIds.length ? `, in suggestion ${refIds.join(', ')}` : ', not in any suggestion') : '';
    const tile = el('div', {
        class: `tile${kind === 'video' ? ' tile--video' : ''}${state.prefix === 'dokimotes/' ? ' tile--alpha' : ''}${sched ? ' tile--scheduled' : ''}`,
        dataset: { id: item.slug, q: [item.slug, ...refIds].join(' ').toLowerCase() },
    });
    tile.append(el('button', {
        type: 'button', class: 'tile__open', tabindex: '-1', title: pending ? item.slug : null,
        'aria-label': `${item.slug}${refLabel}${sched ? `, scheduled for deletion in ${fmt.until(sched.due_at)}` : ''}`,
    },
        el('span', { class: 'tile__img' }, el('img', { src, alt: '', loading: 'lazy', decoding: 'async' })),
        pending ? el('span', { class: 'tile__cap' }, 'uploaded ', timeEl(item.last_modified)) : el('span', { class: 'tile__cap', text: item.slug }),
    ));
    if (refIds.length) {
        tile.append(el('span', { class: 'chip chip--info tile__ref', 'aria-hidden': 'true', title: refIds.join(', ') },
            el('span', { text: refIds[0] + (refIds.length > 1 ? ` +${refIds.length - 1}` : '') })));
    }
    if (kind === 'video') tile.append(el('span', { class: 'tile__play', 'aria-hidden': 'true' }, icon('play', 'icon--lg')));
    if (sched) tile.append(el('span', { class: 'chip chip--warn tile__sched', 'aria-hidden': 'true' }, icon('clock'), el('span', { dataset: { until: sched.due_at }, text: fmt.until(sched.due_at) })));
    // Out of the tab order: the roving tile itself plus the `c` key cover keyboard users.
    tile.append(el('button', { type: 'button', class: 'tile__copy', tabindex: '-1', 'aria-label': `Copy ID ${item.slug}`, title: 'Copy ID (c)' }, icon('copy')));
    return tile;
}

function makeRow(item) {
    const ext = extOf(item.filename);
    const previewable = PREVIEWABLE_EXTENSIONS.has(ext);
    const sched = scheduledFor(item);
    const row = el('div', { class: `row${sched ? ' row--scheduled' : ''}`, dataset: { id: item.key, q: item.filename.toLowerCase() } });
    row.append(icon(TABLE_EXTENSIONS.has(ext) ? 'table' : previewable ? 'file-text' : 'file', 'row__glyph'));
    const meta = el('div', { class: 'row__meta' }, el('span', { text: fmt.bytes(item.size) }), el('span', null, 'updated ', timeEl(item.last_modified)));
    if (sched) meta.append(el('span', { class: 'chip chip--warn' }, icon('clock'), 'deletes in ', el('span', { dataset: { until: sched.due_at }, text: fmt.until(sched.due_at) })));
    const nameNode = previewable
        ? el('button', { type: 'button', class: 'row__name mono', dataset: { action: 'view' }, title: `View ${item.filename}` }, item.filename)
        : el('span', { class: 'row__name mono', text: item.filename, title: item.filename });
    row.append(el('div', { class: 'row__main' }, nameNode, meta));
    const actions = el('div', { class: 'row__actions' });
    if (sched) actions.append(el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'cancel-sched' } }, 'Cancel deletion'));
    if (previewable) actions.append(el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'view' }, 'aria-label': `View ${item.filename}` }, icon('eye'), el('span', { class: 'btn__label', text: 'View' })));
    const dl = urlFor(item.key);
    if (dl) actions.append(el('a', { class: 'btn btn--sm', href: dl, target: '_blank', rel: 'noopener noreferrer', title: 'Public CDN copy (may lag behind the bucket)', 'aria-label': `Download ${item.filename}` }, icon('download'), el('span', { class: 'btn__label', text: 'Download' })));
    actions.append(el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'replace' }, 'aria-label': `Replace ${item.filename}` }, icon('swap'), el('span', { class: 'btn__label', text: 'Replace' })));
    actions.append(el('button', { type: 'button', class: 'btn btn--sm btn--danger', dataset: { action: 'delete' }, 'aria-label': `Delete ${item.filename}` }, icon('trash'), el('span', { class: 'btn__label', text: 'Delete' })));
    row.append(actions);
    return row;
}

// Rebuilds one node in place (after a schedule/cancel), keeping hidden state and focus.
function refreshNode(node, make) {
    const fresh = make();
    fresh.hidden = node.hidden;
    const hadFocus = node.contains(document.activeElement);
    node.replaceWith(fresh);
    if (hadFocus) { const f = fresh.querySelector('button, a'); if (f) f.focus({ preventScroll: true }); }
    return fresh;
}

function tileNode(slug) { return dom.content.querySelector(`.tile[data-id="${CSS.escape(slug)}"]`); }
function rowNode(key) { return dom.containers.others.querySelector(`.row[data-id="${CSS.escape(key)}"]`); }
function dataRowNode(name) { return dom.dataRows.querySelector(`.row[data-id="${CSS.escape(name)}"]`); }

function rerenderMediaNode(slug) {
    const entry = state.mediaIndex.get(slug);
    const node = tileNode(slug);
    if (entry && node) refreshNode(node, () => makeTile(entry.item, entry.kind));
}

function rerenderOtherNode(item) {
    if (isDataFile(item.filename)) {
        const node = dataRowNode(item.filename);
        if (node) refreshNode(node, () => makeDataRow(state.csvSources.get(item.filename), item));
        const p = state.latestPreview.get(item.key);
        if (p) applyPreviewToRow(item.filename, p);
    } else {
        const node = rowNode(item.key);
        if (node) refreshNode(node, () => makeRow(item));
    }
}

// ---- sections, filter, empty state

function selectSection(name, { silent = false } = {}) {
    if (!isSection(name)) return;
    state.section = name;
    for (const [n, tab] of Object.entries(dom.tabs)) {
        const active = n === name;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        dom.sections[n].hidden = !active;
    }
    const remembered = store.get(SECTION_KEY, {}) || {};
    remembered[state.prefix] = name;
    store.set(SECTION_KEY, remembered);
    setUrlState({ section: name });
    if (!silent) renderEmptyState();
    ensureRovingTile(name);
}

function applyFilter() {
    const q = state.q.toLowerCase();
    const counts = {};
    for (const [name, container] of Object.entries(dom.containers)) {
        let shown = 0, total = 0;
        for (const node of container.children) {
            if (!node.dataset.q) continue;
            total++;
            const match = !q || node.dataset.q.includes(q);
            node.hidden = !match;
            if (match) shown++;
        }
        counts[name] = { shown, total };
        updateGroupHeaders(container, q);
        const chip = dom.tabs[name].querySelector('[data-count]');
        chip.textContent = q ? `${shown}/${total}` : String(total);
        dom.tabs[name].hidden = total === 0 && !q;
    }
    const anyMedia = Object.values(counts).some(c => c.total > 0);
    dom.sectionbar.hidden = !anyMedia;
    dom.filterChip.hidden = !q;
    if (q) dom.filterChip.replaceChildren(`Filter: ${state.q} `, icon('x'), srOnly('Clear filter'));
    // Data rows are never hidden by the filter; just say how many match.
    if (state.csvSources.size && q) {
        const total = state.csvSources.size;
        const n = [...state.csvSources.keys()].filter(f => f.toLowerCase().includes(q)).length;
        dom.dataFilterChip.textContent = `${n} of ${total} match`;
        dom.dataFilterChip.hidden = false;
    } else dom.dataFilterChip.hidden = true;
    ensureRovingTile(state.section);
    return counts;
}

function renderEmptyState() {
    const q = state.q;
    const counts = {
        images: state.images.length, videos: state.videos.length,
        others: state.others.filter(o => !isDataFile(o.filename)).length,
    };
    const nothing = !counts.images && !counts.videos && !counts.others && !state.csvSources.size;
    dom.empty.replaceChildren();
    if (nothing) {
        const isPreset = state.prefixes.includes(state.prefix);
        if (isPendingView()) {
            dom.empty.append(
                el('div', { class: 'empty__title', text: 'No pending uploads.' }),
                el('p', { text: 'Nothing uploaded through the public API is waiting here.' }),
            );
        } else if (isPreset) {
            dom.empty.append(
                el('div', { class: 'empty__title', text: `Nothing in ${state.prefix} yet.` }),
                el('div', { class: 'dropstrip' }, icon('upload', 'icon--lg'), el('span', null, 'Drop files anywhere on the page, or ', el('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: () => dom.fileInput.click() }, 'Upload'))),
            );
        } else {
            const typed = siteOf(state.prefix).toLowerCase();
            const guess = state.prefixes.find(p => p.toLowerCase().startsWith(typed.slice(0, 4)) || (typed && p.toLowerCase().includes(typed)));
            dom.empty.append(
                el('div', { class: 'empty__title', text: `No objects under ${state.prefix}` }),
                el('p', null, 'This is not one of the configured sites.', guess ? ' Did you mean ' : '', guess ? el('button', { type: 'button', class: 'btn btn--sm', onclick: () => navigate(guess) }, guess) : '', guess ? '?' : ''),
            );
        }
        dom.empty.hidden = false;
        return;
    }
    const section = state.section;
    if (q && section) {
        const visible = [...dom.containers[section].children].filter(n => n.dataset.q && !n.hidden).length;
        if (visible === 0) {
            const label = { images: 'Images', videos: 'Videos', others: 'Other files' }[section];
            dom.empty.append(
                el('div', { class: 'empty__title', text: `Nothing in ${label} matches “${q}”` }),
                el('div', { class: 'empty__actions' }, el('button', { type: 'button', class: 'btn btn--sm', onclick: () => filter.clear() }, 'Clear filter')),
            );
            dom.empty.hidden = false;
            return;
        }
    }
    dom.empty.hidden = true;
}

// Roving tabindex: exactly one visible tile per grid is in the tab order.
function ensureRovingTile(section) {
    if (section !== 'images' && section !== 'videos') return;
    const grid = dom.containers[section];
    const opens = [...grid.querySelectorAll('.tile:not([hidden]) .tile__open')];
    if (!opens.length) return;
    if (!opens.some(o => o.tabIndex === 0)) opens[0].tabIndex = 0;
}

function visibleTiles(grid) { return [...grid.querySelectorAll('.tile:not([hidden]) .tile__open')]; }

function gridKeydown(e) {
    const grid = e.currentTarget;
    const open = e.target.closest('.tile__open');
    if (!open) return;
    const tiles = visibleTiles(grid);
    const i = tiles.indexOf(open);
    if (i < 0) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
    let next = null;
    switch (e.key) {
        case 'ArrowRight': next = tiles[i + 1]; break;
        case 'ArrowLeft': next = tiles[i - 1]; break;
        case 'ArrowDown': next = tiles[i + cols]; break;
        case 'ArrowUp': next = tiles[i - cols]; break;
        case 'Home': next = tiles[0]; break;
        case 'End': next = tiles[tiles.length - 1]; break;
        case 'c': case 'C': {
            const slug = open.closest('.tile').dataset.id;
            copyWithFeedback(open.closest('.tile').querySelector('.tile__copy'), slug, { toastOnSuccess: `Copied ${slug}` });
            e.preventDefault();
            return;
        }
        case 'Delete': case 'Backspace': {
            const entry = state.mediaIndex.get(open.closest('.tile').dataset.id);
            if (entry) deleteMedia(entry);
            e.preventDefault();
            return;
        }
        default: return;
    }
    if (!next) return;
    e.preventDefault();
    open.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- preview dialog

let previewList = [];   // slugs in display order for prev/next
let previewIndex = -1;

function openPreview(slug) {
    const entry = state.mediaIndex.get(slug);
    if (!entry) return;
    const grid = dom.containers[entry.kind === 'video' ? 'videos' : 'images'];
    previewList = visibleTiles(grid).map(o => o.closest('.tile').dataset.id);
    previewIndex = previewList.indexOf(slug);
    renderPreview(entry);
    if (!dom.preview.open) {
        openDialog(dom.preview, { initialFocus: '#preview-copy-id', onClose: () => { const v = dom.previewMedia.querySelector('video'); if (v) v.pause(); dom.previewMedia.replaceChildren(); } });
    }
}

function renderPreview(entry) {
    const { item, kind } = entry;
    const slug = item.slug;
    const files = item.files;
    const origName = files.original || '';
    const ext = extOf(origName);
    // Still image for video posters; images fall back to the full original before the 128px thumbnail.
    const stillUrl = urlFor(keyOf(files.preview || files.thumbnail || files.original));
    const previewUrl = kind === 'image' ? urlFor(keyOf(files.preview || files.original || files.thumbnail)) : stillUrl;
    const origUrl = files.original ? urlFor(keyOf(files.original)) : '';
    const copyKey = files.original || files.preview || files.thumbnail || '';
    const copyTarget = copyKey ? urlFor(keyOf(copyKey)) : '';
    const sched = scheduledFor(item);

    dom.previewTitle.textContent = slug;
    dom.previewPos.textContent = previewList.length > 1 ? `${previewIndex + 1} / ${previewList.length}` : '';

    const media = dom.previewMedia;
    media.replaceChildren(icon('loader', 'icon--lg spin'));
    let dims = el('dd', { text: '—' });
    if (kind === 'video' && PLAYABLE_VIDEO_EXTENSIONS.has(ext) && origUrl) {
        const v = el('video', { controls: true, playsinline: true, preload: 'metadata', poster: stillUrl || null, src: origUrl });
        v.addEventListener('loadedmetadata', () => { dims.textContent = `${v.videoWidth} × ${v.videoHeight}`; media.querySelector('.spin')?.remove(); });
        v.addEventListener('error', () => { media.querySelector('.spin')?.remove(); });
        media.append(v);
    } else {
        const img = el('img', { src: previewUrl || FALLBACK_IMG, alt: slug, decoding: 'async' });
        img.addEventListener('load', () => { if (img.naturalWidth) dims.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; media.querySelector('.spin')?.remove(); });
        img.addEventListener('error', () => { media.querySelector('.spin')?.remove(); });
        media.append(img);
        if (kind === 'video') media.append(el('p', { class: 'form-hint' }, `${ext || 'This'} videos cannot play in the browser here; use Open original.`));
    }

    const meta = dom.previewMeta;
    meta.replaceChildren(
        el('dt', { text: 'Dimensions' }), dims,
        el('dt', { text: 'Format' }), el('dd', { text: ext ? ext.slice(1).toUpperCase() : '—' }),
        el('dt', { text: 'Size' }), el('dd', { text: fmt.bytes(item.size) || '—' }),
        el('dt', { text: 'Modified' }), el('dd', { text: fmt.dateTime(item.last_modified) || '—' }),
        el('dt', { text: 'Key' }), el('dd', { text: keyOf(files.original || files.preview || '') }),
    );
    if (isPendingView()) {
        const refs = state.imageRefs.get(slug) || [];
        const dd = el('dd');
        if (!refs.length) dd.append(el('span', { class: 'chip chip--warn' }, 'Not in any suggestion'));
        for (const r of refs) {
            dd.append(el('a', { href: `suggestions.html?site=${encodeURIComponent(r.site)}&status=all&id=${encodeURIComponent(r.suggestion_id)}` }, r.suggestion_id),
                ` (${r.site}, ${r.status}${r.image_status && r.image_status !== 'pending' ? `, image ${r.image_status}` : ''})`, ' ');
        }
        meta.append(el('dt', { text: 'Suggestion' }), dd);
    }
    if (sched) {
        const cancel = el('button', { type: 'button', class: 'btn btn--sm', onclick: () => cancelSchedule(sched, slug) }, 'Cancel');
        meta.append(el('dt', { text: 'Scheduled' }), el('dd', null, el('span', { class: 'chip chip--warn' }, icon('clock'), `deletes ${fmt.untilLong(sched.due_at)}`), ' ', cancel));
    }

    const copyId = el('button', { type: 'button', id: 'preview-copy-id', class: 'btn btn--primary' }, icon('copy'), el('span', { class: 'btn__label', text: 'Copy ID' }));
    copyId.addEventListener('click', () => copyWithFeedback(copyId, slug));
    const copyUrl = el('button', { type: 'button', class: 'btn', title: copyTarget || undefined, disabled: !copyTarget }, icon('link'), el('span', { class: 'btn__label', text: 'Copy URL' }));
    copyUrl.addEventListener('click', () => copyWithFeedback(copyUrl, copyTarget));
    const actions = [copyId, copyUrl];
    if (origUrl) actions.push(el('a', { class: 'btn btn--ghost', href: origUrl, target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'btn__label', text: 'Open original' }), icon('ext'), srOnly('(opens in a new tab)')));
    if (files.preview) actions.push(el('a', { class: 'btn btn--ghost', href: urlFor(keyOf(files.preview)), target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'btn__label', text: 'Open preview' }), icon('ext'), srOnly('(opens in a new tab)')));
    if (previewList.length > 1) {
        actions.push(el('span', { class: 'push' }),
            el('button', { type: 'button', class: 'btn btn--icon btn--ghost', 'aria-label': 'Previous', title: 'Previous (←)', onclick: () => stepPreview(-1), disabled: previewIndex <= 0 }, icon('chevron-left')),
            el('button', { type: 'button', class: 'btn btn--icon btn--ghost', 'aria-label': 'Next', title: 'Next (→)', onclick: () => stepPreview(1), disabled: previewIndex >= previewList.length - 1 }, icon('chevron-right')));
    }
    const del = el('button', { type: 'button', class: `btn btn--danger${previewList.length > 1 ? '' : ' push'}` }, icon('trash'), el('span', { class: 'btn__label', text: 'Delete' }));
    del.addEventListener('click', () => deleteMedia(entry, { fromDialog: true }));
    actions.push(del);
    dom.previewActions.replaceChildren(...actions);

    // Warm the neighbour so ←/→ feels instant.
    const nextSlug = previewList[previewIndex + 1];
    const nextEntry = nextSlug && state.mediaIndex.get(nextSlug);
    if (nextEntry && nextEntry.item.files.preview) { const im = new Image(); im.src = urlFor(keyOf(nextEntry.item.files.preview)); }
}

function stepPreview(dir) {
    const next = previewList[previewIndex + dir];
    if (!next) return;
    const entry = state.mediaIndex.get(next);
    if (!entry) return;
    previewIndex += dir;
    const v = dom.previewMedia.querySelector('video');
    if (v) v.pause();
    // The action bar is rebuilt; keep focus on the same control (or Copy ID).
    const focused = document.activeElement;
    const focusLabel = focused && dom.previewActions.contains(focused) ? focused.getAttribute('aria-label') : null;
    renderPreview(entry);
    const again = (focusLabel && dom.previewActions.querySelector(`[aria-label="${CSS.escape(focusLabel)}"]:not([disabled])`)) || dom.previewActions.querySelector('#preview-copy-id');
    if (again) again.focus();
    const t = tileNode(next);
    if (t) { const o = t.querySelector('.tile__open'); const grid = t.parentElement; visibleTiles(grid).forEach(x => { x.tabIndex = -1; }); o.tabIndex = 0; }
}

// ---------------------------------------------------------------- actions

async function deleteMedia(entry, { fromDialog = false } = {}) {
    const { item, kind } = entry;
    const keysToDelete = mediaKeys(item);
    const { confirmed, delaySeconds } = await confirmDialog({
        title: `Delete ${item.slug}`,
        message: `Delete this ${kind} and its ${keysToDelete.length} file${keysToDelete.length === 1 ? '' : 's'} (original, preview, thumbnail)?`,
        confirmText: 'Delete now',
        delay: { default: 0 },
    });
    if (!confirmed) return;
    if (fromDialog && dom.preview.open) dom.preview.close();
    if (delaySeconds > 0) {
        await scheduleDelete(keysToDelete, delaySeconds, item.slug, () => rerenderMediaNode(item.slug));
        return;
    }
    const node = tileNode(item.slug);
    if (node) node.classList.add('is-removing');
    try {
        const data = await apiJson('content/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: keysToDelete }) });
        const errors = data.errors || [];
        if (errors.length && errors.length === keysToDelete.length) throw new ApiError(500, errors.map(e => `${e.key}: ${e.message || e.code}`).join('; '));
        removeMedia(item.slug, kind);
        if (errors.length) {
            toast(`Deleted ${item.slug}, but ${errors.length} file(s) could not be removed`, { tone: 'error', details: errors.map(e => `${e.key}: ${e.message || e.code}`).join('\n') });
            load({ silent: true });   // whatever survived reappears where the listing puts it
        } else toast(`Deleted ${item.slug}`, { tone: 'success' });
    } catch (err) {
        if (node) node.classList.remove('is-removing');
        if (!(err instanceof ApiError && err.status === 401)) toast(`Delete failed: ${err.detail || err.message}`, { tone: 'error' });
    }
}

function removeMedia(slug, kind) {
    const list = kind === 'video' ? state.videos : state.images;
    const i = list.findIndex(x => x.slug === slug);
    if (i >= 0) list.splice(i, 1);
    state.mediaIndex.delete(slug);
    const node = tileNode(slug);
    if (node) {
        const wasFocused = node.contains(document.activeElement);
        const grid = node.parentElement;
        const tiles = visibleTiles(grid);
        const idx = tiles.findIndex(o => o.closest('.tile') === node);
        node.remove();
        if (wasFocused) { const next = tiles[idx + 1] || tiles[idx - 1]; if (next) { next.tabIndex = 0; next.focus(); } }
    }
    applyFilter();
    ensureVisibleSection();
    renderEmptyState();
}

async function deleteOther(item) {
    const data = isDataFile(item.filename);
    const message = data
        ? [`${state.prefix}${item.filename} feeds the ${siteOf(state.prefix)} site. It will have no data until the next update from the sheet.`, `Delete ${item.filename}?`]
        : `Delete ${item.filename}?`;
    const { confirmed, delaySeconds } = await confirmDialog({
        title: `Delete ${item.filename}`, message, confirmText: 'Delete now', delay: { default: data ? 3600 : 0 },
    });
    if (!confirmed) return;
    if (delaySeconds > 0) {
        await scheduleDelete([item.key], delaySeconds, item.filename, () => rerenderOtherNode(item));
        return;
    }
    const node = data ? dataRowNode(item.filename) : rowNode(item.key);
    if (node) node.classList.add('is-removing');
    try {
        await apiJson(`content?key=${encodeURIComponent(item.key)}`, { method: 'DELETE' });
        removeOther(item);
        toast(`Deleted ${item.filename}`, { tone: 'success' });
    } catch (err) {
        if (node) node.classList.remove('is-removing');
        if (!(err instanceof ApiError && err.status === 401)) toast(`Delete failed: ${err.detail || err.message}`, { tone: 'error' });
    }
}

function removeOther(item) {
    const i = state.others.findIndex(o => o.key === item.key);
    if (i >= 0) state.others.splice(i, 1);
    if (isDataFile(item.filename)) {
        const node = dataRowNode(item.filename);
        if (node) refreshNode(node, () => makeDataRow(state.csvSources.get(item.filename), null));
    } else {
        const node = rowNode(item.key);
        if (node) node.remove();
    }
    applyFilter();
    ensureVisibleSection();
    renderEmptyState();
}

async function scheduleDelete(keysToDelete, delaySeconds, label, rerender) {
    try {
        const data = await apiJson('content/schedule-delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: keysToDelete, delay_seconds: delaySeconds, label, prefix: state.prefix }),
        });
        const rec = { id: data.id, prefix: state.prefix, label, keys: keysToDelete, due_at: data.due_at };
        for (const k of keysToDelete) state.scheduledByKey.set(k, rec);
        rerender();
        toast(`${label} will be deleted ${fmt.untilLong(data.due_at)} (${fmt.dateTime(data.due_at)})`, { tone: 'success', duration: 6000 });
    } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) toast(`Could not schedule: ${err.detail || err.message}`, { tone: 'error' });
    }
}

async function cancelSchedule(rec, label) {
    const { confirmed } = await confirmDialog({
        title: 'Keep this file?',
        message: `Cancel the scheduled deletion of ${label}? It is due ${fmt.dateTime(rec.due_at)}.`,
        confirmText: 'Keep file', cancelText: 'Back', tone: 'neutral',
    });
    if (!confirmed) return;
    try {
        await apiJson(`scheduled-deletes/${encodeURIComponent(rec.id)}`, { method: 'DELETE' });
        for (const k of rec.keys || []) state.scheduledByKey.delete(k);
        // Every item this record covered gets redrawn.
        for (const [slug, entry] of state.mediaIndex) if (mediaKeys(entry.item).some(k => (rec.keys || []).includes(k))) rerenderMediaNode(slug);
        for (const o of state.others) if ((rec.keys || []).includes(o.key)) rerenderOtherNode(o);
        if (dom.preview.open) { const e = state.mediaIndex.get(dom.previewTitle.textContent); if (e) renderPreview(e); }
        toast(`Cancelled scheduled deletion of ${label}`, { tone: 'success' });
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
            toast('That deletion had already run or been cancelled.', { tone: 'error' });
            load({ silent: true });
        } else if (!(err instanceof ApiError && err.status === 401)) toast(`Cancel failed: ${err.detail || err.message}`, { tone: 'error' });
    }
}

let replaceTarget = null;

async function startReplace(item) {
    if (isDataFile(item.filename)) {
        const src = state.csvSources.get(item.filename);
        const { confirmed } = await confirmDialog({
            title: 'Replace a synced file',
            message: `${item.filename} is synced from Google Sheets: the next update (manual or scheduled) will overwrite what you upload. To change the data permanently, edit the sheet and press Update from spreadsheet.`,
            confirmText: 'Replace anyway', tone: 'neutral',
            extra: src && src.sheet_url ? [{ label: 'Open sheet', href: src.sheet_url }] : [],
        });
        if (!confirmed) return;
    }
    replaceTarget = item;
    dom.replaceInput.accept = extOf(item.filename) || '';
    dom.replaceInput.value = '';
    dom.replaceInput.click();
}

async function onReplaceChosen() {
    const file = dom.replaceInput.files[0];
    const target = replaceTarget;
    replaceTarget = null;
    dom.replaceInput.value = '';
    if (!file || !target) return;
    const problem = replaceProblem(target.filename, file);
    if (problem) { toast(problem, { tone: 'error' }); return; }
    const { confirmed } = await confirmDialog({
        title: `Replace ${target.filename}`,
        message: `Replace ${target.filename} (${fmt.bytes(target.size)}) with ${file.name} (${fmt.bytes(file.size)})?`,
        confirmText: 'Replace', tone: 'neutral',
    });
    if (!confirmed) return;
    uploader.add([file], { overrideFilename: target.filename });
}

// Called by the uploader as each file finishes; patches the listing in place.
function onUploaded(it) {
    if (it.prefix !== state.prefix) return;
    const r = it.result || {};
    const now = new Date().toISOString();
    if (r.type === 'image' || r.type === 'video') {
        const rel = (k) => (k && k.startsWith(it.prefix) ? k.slice(it.prefix.length) : k);
        const item = { slug: r.slug, files: { original: rel(r.original), preview: rel(r.preview), thumbnail: rel(r.thumbnail) }, size: it.size, last_modified: now, type: r.type };
        const list = r.type === 'video' ? state.videos : state.images;
        list.unshift(item);
        state.mediaIndex.set(item.slug, { item, kind: r.type });
        const tile = makeTile(item, r.type);
        tile.classList.add('is-new');
        const grid = dom.containers[r.type === 'video' ? 'videos' : 'images'];
        grid.prepend(tile);
        const counts = applyFilter();
        ensureVisibleSection();
        renderEmptyState();
        if (tile.hidden) toast(`${it.name} uploaded as ${r.slug}, hidden by the current filter`, { actions: [{ label: 'Clear filter', onClick: () => filter.clear() }] });
        else if (state.section !== (r.type === 'video' ? 'videos' : 'images') && counts) {
            const sec = r.type === 'video' ? 'videos' : 'images';
            toast(`${it.name} uploaded as ${r.slug}`, { tone: 'success', actions: [{ label: `Show ${sec}`, onClick: () => selectSection(sec) }] });
        }
    } else if (r.key) {
        const filename = r.key.startsWith(it.prefix) ? r.key.slice(it.prefix.length) : r.key.split('/').pop();
        const existing = state.others.find(o => o.key === r.key);
        const item = { key: r.key, filename, size: it.size, last_modified: now };
        if (existing) Object.assign(existing, item); else state.others.unshift(item);
        // Anything cached for the old bytes is stale now.
        for (const ck of [...state.previewCache.keys()]) if (ck.startsWith(r.key + '|')) state.previewCache.delete(ck);
        if (isDataFile(filename)) {
            const node = dataRowNode(filename);
            const fresh = node ? refreshNode(node, () => makeDataRow(state.csvSources.get(filename), existing || item)) : null;
            if (fresh) fresh.classList.add('is-new');
            stampRow(filename, fetchPreview(r.key, { force: true }));
        } else {
            const node = existing ? rowNode(r.key) : null;
            const fresh = node ? refreshNode(node, () => makeRow(existing)) : makeRow(item);
            if (!node) dom.containers.others.prepend(fresh);
            fresh.classList.add('is-new');
        }
        viewer.refreshIfOpen(filename);
        applyFilter();
        ensureVisibleSection();
        renderEmptyState();
    }
}

// ---- spreadsheet sync

async function syncFromSheet(extraBusyBtn = null) {
    if (!state.csvSources.size) return;
    const sources = [...state.csvSources.values()];
    // The manual sync has none of the scheduled run's safety checks, so it keeps a deliberate step.
    const { confirmed } = await confirmDialog({
        title: 'Update from spreadsheet',
        message: `Re-download ${sources.map(s => s.file).join(', ')} from Google Sheets and overwrite the copies in ${state.prefix}?`,
        confirmText: 'Update', tone: 'neutral',
    });
    if (!confirmed) return;
    const before = new Map();
    for (const s of sources) {
        const other = otherByName(s.file);
        const p = other && state.latestPreview.get(other.key);
        before.set(s.file, p ? { etag: p.etag, rows: p.total_rows } : null);
    }
    setBusy(dom.syncBtn, true, 'Updating…');
    if (extraBusyBtn) setBusy(extraBusyBtn, true, 'Updating…');
    dom.dataPanel.setAttribute('aria-busy', 'true');
    showSyncResult('info', [el('div', { class: 'notice__line' }, `Downloading ${fmt.plural(sources.length, 'sheet')}…`)]);
    try {
        const data = await apiJson(`content/sync-csv?prefix=${encodeURIComponent(state.prefix)}`, { method: 'POST' });
        const updated = data.updated || [];
        const errors = data.errors || [];
        // Fresh listing (new size/last_modified) so row metadata and cache keys move on.
        await load({ silent: true });
        const lines = [];
        let changed = 0;
        for (const s of sources) {
            const err = errors.find(e => e.file === s.file);
            if (err) {
                lines.push(el('div', { class: 'notice__line text-danger' }, icon('alert'), el('strong', { class: 'mono', text: s.file }), ` failed: ${err.error}`,
                    s.sheet_url ? el('a', { class: 'btn btn--sm btn--ghost', href: s.sheet_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sheet', icon('ext')) : null));
                continue;
            }
            if (!updated.includes(s.file)) continue;
            const other = otherByName(s.file);
            let after = null;
            if (other) { try { after = await fetchPreview(other.key, { force: true }); applyPreviewToRow(s.file, after); } catch { after = null; } }
            const prev = before.get(s.file);
            const line = el('div', { class: 'notice__line' }, el('strong', { class: 'mono', text: s.file }));
            if (after && prev && prev.etag && prev.etag === after.etag) {
                line.append(' unchanged (same content as before)');
            } else if (after && after.kind === 'table') {
                changed++;
                const rowsAfter = after.total_rows;
                if (prev && prev.rows != null) {
                    const d = rowsAfter - prev.rows;
                    const shrink = prev.rows > 0 && rowsAfter < prev.rows * 0.5;
                    line.append(` ${fmt.int(prev.rows)} → ${fmt.int(rowsAfter)} rows (${d >= 0 ? '+' : ''}${fmt.int(d)})`);
                    if (shrink) { line.classList.add('text-danger'); line.append(' — that is a big drop; check the sheet'); }
                } else line.append(` now ${fmt.int(rowsAfter)} rows`);
                line.append(el('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: () => viewer.open(s.file, { end: true, restoreTo: dom.syncBtn }) }, 'View last rows'));
                if (s.sheet_url) line.append(el('a', { class: 'btn btn--sm btn--ghost', href: s.sheet_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sheet', icon('ext')));
                markUpdated(s.file);
                viewer.refreshIfOpen(s.file);
            } else if (after) {
                changed++;
                line.append(` updated (${fmt.bytes(after.size)})`);
                markUpdated(s.file);
                viewer.refreshIfOpen(s.file);
            } else {
                line.append(' updated');
                markUpdated(s.file);
            }
            lines.push(line);
        }
        const tone = errors.length ? (updated.length ? 'warn' : 'danger') : 'success';
        lines.unshift(el('div', { class: 'notice__line' }, el('strong', null, `${errors.length ? 'Partly updated' : 'Updated'} at ${fmt.time(new Date().toISOString())}`), errors.length ? ` — ${errors.length} failed` : changed ? ` — ${fmt.plural(changed, 'file')} changed` : ' — nothing changed'));
        showSyncResult(tone, lines);
        toast(errors.length ? `Updated ${updated.length}, ${errors.length} failed` : `Updated ${updated.join(', ') || 'nothing'}`, { tone: errors.length ? 'error' : 'success' });
    } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
            showSyncResult('danger', [el('div', { class: 'notice__line' }, icon('alert'), `Update failed: ${err.detail || err.message}`, el('button', { type: 'button', class: 'btn btn--sm', onclick: () => syncFromSheet() }, 'Retry'))]);
            toast(`Update failed: ${err.detail || err.message}`, { tone: 'error' });
        } else dom.syncResult.hidden = true;
    } finally {
        setBusy(dom.syncBtn, false);
        if (extraBusyBtn) setBusy(extraBusyBtn, false);
        dom.dataPanel.removeAttribute('aria-busy');
    }
}

function markUpdated(name) {
    const node = dataRowNode(name);
    if (!node) return;
    node.classList.add('is-highlight');
    const meta = node.querySelector('.row__meta');
    if (meta && !meta.querySelector('.chip--success')) meta.append(el('span', { class: 'chip chip--success' }, icon('check'), 'Updated'));
}

function showSyncResult(tone, lines) {
    const box = dom.syncResult;
    box.className = `notice notice--${tone}`;
    box.replaceChildren(
        icon(tone === 'success' ? 'check-circle' : tone === 'info' ? 'info' : 'alert'),
        el('div', { class: 'notice__body' }, lines),
        el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--ghost notice__close', 'aria-label': 'Dismiss', onclick: () => { box.hidden = true; } }, icon('x')),
    );
    box.hidden = false;
}

// ---------------------------------------------------------------- events

function wireEvents() {
    // Tiles: open / copy.
    for (const name of ['images', 'videos']) {
        const grid = dom.containers[name];
        grid.addEventListener('click', (e) => {
            const tile = e.target.closest('.tile');
            if (!tile) return;
            if (e.target.closest('.tile__copy')) { copyWithFeedback(e.target.closest('.tile__copy'), tile.dataset.id); return; }
            if (e.target.closest('.tile__open')) openPreview(tile.dataset.id);
        });
        grid.addEventListener('keydown', gridKeydown);
        grid.addEventListener('focusin', (e) => {
            const open = e.target.closest('.tile__open');
            if (!open) return;
            visibleTiles(grid).forEach(o => { if (o !== open) o.tabIndex = -1; });
            open.tabIndex = 0;
        });
    }

    // Other rows.
    dom.containers.others.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const row = btn.closest('.row');
        const item = state.others.find(o => o.key === row.dataset.id);
        if (!item) return;
        rowAction(btn.dataset.action, item, btn);
    });

    // Data rows.
    dom.dataRows.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const row = btn.closest('.row');
        const item = otherByName(row.dataset.id);
        if (!item) return;
        rowAction(btn.dataset.action, item, btn);
    });

    dom.syncBtn.addEventListener('click', () => syncFromSheet());
    dom.dataToggle.addEventListener('click', () => { const open = dom.dataBody.hidden; setDataOpen(open); store.set(DATA_OPEN_KEY, open); });

    // Section tabs.
    const tablist = dom.sectionbar.querySelector('[role=tablist]');
    tablist.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) selectSection(t.dataset.section); });
    tablist.addEventListener('keydown', (e) => {
        const tabs = Object.values(dom.tabs).filter(t => !t.hidden);
        const i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        let next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        selectSection(next.dataset.section);
        next.focus();
    });
    ['images', 'videos', 'others'].forEach((name, i) => keys.on(String(i + 1), () => { if (viewer.isOpen() || dom.tabs[name].hidden) return false; selectSection(name); }));
    dom.filterChip.addEventListener('click', () => filter.clear());

    // Uploads: button, key, file input, replace input, drag anywhere, paste.
    const pickFiles = () => { if (isPendingView()) { toast(NO_UPLOAD_HERE); return; } dom.fileInput.click(); };
    dom.uploadBtn.addEventListener('click', pickFiles);
    keys.on('u', () => { if (viewer.isOpen()) return false; pickFiles(); });
    dom.fileInput.addEventListener('change', () => { if (dom.fileInput.files.length) uploader.add([...dom.fileInput.files]); dom.fileInput.value = ''; });
    dom.replaceInput.addEventListener('change', onReplaceChosen);

    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        dom.dropText.textContent = viewer.isOpen() ? 'Close the viewer to upload' : isPendingView() ? 'Uploads go to a site, not the pending area' : `Drop to upload to ${state.prefix}`;
        dom.dropOverlay.hidden = false;
    });
    document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = viewer.isOpen() || isPendingView() ? 'none' : 'copy'; });
    document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dom.dropOverlay.hidden = true; });
    document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        dom.dropOverlay.hidden = true;
        if (viewer.isOpen()) { toast('Close the viewer first, then drop files to upload.'); return; }
        if (isPendingView()) { toast(NO_UPLOAD_HERE); return; }
        if (e.dataTransfer.files.length) uploader.add([...e.dataTransfer.files]);
    });
    document.addEventListener('paste', (e) => {
        if (isTypingTarget(e.target) || viewer.isOpen() || isPendingView() || topDialog()) return;
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length) { e.preventDefault(); uploader.add([...files]); }
    });

    // Preview dialog keys (only while it is the topmost dialog).
    const inPreview = () => topDialog() === dom.preview;
    keys.on('ArrowLeft', () => stepPreview(-1), { allowInDialog: true, when: inPreview });
    keys.on('ArrowRight', () => stepPreview(1), { allowInDialog: true, when: inPreview });
    keys.on('c', () => { const b = dom.previewActions.querySelector('#preview-copy-id'); if (b) b.click(); }, { allowInDialog: true, when: inPreview });
    keys.on('Delete', () => { const e = state.mediaIndex.get(dom.previewTitle.textContent); if (e) deleteMedia(e, { fromDialog: true }); }, { allowInDialog: true, when: inPreview });

    // Re-evaluate the collapsible data panel when crossing the phone breakpoint.
    matchMedia('(max-width: 640px)').addEventListener('change', () => { if (state.csvSources.size) renderDataPanel(); });
}

function rowAction(action, item, btn) {
    switch (action) {
        case 'view': viewer.open(item.filename, { restoreTo: btn }); break;
        case 'replace': startReplace(item); break;
        case 'delete': deleteOther(item); break;
        case 'cancel-sched': { const rec = scheduledFor(item); if (rec) cancelSchedule(rec, item.filename); break; }
        case 'menu': openMenu(btn, [
            { label: 'Replace…', icon: 'swap', onSelect: () => startReplace(item) },
            'sep',
            { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => deleteOther(item) },
        ]); break;
        default: break;
    }
}

const SHORTCUTS = [
    { title: 'Files', items: [
        { keys: ['/'], label: 'Filter files' }, { keys: ['u'], label: 'Upload files' }, { keys: ['r'], label: 'Refresh' },
        { keys: ['[', ']'], label: 'Previous / next site' }, { keys: ['1', '2', '3'], label: 'Images / Videos / Other' }, { keys: ['?'], label: 'This sheet' },
    ] },
    { title: 'Tiles (when focused)', items: [
        { keys: ['←', '→', '↑', '↓'], label: 'Move between tiles' }, { keys: ['Enter'], label: 'Open preview' }, { keys: ['c'], label: 'Copy ID' }, { keys: ['Del'], label: 'Delete…' },
    ] },
    { title: 'Preview', items: [
        { keys: ['←', '→'], label: 'Previous / next' }, { keys: ['c'], label: 'Copy ID' }, { keys: ['Del'], label: 'Delete…' }, { keys: ['Esc'], label: 'Close' },
    ] },
    { title: 'Viewer', items: [
        { keys: ['/'], label: 'Find in rows' }, { keys: ['w'], label: 'Wrap cells' }, { keys: ['End', 'Home'], label: 'Last / first row' }, { keys: ['Esc'], label: 'Clear find, then close' },
    ] },
];

// ---------------------------------------------------------------- boot

async function boot() {
    mountShell();
    installImageFallback(document);
    startTicker();

    viewer = createViewer({
        root: dom.viewer,
        contentEl: dom.content,
        getPrefix: () => state.prefix,
        getFileInfo: (filename) => {
            const other = otherByName(filename);
            const src = state.csvSources.get(filename);
            return {
                key: other ? other.key : keyOf(filename),
                size: other ? other.size : null,
                last_modified: other ? other.last_modified : null,
                sheet_url: src ? src.sheet_url : null,
                isDataFile: !!src,
                publicUrl: other ? urlFor(other.key) : '',
            };
        },
        fetchPreview,
        onSync: (_filename, btn) => syncFromSheet(btn),
        onClosed: () => updateTitle(),
    });

    uploader = createUploader({
        getPrefix: () => state.prefix,
        thumbUrl: (prefix, r) => urlFor(r.thumbnail),
        onDone: onUploaded,
        onDrained: () => load({ silent: true }),
    });

    refresh = initRefresh(() => { if (viewer.isOpen()) viewer.refreshIfOpen(viewer.currentFile()); else load({ silent: true }); });
    filter = initFilter({
        enabled: () => !viewer.isOpen(),
        onChange: (q) => { state.q = q; if (state.loaded) { applyFilter(); ensureVisibleSection(); renderEmptyState(); } },
    });
    state.q = filter.get();
    initHelp(SHORTCUTS);
    bindPresetKeys({ getItems: () => state.prefixes.map(p => ({ id: p })), getCurrentId: () => state.prefix, onSelect: (id) => navigate(id) });
    initPathPopover({ button: dom.pathBtn, getCurrent: () => state.prefix, onSubmit: (p) => navigate(p) });
    wireEvents();
    renderSwitcherNow();

    if (!getApiKey()) {
        try { await requireLogin(); } catch { return; }
    }
    load();
    refreshPendingBadge();
    watchPendingBadge();
}

boot();
