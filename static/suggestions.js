const BASE_PATH = (() => {
    const p = window.location.pathname;
    return p.substring(0, p.lastIndexOf('/') + 1);
})();

const params = new URLSearchParams(window.location.search);

// '' means "All". The URL serializes it as status=all; unknown values coerce
// to pending so a typoed link doesn't render an unfiltered-looking dead page.
const VALID_STATUS_FILTERS = ['pending', 'approved', 'completed', 'rejected', ''];

function statusFromUrl() {
    const s = params.get('status');
    if (s === null) return 'pending';
    if (s === 'all') return '';
    return VALID_STATUS_FILTERS.includes(s) ? s : 'pending';
}

const state = {
    site: params.get('site') || null,
    status: statusFromUrl(),
    focusId: params.get('id') || null,
    counts: {},
    suggestions: [],
    total: 0,
    truncated: false,
    publicUrlPrefix: '',
    pendingPrefix: '_suggestions/_pending/',
};

// DOM
const siteTabs = document.getElementById('site-tabs');
const refreshBtn = document.getElementById('refresh-btn');
const statusTabs = document.getElementById('status-tabs');
const suggestionsList = document.getElementById('suggestions-list');
const emptyState = document.getElementById('empty-state');

const imageModal = document.getElementById('image-modal');
const imageModalImg = document.getElementById('image-modal-img');
const imageModalIdEl = document.getElementById('image-modal-id');
const imageModalMeta = document.getElementById('image-modal-meta');
const imageModalMoved = document.getElementById('image-modal-moved');
const imageModalOriginal = document.getElementById('image-modal-original');
const imageModalPreview = document.getElementById('image-modal-preview');
const imageModalThumb = document.getElementById('image-modal-thumb');
const imageModalRemove = document.getElementById('image-modal-remove');
const imageModalCopyId = document.getElementById('image-modal-copy-id');
const imageModalCloseBtn = document.getElementById('image-modal-close-btn');

const editModal = document.getElementById('edit-modal');
const editPayload = document.getElementById('edit-payload');
const editId = document.getElementById('edit-id');
const editError = document.getElementById('edit-error');
const editCloseBtn = document.getElementById('edit-close-btn');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const editSaveBtn = document.getElementById('edit-save-btn');

const feedbackModal = document.getElementById('feedback-modal');
const feedbackText = document.getElementById('feedback-text');
const feedbackIdEl = document.getElementById('feedback-id');
const feedbackError = document.getElementById('feedback-error');
const feedbackCloseBtn = document.getElementById('feedback-close-btn');
const feedbackCancelBtn = document.getElementById('feedback-cancel-btn');
const feedbackSaveBtn = document.getElementById('feedback-save-btn');

const summaryModal = document.getElementById('summary-modal');
const summaryInput = document.getElementById('summary-input');
const summaryIdEl = document.getElementById('summary-id');
const summaryError = document.getElementById('summary-error');
const summaryCloseBtn = document.getElementById('summary-close-btn');
const summaryCancelBtn = document.getElementById('summary-cancel-btn');
const summarySaveBtn = document.getElementById('summary-save-btn');

const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmBackdrop = confirmModal.querySelector('.modal-backdrop');

const loginOverlay = document.getElementById('login-overlay');
const apiKeyInput = document.getElementById('api-key-input');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const loginError = document.getElementById('login-error');

const toastContainer = document.getElementById('toast-container');

// ---------------- Auth ----------------

const API_KEY_STORAGE = 'content_manager_api_key';

function getApiKey() {
    return localStorage.getItem(API_KEY_STORAGE);
}

function showLogin() {
    apiKeyInput.value = '';
    loginError.textContent = '';
    loginOverlay.classList.remove('hidden');
    setTimeout(() => apiKeyInput.focus(), 50);
}

async function apiFetch(url, options = {}) {
    const key = getApiKey();
    const headers = { ...(options.headers || {}) };
    if (key) headers['X-API-KEY'] = key;
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        localStorage.removeItem(API_KEY_STORAGE);
        showLogin();
        throw new Error('Unauthorized');
    }
    return res;
}

loginSubmitBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) return;
    loginError.textContent = '';
    loginSubmitBtn.disabled = true;
    try {
        const res = await fetch(`${BASE_PATH}api/auth/check`, {
            headers: { 'X-API-KEY': key }
        });
        if (res.ok) {
            localStorage.setItem(API_KEY_STORAGE, key);
            loginOverlay.classList.add('hidden');
            init();
        } else if (res.status === 401) {
            loginError.textContent = 'Invalid API key.';
        } else {
            loginError.textContent = `Server error (${res.status}).`;
        }
    } catch (e) {
        loginError.textContent = 'Network error. Try again.';
    } finally {
        loginSubmitBtn.disabled = false;
    }
});

apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loginSubmitBtn.click();
});

// ---------------- Toast / Confirm ----------------

function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
    }, 3500);
}

function confirmAction({ title = 'Confirm', message = '', confirmText = 'Confirm', danger = true } = {}) {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmOkBtn.textContent = confirmText;
        confirmOkBtn.className = `btn ${danger ? 'danger-btn' : 'primary-btn'}`;

        const cleanup = (result) => {
            confirmModal.classList.add('hidden');
            confirmOkBtn.removeEventListener('click', onOk);
            confirmCancelBtn.removeEventListener('click', onCancel);
            confirmBackdrop.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKey = (e) => {
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter') onOk();
        };
        confirmOkBtn.addEventListener('click', onOk);
        confirmCancelBtn.addEventListener('click', onCancel);
        confirmBackdrop.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);

        confirmModal.classList.remove('hidden');
        confirmOkBtn.focus();
    });
}

// ---------------- URL state ----------------

function updateUrl() {
    const url = new URL(window.location);
    if (state.site) url.searchParams.set('site', state.site); else url.searchParams.delete('site');
    // Always serialize the status ('all' for '') so the All filter survives a
    // reload / share instead of silently reverting to Pending.
    url.searchParams.set('status', state.status || 'all');
    if (state.focusId) url.searchParams.set('id', state.focusId); else url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
}

// ---------------- Data loading ----------------

async function loadConfig() {
    try {
        const res = await fetch(`${BASE_PATH}api/public/config`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        state.publicUrlPrefix = (cfg.public_url_prefix || '').replace(/\/$/, '');
        state.pendingPrefix = cfg.pending_prefix || '_suggestions/_pending/';
    } catch (e) {
        console.error('Failed to load config', e);
    }
}

async function loadCounts() {
    const res = await apiFetch(`${BASE_PATH}api/suggestions/counts`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.counts = await res.json();
    if (!state.site) {
        const sites = Object.keys(state.counts);
        state.site = sites.find(s => state.counts[s].pending > 0) || sites[0] || null;
    }
}

async function loadSuggestions() {
    if (!state.site) {
        state.suggestions = [];
        state.total = 0;
        state.truncated = false;
        return;
    }
    const url = new URL(`${BASE_PATH}api/suggestions`, window.location.origin);
    url.searchParams.set('site', state.site);
    if (state.status) url.searchParams.set('status', state.status);
    const res = await apiFetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.suggestions = data.suggestions || [];
    state.total = data.total ?? state.suggestions.length;
    state.truncated = !!data.truncated;
}

// Monotonic token so an older, slower refresh can never render on top of a
// newer one (rapid pill/tab clicks fire overlapping fetches).
let refreshSeq = 0;

async function refresh() {
    const seq = ++refreshSeq;
    refreshBtn.classList.add('spinner', 'loading');
    if (!suggestionsList.children.length) {
        renderSkeletons();
    } else {
        suggestionsList.classList.add('loading-dim');
    }
    try {
        await loadCounts();
        await loadSuggestions();
        if (seq !== refreshSeq) return;
        renderTabs();
        renderStatusTabs();
        renderSuggestions();
        updateUrl();
    } catch (e) {
        if (seq !== refreshSeq) return;
        if (e.message !== 'Unauthorized') {
            console.error(e);
            toast('Failed to load suggestions', 'error');
        }
        suggestionsList.querySelectorAll('.skeleton-card').forEach(el => el.remove());
        if (!suggestionsList.children.length) {
            emptyState.textContent = 'Could not load suggestions. Try refreshing.';
            emptyState.classList.remove('hidden');
        }
    } finally {
        if (seq === refreshSeq) {
            suggestionsList.classList.remove('loading-dim');
            refreshBtn.classList.remove('spinner', 'loading');
        }
    }
}

// ---------------- Render ----------------

const STATUSES = [
    ['pending', 'Pending'],
    ['approved', 'Approved'],
    ['completed', 'Completed'],
    ['rejected', 'Rejected'],
    ['', 'All'],
];

const EMPTY_COUNTS = { pending: 0, approved: 0, rejected: 0, completed: 0 };

function siteCounts(site) {
    return state.counts[site] || EMPTY_COUNTS;
}

function totalCount(counts) {
    return counts.pending + counts.approved + counts.completed + counts.rejected;
}

// Count shown on a site tab: matches the active status filter ("All" = total).
function filteredCount(counts) {
    return state.status ? (counts[state.status] || 0) : totalCount(counts);
}

function countsTooltip(counts) {
    return `${counts.pending} pending · ${counts.approved} approved · ${counts.completed} completed · ${counts.rejected} rejected`;
}

function renderSkeletons(n = 3) {
    emptyState.classList.add('hidden');
    suggestionsList.innerHTML = '';
    for (let i = 0; i < n; i++) {
        const sk = document.createElement('div');
        sk.className = 'skeleton-card glass-panel';
        sk.innerHTML = `
            <div class="skeleton-row">
                <span class="skeleton-line" style="width: 120px;"></span>
                <span class="skeleton-line" style="width: 90px;"></span>
                <span class="skeleton-line" style="width: 70px;"></span>
            </div>
            <span class="skeleton-line" style="width: 60%;"></span>
            <span class="skeleton-line skeleton-block"></span>
        `;
        suggestionsList.appendChild(sk);
    }
}

function renderTabs() {
    siteTabs.innerHTML = '';
    const sites = Object.keys(state.counts);
    if (!sites.length) {
        siteTabs.innerHTML = '<span class="muted">No sites configured.</span>';
        return;
    }
    for (const site of sites) {
        const counts = siteCounts(site);
        const shown = filteredCount(counts);
        // The badge shows the count for the active filter, so only accent it
        // when that count IS the pending count; sites with pending work get a
        // separate dot under other filters.
        const accent = state.status === 'pending' && shown > 0;
        const pendingDot = state.status !== 'pending' && counts.pending > 0;
        const tab = document.createElement('button');
        tab.className = `site-tab${site === state.site ? ' active' : ''}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', site === state.site ? 'true' : 'false');
        tab.title = countsTooltip(counts);
        tab.innerHTML = `<span>${escapeHtml(site)}</span><span class="tab-badge${accent ? ' has-pending' : ''}">${shown}</span>${pendingDot ? '<span class="pending-dot" title="Has pending suggestions"></span>' : ''}`;
        tab.addEventListener('click', () => {
            if (state.site !== site) {
                state.site = site;
                state.focusId = null;
                renderTabs();
                renderStatusTabs();
                refresh();
            }
        });
        siteTabs.appendChild(tab);
    }
}

// Status pills for the current site, each showing how many suggestions are in
// that state ("All" shows the site total).
function renderStatusTabs() {
    statusTabs.innerHTML = '';
    if (!state.site) return;
    const counts = siteCounts(state.site);
    for (const [value, label] of STATUSES) {
        const n = value ? (counts[value] || 0) : totalCount(counts);
        const tab = document.createElement('button');
        tab.className = `status-tab status-tab-${value || 'all'}${value === state.status ? ' active' : ''}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', value === state.status ? 'true' : 'false');
        tab.innerHTML = `<span>${label}</span><span class="tab-badge">${n}</span>`;
        tab.addEventListener('click', () => {
            if (state.status !== value) {
                state.status = value;
                state.focusId = null;
                // Re-render both bars from in-memory counts right away so the
                // highlight follows the click even if the fetch then fails.
                renderTabs();
                renderStatusTabs();
                refresh();
            }
        });
        statusTabs.appendChild(tab);
    }
}

function imagePreviewUrl(suggestion, img) {
    const base = state.publicUrlPrefix;
    if (!base) return '';
    if (img.status === 'approved' && img.moved_to) {
        const movedBase = img.moved_to.replace(/\.[^.]+$/, '');
        return `${base}/${movedBase}_p.webp`;
    }
    return `${base}/${state.pendingPrefix}${img.id}_p.webp`;
}

function imageOriginalUrl(suggestion, img) {
    const base = state.publicUrlPrefix;
    if (!base) return '';
    if (img.status === 'approved' && img.moved_to) {
        return `${base}/${img.moved_to}`;
    }
    return `${base}/${state.pendingPrefix}${img.id}${img.ext}`;
}

function renderSuggestions() {
    suggestionsList.innerHTML = '';
    if (!state.suggestions.length) {
        const statusLabel = (STATUSES.find(([v]) => v === state.status) || ['', ''])[1].toLowerCase();
        emptyState.textContent = state.status
            ? `No ${statusLabel} suggestions for ${state.site || 'this site'}.`
            : `No suggestions for ${state.site || 'this site'} yet.`;
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    if (state.truncated) {
        const note = document.createElement('p');
        note.className = 'muted truncation-note';
        note.textContent = `Showing the newest ${state.suggestions.length} of ${state.total}. Narrow by status to see older entries.`;
        suggestionsList.appendChild(note);
    }

    for (const s of state.suggestions) {
        suggestionsList.appendChild(renderCard(s));
    }

    if (state.focusId) {
        const target = suggestionsList.querySelector(`[data-id="${state.focusId}"]`);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            target.classList.add('focus-flash');
            setTimeout(() => target.classList.remove('focus-flash'), 1500);
        }
    }
}

const KIND_LABEL = {
    new: 'add new entry',
    edit: 'edit existing entry',
    delete: 'delete existing entry',
};

// Compact "how long ago", e.g. "just now", "5m ago", "3h ago", "2d ago".
// Falls back to the date itself once it's over a month old.
function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const mins = Math.floor((Date.now() - d) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 31) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderCard(s) {
    const card = document.createElement('section');
    card.className = `suggestion-card glass-panel status-${s.status}`;
    card.dataset.id = s.id;

    const isPending = s.status === 'pending';
    const isApproved = s.status === 'approved';
    const submitted = s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '';
    const kindLabel = KIND_LABEL[s.kind] || s.kind;

    const head = document.createElement('div');
    head.className = 'suggestion-head';
    head.innerHTML = `
        <div class="suggestion-meta">
            <button type="button" class="suggestion-id" title="Click to copy id">${s.id}</button>
            <span class="suggestion-kind kind-${s.kind}" title="What this suggestion is requesting">
                <span class="kind-prefix">Suggests</span>
                <span class="kind-value">${kindLabel}</span>
            </span>
            <span class="suggestion-status status-pill status-${s.status}">${s.status}</span>
            <span class="suggestion-date" title="${escapeHtml(submitted)}">${timeAgo(s.submitted_at)}</span>
        </div>
        <div class="suggestion-actions">
            ${isPending ? `
                <button class="btn primary-btn approve-btn">Approve</button>
                <button class="btn secondary-btn reject-btn">Reject</button>
                <button class="btn secondary-btn edit-btn">Edit</button>
            ` : ''}
            ${isApproved ? `<button class="btn primary-btn complete-btn">Complete</button>` : ''}
            <button class="btn secondary-btn summary-btn">Summary</button>
            <button class="btn secondary-btn feedback-btn">Feedback</button>
            <button class="btn danger-btn delete-btn">Delete</button>
        </div>
    `;
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'suggestion-body';

    if (s.summary) {
        const summaryBlock = document.createElement('div');
        summaryBlock.className = 'summary-block';
        summaryBlock.innerHTML = `
            <div class="block-label">Summary</div>
            <p class="summary-text">${escapeHtml(s.summary)}</p>
        `;
        body.appendChild(summaryBlock);
    }

    if (s.admin_context) {
        const feedbackBlock = document.createElement('div');
        feedbackBlock.className = 'feedback-block';
        feedbackBlock.innerHTML = `
            <div class="block-label">Admin Feedback</div>
            <p class="feedback-text">${escapeHtml(s.admin_context)}</p>
        `;
        body.appendChild(feedbackBlock);
    }

    const payloadBlock = document.createElement('div');
    payloadBlock.className = 'payload-block';
    const payloadText = JSON.stringify(s.payload || {}, null, 2);
    const payloadLines = payloadText.split('\n').length;
    const collapsible = payloadLines > 14;
    payloadBlock.innerHTML = `
        <div class="block-label">Payload</div>
        <pre class="payload-json${collapsible ? ' collapsed' : ''}">${escapeHtml(payloadText)}</pre>
        ${collapsible ? `<button type="button" class="payload-toggle">Show all ${payloadLines} lines</button>` : ''}
    `;
    if (collapsible) {
        const pre = payloadBlock.querySelector('.payload-json');
        const toggle = payloadBlock.querySelector('.payload-toggle');
        toggle.addEventListener('click', () => {
            const nowCollapsed = pre.classList.toggle('collapsed');
            toggle.textContent = nowCollapsed ? `Show all ${payloadLines} lines` : 'Collapse';
        });
    }
    body.appendChild(payloadBlock);

    if (s.images && s.images.length) {
        const imagesBlock = document.createElement('div');
        imagesBlock.className = 'images-block';
        const imagesHead = document.createElement('div');
        imagesHead.className = 'images-head';
        imagesHead.innerHTML = `<div class="block-label">Images (${s.images.length})</div>`;
        if (s.images.length > 1) {
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'btn secondary-btn small download-all-btn';
            downloadBtn.textContent = 'Download all';
            downloadBtn.addEventListener('click', () => downloadAllImages(s, downloadBtn));
            imagesHead.appendChild(downloadBtn);
        }
        imagesBlock.appendChild(imagesHead);
        const grid = document.createElement('div');
        grid.className = 'suggestion-images-grid';
        for (const img of s.images) {
            grid.appendChild(renderImage(s, img));
        }
        imagesBlock.appendChild(grid);
        body.appendChild(imagesBlock);
    }

    card.appendChild(body);

    // Wire up action buttons
    head.querySelector('.suggestion-id').addEventListener('click', async () => {
        const ok = await copyToClipboard(s.id);
        toast(ok ? `Copied ${s.id}` : 'Copy failed', ok ? 'success' : 'error');
    });
    if (isPending) {
        head.querySelector('.approve-btn').addEventListener('click', () => approveSuggestion(s));
        head.querySelector('.reject-btn').addEventListener('click', () => rejectSuggestion(s));
        head.querySelector('.edit-btn').addEventListener('click', () => openEditModal(s));
    }
    if (isApproved) {
        head.querySelector('.complete-btn').addEventListener('click', () => completeSuggestion(s));
    }
    head.querySelector('.summary-btn').addEventListener('click', () => openSummaryModal(s));
    head.querySelector('.feedback-btn').addEventListener('click', () => openFeedbackModal(s));
    head.querySelector('.delete-btn').addEventListener('click', () => deleteSuggestion(s));

    return card;
}

function renderImage(s, img) {
    const wrapper = document.createElement('div');
    wrapper.className = `image-tile status-${img.status}`;
    const previewUrl = imagePreviewUrl(s, img);
    const canReject = s.status === 'pending' && img.status === 'pending';
    wrapper.innerHTML = `
        <button type="button" class="image-tile-link" aria-label="Open ${img.id}">
            <img src="${previewUrl}" alt="${img.id}" loading="lazy"
                onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🖼️</text></svg>'">
        </button>
        <div class="image-tile-meta">
            <span class="image-id" title="${img.id}">${img.id}</span>
            <span class="status-pill status-${img.status}">${img.status}</span>
        </div>
        ${canReject ? `<button class="btn danger-btn small reject-image-btn">Remove</button>` : ''}
    `;
    wrapper.querySelector('.image-tile-link').addEventListener('click', () => openImageModal(s, img));
    if (canReject) {
        wrapper.querySelector('.reject-image-btn').addEventListener('click', () => rejectImage(s, img));
    }
    return wrapper;
}

function imageThumbnailUrl(s, img) {
    const base = state.publicUrlPrefix;
    if (!base) return '';
    if (img.status === 'approved' && img.moved_to) {
        const movedBase = img.moved_to.replace(/\.[^.]+$/, '');
        return `${base}/${movedBase}_t.webp`;
    }
    return `${base}/${state.pendingPrefix}${img.id}_t.webp`;
}

function openImageModal(s, img) {
    const previewUrl = imagePreviewUrl(s, img);
    const originalUrl = imageOriginalUrl(s, img);
    const thumbUrl = imageThumbnailUrl(s, img);

    imageModalImg.src = previewUrl;
    imageModalImg.alt = img.id;
    imageModalIdEl.textContent = img.id;

    const metaParts = [
        `Ext: ${img.ext}`,
        `Status: ${img.status}`,
        `Suggestion: ${s.id}`,
    ];
    imageModalMeta.textContent = metaParts.join(' • ');
    imageModalMoved.textContent = img.moved_to ? `Moved to: ${img.moved_to}` : '';

    imageModalOriginal.href = originalUrl || '#';
    imageModalPreview.href = previewUrl || '#';
    imageModalThumb.href = thumbUrl || '#';

    imageModalCopyId.onclick = async () => {
        const ok = await copyToClipboard(img.id);
        toast(ok ? `Copied ${img.id}` : 'Copy failed', ok ? 'success' : 'error');
    };

    const canReject = s.status === 'pending' && img.status === 'pending';
    imageModalRemove.style.display = canReject ? 'inline-flex' : 'none';
    imageModalRemove.onclick = canReject
        ? async () => {
            closeImageModal();
            await rejectImage(s, img);
        }
        : null;

    imageModal.classList.remove('hidden');
}

function closeImageModal() {
    imageModal.classList.add('hidden');
    imageModalImg.src = '';
}

imageModalCloseBtn.addEventListener('click', closeImageModal);
imageModal.querySelector('.modal-backdrop').addEventListener('click', closeImageModal);

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) { /* fall through to legacy path */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
    } catch (e) {
        console.error('Copy failed', e);
        return false;
    }
}

// ---------------- Actions ----------------

// Disable a card's action buttons and show a spinner + label while an async
// action is in flight. Returns a function that reverts the busy state (call it
// on failure; on success the card is replaced by refresh()).
function setCardBusy(s, label) {
    const card = suggestionsList.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
    const actions = card && card.querySelector('.suggestion-actions');
    if (!actions) return () => {};
    const buttons = [...actions.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    const status = document.createElement('span');
    status.className = 'action-status';
    status.innerHTML = `<span class="btn-spinner"></span><span>${escapeHtml(label)}</span>`;
    actions.appendChild(status);
    return () => {
        status.remove();
        buttons.forEach(b => b.disabled = false);
    };
}

async function approveSuggestion(s) {
    const imgCount = (s.images || []).filter(i => i.status === 'pending').length;
    const ok = await confirmAction({
        title: 'Approve suggestion',
        message: imgCount
            ? `Approve ${s.id}? ${imgCount} pending image(s) will be moved to ${s.site}/.`
            : `Approve ${s.id}?`,
        confirmText: 'Approve',
        danger: false,
    });
    if (!ok) return;
    const revert = setCardBusy(s, 'Approving…');
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'approved' }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        toast(`Approved ${s.id}`, 'success');
        refresh();
    } catch (e) {
        revert();
        if (e.message !== 'Unauthorized') toast(`Approve failed: ${e.message}`, 'error');
    }
}

async function rejectSuggestion(s) {
    const ok = await confirmAction({
        title: 'Reject suggestion',
        message: `Reject ${s.id}? Pending images stay until you delete the suggestion (or 30-day TTL).`,
        confirmText: 'Reject',
    });
    if (!ok) return;
    const revert = setCardBusy(s, 'Rejecting…');
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'rejected' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Rejected ${s.id}`, 'success');
        refresh();
    } catch (e) {
        revert();
        if (e.message !== 'Unauthorized') toast(`Reject failed: ${e.message}`, 'error');
    }
}

async function completeSuggestion(s) {
    const ok = await confirmAction({
        title: 'Mark completed',
        message: `Mark ${s.id} as completed? This tells the suggester the approved change is done and live.`,
        confirmText: 'Complete',
        danger: false,
    });
    if (!ok) return;
    const revert = setCardBusy(s, 'Completing…');
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        toast(`Completed ${s.id}`, 'success');
        refresh();
    } catch (e) {
        revert();
        if (e.message !== 'Unauthorized') toast(`Complete failed: ${e.message}`, 'error');
    }
}

async function deleteSuggestion(s) {
    const liveCount = (s.images || []).filter(i => i.status === 'approved').length;
    const pendingCount = (s.images || []).filter(i => i.status !== 'approved').length;
    const ok = await confirmAction({
        title: 'Delete suggestion',
        message: `Delete ${s.id}? ${pendingCount} pending image(s) will be removed. ${liveCount} approved image(s) in ${s.site}/ will be untouched.`,
        confirmText: 'Delete',
    });
    if (!ok) return;
    const revert = setCardBusy(s, 'Deleting…');
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}`, {
            method: 'DELETE',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Deleted ${s.id}`, 'success');
        refresh();
    } catch (e) {
        revert();
        if (e.message !== 'Unauthorized') toast(`Delete failed: ${e.message}`, 'error');
    }
}

async function rejectImage(s, img) {
    const ok = await confirmAction({
        title: 'Remove image',
        message: `Remove image ${img.id} from this suggestion? The files will be deleted from pending.`,
        confirmText: 'Remove',
    });
    if (!ok) return;
    try {
        const res = await apiFetch(
            `${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}/images/${encodeURIComponent(img.id)}`,
            { method: 'DELETE' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Removed image ${img.id}`, 'success');
        refresh();
    } catch (e) {
        if (e.message !== 'Unauthorized') toast(`Remove failed: ${e.message}`, 'error');
    }
}

async function downloadAllImages(s, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Zipping…';
    let url = null;
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}/images.zip`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        const skipped = res.headers.get('X-Skipped-Images');
        url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = `${s.id}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (skipped) {
            toast(`Downloaded — ${skipped.split(',').length} image file(s) missing and skipped`, 'error');
        } else {
            toast(`Downloaded ${s.images.length} images`, 'success');
        }
    } catch (e) {
        if (e.message !== 'Unauthorized') toast(`Download failed: ${e.message}`, 'error');
    } finally {
        // Revoked late so the browser has finished reading the blob.
        if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
        btn.disabled = false;
        btn.textContent = label;
    }
}

// ---------------- Edit modal ----------------

let editingId = null;

function openEditModal(s) {
    editingId = s.id;
    editId.textContent = s.id;
    editPayload.value = JSON.stringify(s.payload || {}, null, 2);
    editError.textContent = '';
    editModal.classList.remove('hidden');
    setTimeout(() => editPayload.focus(), 50);
}

function closeEditModal() {
    editModal.classList.add('hidden');
    editingId = null;
}

editCloseBtn.addEventListener('click', closeEditModal);
editCancelBtn.addEventListener('click', closeEditModal);
editModal.querySelector('.modal-backdrop').addEventListener('click', closeEditModal);

editSaveBtn.addEventListener('click', async () => {
    if (!editingId) return;
    let parsed;
    try {
        parsed = JSON.parse(editPayload.value);
    } catch (e) {
        editError.textContent = `Invalid JSON: ${e.message}`;
        return;
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        editError.textContent = 'Payload must be a JSON object.';
        return;
    }
    editSaveBtn.disabled = true;
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(editingId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: parsed }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        toast('Payload saved', 'success');
        closeEditModal();
        refresh();
    } catch (e) {
        editError.textContent = e.message;
    } finally {
        editSaveBtn.disabled = false;
    }
});

// ---------------- Summary modal ----------------

// Editable in any status: the summary only describes what the suggestion asked
// for, so changing it doesn't alter the request itself.
let summaryId = null;

function openSummaryModal(s) {
    summaryId = s.id;
    summaryIdEl.textContent = s.id;
    summaryInput.value = s.summary || '';
    summaryError.textContent = '';
    summaryModal.classList.remove('hidden');
    setTimeout(() => summaryInput.focus(), 50);
}

function closeSummaryModal() {
    summaryModal.classList.add('hidden');
    summaryId = null;
}

summaryCloseBtn.addEventListener('click', closeSummaryModal);
summaryCancelBtn.addEventListener('click', closeSummaryModal);
summaryModal.querySelector('.modal-backdrop').addEventListener('click', closeSummaryModal);

summarySaveBtn.addEventListener('click', async () => {
    if (summaryId === null) return;
    summarySaveBtn.disabled = true;
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(summaryId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary: summaryInput.value.trim() }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        toast('Summary saved', 'success');
        closeSummaryModal();
        refresh();
    } catch (e) {
        if (e.message !== 'Unauthorized') summaryError.textContent = e.message;
    } finally {
        summarySaveBtn.disabled = false;
    }
});

// ---------------- Feedback modal ----------------

let feedbackId = null;

function openFeedbackModal(s) {
    feedbackId = s.id;
    feedbackIdEl.textContent = s.id;
    feedbackText.value = s.admin_context || '';
    feedbackError.textContent = '';
    feedbackModal.classList.remove('hidden');
    setTimeout(() => feedbackText.focus(), 50);
}

function closeFeedbackModal() {
    feedbackModal.classList.add('hidden');
    feedbackId = null;
}

feedbackCloseBtn.addEventListener('click', closeFeedbackModal);
feedbackCancelBtn.addEventListener('click', closeFeedbackModal);
feedbackModal.querySelector('.modal-backdrop').addEventListener('click', closeFeedbackModal);

feedbackSaveBtn.addEventListener('click', async () => {
    if (feedbackId === null) return;
    feedbackSaveBtn.disabled = true;
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(feedbackId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_context: feedbackText.value.trim() }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        toast('Feedback saved', 'success');
        closeFeedbackModal();
        refresh();
    } catch (e) {
        if (e.message !== 'Unauthorized') feedbackError.textContent = e.message;
    } finally {
        feedbackSaveBtn.disabled = false;
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!editModal.classList.contains('hidden')) closeEditModal();
    else if (!summaryModal.classList.contains('hidden')) closeSummaryModal();
    else if (!feedbackModal.classList.contains('hidden')) closeFeedbackModal();
    else if (!imageModal.classList.contains('hidden')) closeImageModal();
});

// ---------------- Filters ----------------

refreshBtn.addEventListener('click', () => refresh());

// ---------------- Init ----------------

async function init() {
    await loadConfig();
    await refresh();
}

document.addEventListener('DOMContentLoaded', () => {
    if (!getApiKey()) {
        showLogin();
    } else {
        init();
    }
});
