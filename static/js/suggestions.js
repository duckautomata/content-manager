// Suggestions review page: site switcher (from suggestion counts), status
// chips, one card per suggestion with approve / reject / complete / edit /
// summary / feedback / delete, image tiles with a preview dialog, and the
// shared shell (pending badge, refresh, shortcuts).

import {
    el, icon, apiJson, apiFetch, ApiError, fmt, timeEl, keys, setUrlState, urlParams, srOnly,
    installImageFallback, startTicker, getApiKey, requireLogin, publicUrl, escapeHtml, FALLBACK_IMG,
} from './common.js';
import { mountShell, openDialog, topDialog, confirmDialog, openTextDialog, toast, copyWithFeedback, setBusy } from './ui.js';
import {
    applyPendingBadge, refreshPendingBadge, watchPendingBadge, setNavLinks, initRefresh, initHelp,
    renderSwitcher, bindPresetKeys,
} from './shell.js';

const STATUSES = [
    ['pending', 'Pending', 'chip--pending'],
    ['approved', 'Approved', 'chip--success'],
    ['completed', 'Completed', 'chip--info'],
    ['rejected', 'Rejected', 'chip--danger'],
    ['', 'All', 'chip--accent'],
];
const VALID_STATUS = new Set(STATUSES.map(s => s[0]));
const KIND = {
    new: { label: 'Add entry', cls: 'chip--success' },
    edit: { label: 'Edit entry', cls: 'chip--info' },
    delete: { label: 'Delete entry', cls: 'chip--danger' },
};
const EMPTY_COUNTS = { pending: 0, approved: 0, rejected: 0, completed: 0 };

function statusFromUrl() {
    const s = urlParams().get('status');
    if (s === null) return 'pending';
    if (s === 'all') return '';
    return VALID_STATUS.has(s) ? s : 'pending';
}

const state = {
    site: urlParams().get('site') || null,
    status: statusFromUrl(),
    focusId: urlParams().get('id') || null,
    counts: {},
    suggestions: [],
    total: 0,
    truncated: false,
    publicUrlPrefix: '',
    pendingPrefix: '_suggestions/_pending/',
    seq: 0,
    flashed: false,   // the ?id= card is scrolled to and flashed once per navigation, not on every reload
};

const $ = (id) => document.getElementById(id);
const dom = {
    main: $('main'), switcher: $('site-switcher'), statusrow: $('statusrow'), cards: $('cards'),
    empty: $('content-empty'), error: $('content-error'),
    preview: $('preview'), previewTitle: $('preview-title'), previewPos: $('preview-pos'),
    previewMedia: $('preview-media'), previewMeta: $('preview-meta'), previewActions: $('preview-actions'),
};
let refresh;

// ---------------------------------------------------------------- data

async function loadConfig() {
    try {
        const res = await fetch(`${new URL('.', location.href).pathname}api/public/config`, { cache: 'no-store' });
        if (!res.ok) return;
        const cfg = await res.json();
        state.publicUrlPrefix = cfg.public_url_prefix || '';
        state.pendingPrefix = cfg.pending_prefix || state.pendingPrefix;
        const link = document.getElementById('pending-link');
        if (link) link.href = `index.html?prefix=${encodeURIComponent(state.pendingPrefix)}`;
    } catch { /* image URLs will just be empty */ }
}

function siteCounts(site) { return state.counts[site] || EMPTY_COUNTS; }
function totalCount(c) { return c.pending + c.approved + c.completed + c.rejected; }

async function load({ silent = false } = {}) {
    const mySeq = ++state.seq;
    refresh.setBusy(true);
    dom.main.setAttribute('aria-busy', 'true');
    dom.error.hidden = true;
    if (!silent || !dom.cards.children.length) renderSkeletons(); else dom.cards.classList.add('is-loading');
    try {
        const counts = await apiJson('suggestions/counts');
        if (mySeq !== state.seq) return;
        state.counts = counts;
        applyPendingBadge(counts);
        const sites = Object.keys(counts);
        if (state.focusId && (!state.site || !sites.includes(state.site))) {
            // Deep links (the Discord notification) may carry only the id: look the
            // suggestion up so the page opens on its site and status.
            try {
                const s = await apiJson(`suggestions/${encodeURIComponent(state.focusId)}`);
                if (mySeq !== state.seq) return;
                if (s && sites.includes(s.site)) state.site = s.site;
                if (s && s.status && urlParams().get('status') === null) state.status = s.status;
            } catch { /* gone: reported after render */ }
        }
        if (!state.site || !sites.includes(state.site)) {
            state.site = sites.find(s => counts[s].pending > 0) || sites[0] || null;
        }
        renderSwitcherNow();
        state.truncated = false;   // the note is rebuilt from the fresh list below
        renderStatusRow();
        if (state.site) {
            const url = new URL(`${new URL('.', location.href).pathname}api/suggestions`, location.origin);
            url.searchParams.set('site', state.site);
            if (state.status) url.searchParams.set('status', state.status);
            const data = await apiJson(url.pathname + url.search);
            if (mySeq !== state.seq) return;
            state.suggestions = data.suggestions || [];
            state.total = data.total ?? state.suggestions.length;
            state.truncated = !!data.truncated;
        } else {
            state.suggestions = [];
            state.total = 0;
            state.truncated = false;
        }
        renderCards();
        updateUrl();
        refresh.markRefreshed();
    } catch (err) {
        if (mySeq !== state.seq) return;
        dom.cards.replaceChildren();
        dom.empty.hidden = true;
        dom.error.replaceChildren(icon('alert'), el('div', { class: 'notice__body' },
            el('div', null, el('strong', { text: 'Could not load suggestions' }), ` — ${err.detail || err.message}`),
            el('div', { class: 'notice__line' }, el('button', { type: 'button', class: 'btn btn--sm', onclick: () => load() }, icon('refresh'), 'Retry'))));
        dom.error.hidden = false;
    } finally {
        if (mySeq === state.seq) {
            refresh.setBusy(false);
            dom.main.removeAttribute('aria-busy');
            dom.cards.classList.remove('is-loading');
        }
    }
}

function updateUrl() {
    setUrlState({ site: state.site, status: state.status || 'all', id: state.focusId });
}

// ---------------------------------------------------------------- render

function renderSkeletons() {
    dom.empty.hidden = true;
    dom.cards.replaceChildren(...Array.from({ length: 3 }, () => el('div', { class: 'card', 'aria-hidden': 'true' },
        el('div', { class: 'skeleton skeleton--line', style: { width: '40%' } }),
        el('div', { class: 'skeleton skeleton--line', style: { width: '70%' } }),
        el('div', { class: 'skeleton', style: { height: '80px' } }),
    )));
}

function renderSwitcherNow() {
    const sites = Object.keys(state.counts);
    const items = sites.map(s => {
        const c = siteCounts(s);
        return {
            id: s, label: s, href: `?site=${encodeURIComponent(s)}`,
            badge: c.pending, badgeClass: c.pending ? 'chip--pending' : '', badgeLabel: `${c.pending} pending`,
            title: `${c.pending} pending · ${c.approved} approved · ${c.completed} completed · ${c.rejected} rejected`,
        };
    });
    renderSwitcher(dom.switcher, {
        items, currentId: state.site,
        onSelect: (id) => { if (id === state.site) { load({ silent: true }); return; } state.site = id; state.focusId = null; setUrlState({ site: id }, { push: true }); load(); },
    });
    if (!sites.length) dom.switcher.append(el('span', { class: 'muted', text: 'No sites configured.' }));
    setNavLinks({ prefix: state.site ? `${state.site}/` : null });
}

function renderStatusRow() {
    // Rebuilding the row would drop keyboard focus; put it back on the pressed chip.
    const hadFocus = dom.statusrow.contains(document.activeElement);
    dom.statusrow.replaceChildren();
    if (!state.site) return;
    const c = siteCounts(state.site);
    for (const [value, label, cls] of STATUSES) {
        const n = value ? (c[value] || 0) : totalCount(c);
        const active = value === state.status;
        // Only the pressed chip carries its status colour, so the active filter stands out.
        dom.statusrow.append(el('button', {
            type: 'button', class: `chip chip--lg${active ? ' ' + cls : ''}`, 'aria-pressed': active ? 'true' : 'false',
            onclick: () => { if (state.status === value) return; state.status = value; state.focusId = null; renderStatusRow(); load({ silent: true }); },
        }, `${label} `, el('span', { class: 'num', text: String(n) }), srOnly(` ${label.toLowerCase()} suggestions`)));
    }
    if (state.truncated) dom.statusrow.append(el('span', { class: 'muted push', role: 'status', text: `Showing the newest ${state.suggestions.length} of ${state.total}` }));
    if (hadFocus) { const pressed = dom.statusrow.querySelector('[aria-pressed="true"]'); if (pressed) pressed.focus({ preventScroll: true }); }
}

function renderCards() {
    dom.cards.replaceChildren();
    renderStatusRow();   // counts and the truncation note reflect the list just loaded
    if (!state.suggestions.length) {
        const label = (STATUSES.find(s => s[0] === state.status) || ['', ''])[1].toLowerCase();
        dom.empty.replaceChildren(el('div', { class: 'empty__title', text: state.status ? `No ${label} suggestions for ${state.site || 'this site'}.` : `No suggestions for ${state.site || 'this site'} yet.` }));
        dom.empty.hidden = false;
        return;
    }
    dom.empty.hidden = true;
    const frag = document.createDocumentFragment();
    for (const s of state.suggestions) frag.append(renderCard(s));
    dom.cards.append(frag);
    if (state.focusId && !state.flashed) {
        const target = dom.cards.querySelector(`[data-id="${CSS.escape(state.focusId)}"]`);
        if (target) {
            state.flashed = true;
            target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
            target.classList.add('is-flash');
            setTimeout(() => target.classList.remove('is-flash'), 3000);
        } else {
            toast(`Suggestion ${state.focusId} is not in this view. It may have been deleted or sits under another filter.`, { tone: 'error' });
            state.focusId = null;
        }
    }
}

function renderCard(s) {
    const card = el('article', { class: `card card--${s.status}`, dataset: { id: s.id }, 'aria-labelledby': `sg-${s.id}` });
    const kind = KIND[s.kind] || { label: s.kind, cls: '' };
    const idChip = el('button', { type: 'button', class: 'id-chip', 'aria-label': `Copy id ${s.id}`, title: 'Copy id' }, el('code', { text: s.id }), icon('copy'));
    idChip.addEventListener('click', () => copyWithFeedback(idChip, s.id));

    const head = el('div', { class: 'card__head' },
        el('h2', { class: 'card__title', id: `sg-${s.id}` }, idChip, el('span', { class: `chip ${kind.cls}`, text: kind.label }),
            !state.status ? el('span', { class: `chip ${(STATUSES.find(x => x[0] === s.status) || [])[2] || ''}`, text: s.status }) : null),
        el('span', { class: 'card__time' }, 'submitted ', timeEl(s.submitted_at)),
    );
    const actions = el('div', { class: 'card__actions' });
    if (s.status === 'pending') {
        actions.append(
            el('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'approve' } }, icon('check'), 'Approve'),
            el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'reject' } }, 'Reject'),
            el('button', { type: 'button', class: 'btn btn--sm', dataset: { action: 'edit' } }, 'Edit payload'),
        );
    }
    if (s.status === 'approved') actions.append(el('button', { type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'complete' } }, icon('check-circle'), 'Mark completed'));
    actions.append(
        el('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { action: 'summary' } }, 'Summary'),
        el('button', { type: 'button', class: 'btn btn--sm btn--ghost', dataset: { action: 'feedback' } }, 'Feedback'),
        el('button', { type: 'button', class: 'btn btn--sm btn--danger', dataset: { action: 'delete' }, 'aria-label': `Delete suggestion ${s.id}` }, icon('trash'), 'Delete'),
    );
    head.append(actions);
    card.append(head);

    const body = el('div', { class: 'card__body' });
    if (s.summary) body.append(el('div', { class: 'card__label', text: 'Summary' }), el('div', { class: 'card__value', text: s.summary }));
    if (s.admin_context) body.append(el('div', { class: 'card__label', text: 'Feedback' }), el('div', { class: 'card__value card__feedback', text: s.admin_context }));

    const payload = s.payload || {};
    const kv = renderKv(payload);
    const raw = el('pre', { class: 'raw-json', hidden: true });
    raw.innerHTML = escapeHtml(JSON.stringify(payload, null, 2));
    const rawBtn = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-pressed': 'false' }, 'Raw JSON');
    rawBtn.addEventListener('click', () => { const show = raw.hidden; raw.hidden = !show; kv.hidden = show; rawBtn.setAttribute('aria-pressed', show ? 'true' : 'false'); });
    body.append(el('div', { class: 'card__label' }, 'Payload'), el('div', { class: 'card__value' }, el('div', { class: 'card__imgtools' }, el('span', { class: 'muted', text: `${Object.keys(payload).length} fields` }), rawBtn), kv, raw));

    const images = s.images || [];
    if (images.length) {
        const tools = el('div', { class: 'card__imgtools' }, el('span', { class: 'muted', text: fmt.plural(images.length, 'image') }));
        if (images.length > 1) {
            const dl = el('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, icon('download'), el('span', { class: 'btn__label', text: 'Download all' }));
            dl.addEventListener('click', () => downloadAll(s, dl));
            tools.append(dl);
        }
        const grid = el('div', { class: 'card__images' });
        for (const img of images) grid.append(renderImageTile(s, img));
        body.append(el('div', { class: 'card__label', text: 'Images' }), el('div', { class: 'card__value' }, tools, grid));
    }
    card.append(body);

    actions.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (btn) cardAction(btn.dataset.action, s, btn);
    });
    return card;
}

function renderKv(payload) {
    const dl = el('dl', { class: 'kv' });
    const entries = Object.entries(payload);
    if (!entries.length) dl.append(el('dt', { text: '—' }), el('dd', { text: 'empty payload' }));
    for (const [k, v] of entries) {
        const dd = el('dd');
        if (v == null || v === '') dd.append(el('span', { class: 'muted', text: '—' }));
        else if (typeof v === 'string') {
            // Visitor-supplied: link only plain http(s) URLs without userinfo, and show the real host.
            const u = safeUrl(v);
            if (u && !u.username && !u.password) dd.append(el('a', { href: v, target: '_blank', rel: 'noopener noreferrer' }, v), ' ', el('span', { class: 'muted', text: `(${u.hostname})` }));
            else dd.textContent = v;
        } else if (typeof v === 'number' || typeof v === 'boolean') dd.textContent = String(v);
        else if (Array.isArray(v) && v.every(x => x == null || ['string', 'number', 'boolean'].includes(typeof x))) {
            if (!v.length) dd.append(el('span', { class: 'muted', text: '[]' }));
            for (const x of v) dd.append(el('span', { class: 'chip', text: String(x) }));
        } else {
            dd.append(el('pre', { text: JSON.stringify(v, null, 2) }));
        }
        dl.append(el('dt', { text: k }), dd);
    }
    return dl;
}

function safeUrl(v) {
    if (!/^https?:\/\/\S+$/i.test(v)) return null;
    try { return new URL(v); } catch { return null; }
}

function imageUrls(img) {
    const base = state.publicUrlPrefix;
    if (!base) return { preview: '', original: '', thumb: '' };
    if (img.status === 'approved' && img.moved_to) {
        const stem = img.moved_to.replace(/\.[^.]+$/, '');
        return { preview: publicUrl(base, `${stem}_p.webp`), thumb: publicUrl(base, `${stem}_t.webp`), original: publicUrl(base, img.moved_to) };
    }
    const stem = `${state.pendingPrefix}${img.id}`;
    return { preview: publicUrl(base, `${stem}_p.webp`), thumb: publicUrl(base, `${stem}_t.webp`), original: publicUrl(base, `${stem}${img.ext}`) };
}

function renderImageTile(s, img) {
    const urls = imageUrls(img);
    const canRemove = s.status === 'pending' && img.status === 'pending';
    const tile = el('div', { class: 'tile', dataset: { id: img.id } });
    tile.append(el('button', { type: 'button', class: 'tile__open', 'aria-label': `Open image ${img.id}` },
        el('span', { class: 'tile__img' }, el('img', { src: urls.thumb || urls.preview || FALLBACK_IMG, alt: '', loading: 'lazy', decoding: 'async' })),
        el('span', { class: 'tile__cap', text: img.id })));
    if (img.status !== 'pending') tile.append(el('span', { class: `chip img-status ${img.status === 'approved' ? 'chip--success' : 'chip--danger'}`, text: img.status }));
    if (canRemove) tile.append(el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--danger tile__remove', 'aria-label': `Remove image ${img.id}`, title: 'Remove image' }, icon('x')));
    tile.addEventListener('click', (e) => {
        if (e.target.closest('.tile__remove')) { removeImage(s, img); return; }
        if (e.target.closest('.tile__open')) openImage(s, img);
    });
    return tile;
}

// ---------------------------------------------------------------- image dialog

function openImage(s, img) {
    const urls = imageUrls(img);
    dom.previewTitle.textContent = img.id;
    dom.previewPos.textContent = '';
    const media = dom.previewMedia;
    media.replaceChildren(icon('loader', 'icon--lg spin'));
    const dims = el('dd', { text: '—' });
    const image = el('img', { src: urls.preview || FALLBACK_IMG, alt: img.id, decoding: 'async' });
    image.addEventListener('load', () => { if (image.naturalWidth) dims.textContent = `${image.naturalWidth} × ${image.naturalHeight}`; media.querySelector('.spin')?.remove(); });
    image.addEventListener('error', () => media.querySelector('.spin')?.remove());
    media.append(image);
    dom.previewMeta.replaceChildren(
        el('dt', { text: 'Dimensions' }), dims,
        el('dt', { text: 'Format' }), el('dd', { text: (img.ext || '').replace('.', '').toUpperCase() || '—' }),
        el('dt', { text: 'Status' }), el('dd', null, el('span', { class: `chip ${img.status === 'approved' ? 'chip--success' : img.status === 'rejected' ? 'chip--danger' : 'chip--pending'}`, text: img.status })),
        el('dt', { text: 'Suggestion' }), el('dd', { text: s.id }),
    );
    if (img.moved_to) {
        const site = img.moved_to.split('/')[0];
        dom.previewMeta.append(el('dt', { text: 'Moved to' }), el('dd', null, el('a', { href: `index.html?prefix=${encodeURIComponent(site + '/')}&section=images&q=${encodeURIComponent(img.id)}` }, img.moved_to)));
    }
    const copyId = el('button', { type: 'button', id: 'preview-copy-id', class: 'btn btn--primary' }, icon('copy'), el('span', { class: 'btn__label', text: 'Copy ID' }));
    copyId.addEventListener('click', () => copyWithFeedback(copyId, img.id));
    const actions = [copyId];
    for (const [label, href] of [['Original', urls.original], ['Preview', urls.preview], ['Thumbnail', urls.thumb]]) {
        if (href) actions.push(el('a', { class: 'btn btn--ghost', href, target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'btn__label', text: label }), icon('ext'), srOnly('(opens in a new tab)')));
    }
    if (s.status === 'pending' && img.status === 'pending') {
        const rm = el('button', { type: 'button', class: 'btn btn--danger push' }, icon('trash'), el('span', { class: 'btn__label', text: 'Remove' }));
        rm.addEventListener('click', () => { dom.preview.close(); removeImage(s, img); });
        actions.push(rm);
    }
    dom.previewActions.replaceChildren(...actions);
    openDialog(dom.preview, { initialFocus: copyId, onClose: () => media.replaceChildren() });
}

// ---------------------------------------------------------------- actions

function setCardBusy(s, label) {
    const card = dom.cards.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
    const actions = card && card.querySelector('.card__actions');
    if (!actions) return () => {};
    const buttons = [...actions.querySelectorAll('button')];
    buttons.forEach(b => { b.disabled = true; });
    const status = el('span', { class: 'chip', role: 'status' }, icon('loader', 'spin'), label);
    actions.append(status);
    return () => { status.remove(); buttons.forEach(b => { b.disabled = false; }); };
}

async function patchStatus(s, status, { busy, done, verb }) {
    const revert = setCardBusy(s, busy);
    try {
        await apiJson(`suggestions/${encodeURIComponent(s.id)}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        toast(`${done} ${s.id}`, { tone: 'success' });
        refreshPendingBadge();
        await load({ silent: true });
    } catch (err) {
        revert();
        if (!(err instanceof ApiError && err.status === 401)) toast(`${verb} failed: ${err.detail || err.message}`, { tone: 'error' });
    }
}

async function cardAction(action, s, btn) {
    switch (action) {
        case 'approve': {
            const n = (s.images || []).filter(i => i.status === 'pending').length;
            const { confirmed } = await confirmDialog({ title: `Approve ${s.id}`, message: n ? `${fmt.plural(n, 'pending image')} will be moved to ${s.site}/.` : 'Approve this suggestion?', confirmText: 'Approve', tone: 'neutral' });
            if (confirmed) patchStatus(s, 'approved', { busy: 'Approving…', done: 'Approved', verb: 'Approve' });
            break;
        }
        case 'reject': {
            const { confirmed } = await confirmDialog({ title: `Reject ${s.id}`, message: 'Pending images stay in the bucket until you delete the suggestion (or the 30-day TTL removes them).', confirmText: 'Reject' });
            if (confirmed) patchStatus(s, 'rejected', { busy: 'Rejecting…', done: 'Rejected', verb: 'Reject' });
            break;
        }
        case 'complete': {
            const { confirmed } = await confirmDialog({ title: `Mark ${s.id} completed`, message: 'This tells the suggester the approved change is done and live.', confirmText: 'Mark completed', tone: 'neutral' });
            if (confirmed) patchStatus(s, 'completed', { busy: 'Completing…', done: 'Completed', verb: 'Complete' });
            break;
        }
        case 'delete': {
            const live = (s.images || []).filter(i => i.status === 'approved').length;
            const pending = (s.images || []).length - live;
            const { confirmed } = await confirmDialog({ title: `Delete ${s.id}`, message: `${fmt.plural(pending, 'pending image')} will be removed. ${fmt.plural(live, 'approved image')} in ${s.site}/ stay untouched.`, confirmText: 'Delete' });
            if (!confirmed) return;
            const revert = setCardBusy(s, 'Deleting…');
            try {
                await apiJson(`suggestions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                toast(`Deleted ${s.id}`, { tone: 'success' });
                refreshPendingBadge();
                await load({ silent: true });
            } catch (err) {
                revert();
                if (!(err instanceof ApiError && err.status === 401)) toast(`Delete failed: ${err.detail || err.message}`, { tone: 'error' });
            }
            break;
        }
        case 'edit': {
            const saved = await openTextDialog({
                title: `Edit payload · ${s.id}`, label: 'Payload (JSON object)', mono: true, rows: 16,
                value: JSON.stringify(s.payload || {}, null, 2),
                hint: 'Ctrl+Enter saves. Only pending suggestions can be edited.',
                validate: (v) => {
                    try { const p = JSON.parse(v); if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Payload must be a JSON object.'; return null; }
                    catch (e) { return `Invalid JSON: ${e.message}`; }
                },
                save: (v) => patchSuggestion(s, { payload: JSON.parse(v) }),
            });
            if (saved) toast('Payload saved', { tone: 'success' });
            break;
        }
        case 'summary': {
            const saved = await openTextDialog({
                title: `Summary · ${s.id}`, label: 'Summary', value: s.summary || '', maxlength: 300, rows: 4,
                hint: 'Max 300 characters, shown to the suggester in their status list. Leave empty to regenerate it from the payload.',
                save: (v) => patchSuggestion(s, { summary: v.trim() }),
            });
            if (saved) toast('Summary saved', { tone: 'success' });
            break;
        }
        case 'feedback': {
            const saved = await openTextDialog({
                title: `Feedback · ${s.id}`, label: 'Admin feedback', value: s.admin_context || '', maxlength: 5000, rows: 8,
                hint: 'Shown to the suggester when they check this suggestion. Ctrl+Enter saves.',
                save: (v) => patchSuggestion(s, { admin_context: v.trim() }),
            });
            if (saved) toast('Feedback saved', { tone: 'success' });
            break;
        }
        default: break;
    }
}

// PATCH one field and swap the card in place.
async function patchSuggestion(s, body) {
    const updated = await apiJson(`suggestions/${encodeURIComponent(s.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const i = state.suggestions.findIndex(x => x.id === s.id);
    if (i >= 0) state.suggestions[i] = updated;
    const node = dom.cards.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
    if (node) node.replaceWith(renderCard(updated));
}

async function removeImage(s, img) {
    const { confirmed } = await confirmDialog({ title: `Remove image ${img.id}`, message: 'Its files are deleted from the pending area.', confirmText: 'Remove' });
    if (!confirmed) return;
    try {
        const updated = await apiJson(`suggestions/${encodeURIComponent(s.id)}/images/${encodeURIComponent(img.id)}`, { method: 'DELETE' });
        const i = state.suggestions.findIndex(x => x.id === s.id);
        if (i >= 0) state.suggestions[i] = updated;
        const node = dom.cards.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
        if (node) node.replaceWith(renderCard(updated));
        toast(`Removed image ${img.id}`, { tone: 'success' });
    } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) toast(`Remove failed: ${err.detail || err.message}`, { tone: 'error' });
    }
}

async function downloadAll(s, btn) {
    setBusy(btn, true, 'Zipping…');
    let url = null;
    try {
        const res = await apiFetch(`suggestions/${encodeURIComponent(s.id)}/images.zip`);
        if (!res.ok) {
            let body = null;
            try { body = await res.json(); } catch { /* not json */ }
            throw new ApiError(res.status, (body && body.detail) || `HTTP ${res.status}`);
        }
        const skipped = res.headers.get('X-Skipped-Images');
        url = URL.createObjectURL(await res.blob());
        const a = el('a', { href: url, download: `${s.id}.zip` });
        document.body.append(a);
        a.click();
        a.remove();
        if (skipped) toast(`Downloaded, but ${skipped.split(',').length} image file(s) were missing and skipped`, { tone: 'error' });
        else toast(`Downloaded ${fmt.plural((s.images || []).length, 'image')}`, { tone: 'success' });
    } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) toast(`Download failed: ${err.detail || err.message}`, { tone: 'error' });
    } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
        setBusy(btn, false);
    }
}

// ---------------------------------------------------------------- boot

const SHORTCUTS = [
    { title: 'Suggestions', items: [
        { keys: ['r'], label: 'Refresh' }, { keys: ['[', ']'], label: 'Previous / next site' },
        { keys: ['1', '2', '3', '4', '5'], label: 'Pending / Approved / Completed / Rejected / All' }, { keys: ['?'], label: 'This sheet' },
    ] },
    { title: 'Editors', items: [{ keys: ['Ctrl', 'Enter'], label: 'Save' }, { keys: ['Esc'], label: 'Close (asks if unsaved)' }] },
];

async function boot() {
    mountShell();
    installImageFallback(document);
    startTicker();
    refresh = initRefresh(() => load({ silent: true }));
    initHelp(SHORTCUTS);
    bindPresetKeys({ getItems: () => Object.keys(state.counts).map(id => ({ id })), getCurrentId: () => state.site, onSelect: (id) => { state.site = id; state.focusId = null; setUrlState({ site: id }, { push: true }); load(); } });
    STATUSES.forEach(([value], i) => keys.on(String(i + 1), () => { if (state.status === value) return; state.status = value; state.focusId = null; renderStatusRow(); load({ silent: true }); }));
    window.addEventListener('popstate', () => {
        const p = urlParams();
        state.site = p.get('site') || state.site;
        state.status = statusFromUrl();
        state.focusId = p.get('id') || null;
        state.flashed = false;
        load();
    });
    if (!getApiKey()) {
        try { await requireLogin(); } catch { return; }
    }
    await loadConfig();
    load();
    watchPendingBadge();
}

boot();
