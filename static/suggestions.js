const BASE_PATH = (() => {
    const p = window.location.pathname;
    return p.substring(0, p.lastIndexOf('/') + 1);
})();

const params = new URLSearchParams(window.location.search);

const state = {
    site: params.get('site') || null,
    status: params.get('status') ?? 'pending',
    focusId: params.get('id') || null,
    counts: {},
    suggestions: [],
    publicUrlPrefix: '',
    pendingPrefix: '_suggestions/_pending/',
};

// DOM
const siteTabs = document.getElementById('site-tabs');
const refreshBtn = document.getElementById('refresh-btn');
const statusFilter = document.getElementById('status-filter');
const suggestionsList = document.getElementById('suggestions-list');
const emptyState = document.getElementById('empty-state');

const editModal = document.getElementById('edit-modal');
const editPayload = document.getElementById('edit-payload');
const editId = document.getElementById('edit-id');
const editError = document.getElementById('edit-error');
const editCloseBtn = document.getElementById('edit-close-btn');
const editCancelBtn = document.getElementById('edit-cancel-btn');
const editSaveBtn = document.getElementById('edit-save-btn');

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
    if (state.status) url.searchParams.set('status', state.status); else url.searchParams.delete('status');
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
        return;
    }
    const url = new URL(`${BASE_PATH}api/suggestions`, window.location.origin);
    url.searchParams.set('site', state.site);
    if (state.status) url.searchParams.set('status', state.status);
    const res = await apiFetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.suggestions = data.suggestions || [];
}

async function refresh() {
    refreshBtn.classList.add('spinner', 'loading');
    try {
        await loadCounts();
        await loadSuggestions();
        renderTabs();
        renderSuggestions();
        updateUrl();
    } catch (e) {
        if (e.message !== 'Unauthorized') {
            console.error(e);
            toast('Failed to load suggestions', 'error');
        }
    } finally {
        refreshBtn.classList.remove('spinner', 'loading');
    }
}

// ---------------- Render ----------------

function renderTabs() {
    siteTabs.innerHTML = '';
    const sites = Object.keys(state.counts);
    if (!sites.length) {
        siteTabs.innerHTML = '<span class="muted">No sites configured.</span>';
        return;
    }
    for (const site of sites) {
        const counts = state.counts[site] || { pending: 0, approved: 0, rejected: 0 };
        const tab = document.createElement('button');
        tab.className = `site-tab${site === state.site ? ' active' : ''}`;
        tab.innerHTML = `<span>${site}</span><span class="tab-badge${counts.pending ? ' has-pending' : ''}">${counts.pending}</span>`;
        tab.addEventListener('click', () => {
            if (state.site !== site) {
                state.site = site;
                state.focusId = null;
                refresh();
            }
        });
        siteTabs.appendChild(tab);
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
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

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

function renderCard(s) {
    const card = document.createElement('section');
    card.className = `suggestion-card glass-panel status-${s.status}`;
    card.dataset.id = s.id;

    const isPending = s.status === 'pending';
    const submitted = s.submitted_at ? new Date(s.submitted_at).toLocaleString() : '';

    const head = document.createElement('div');
    head.className = 'suggestion-head';
    head.innerHTML = `
        <div class="suggestion-meta">
            <span class="suggestion-id">${s.id}</span>
            <span class="suggestion-kind kind-${s.kind}">${s.kind}</span>
            <span class="suggestion-status status-pill status-${s.status}">${s.status}</span>
            <span class="suggestion-date">${submitted}</span>
        </div>
        <div class="suggestion-actions">
            ${isPending ? `
                <button class="btn primary-btn approve-btn">Approve</button>
                <button class="btn secondary-btn reject-btn">Reject</button>
                <button class="btn secondary-btn edit-btn">Edit</button>
            ` : ''}
            <button class="btn danger-btn delete-btn">Delete</button>
        </div>
    `;
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'suggestion-body';

    const payloadBlock = document.createElement('div');
    payloadBlock.className = 'payload-block';
    const payloadText = JSON.stringify(s.payload || {}, null, 2);
    payloadBlock.innerHTML = `
        <div class="block-label">Payload</div>
        <pre class="payload-json">${escapeHtml(payloadText)}</pre>
    `;
    body.appendChild(payloadBlock);

    if (s.images && s.images.length) {
        const imagesBlock = document.createElement('div');
        imagesBlock.className = 'images-block';
        imagesBlock.innerHTML = `<div class="block-label">Images (${s.images.length})</div>`;
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
    if (isPending) {
        head.querySelector('.approve-btn').addEventListener('click', () => approveSuggestion(s));
        head.querySelector('.reject-btn').addEventListener('click', () => rejectSuggestion(s));
        head.querySelector('.edit-btn').addEventListener('click', () => openEditModal(s));
    }
    head.querySelector('.delete-btn').addEventListener('click', () => deleteSuggestion(s));

    return card;
}

function renderImage(s, img) {
    const wrapper = document.createElement('div');
    wrapper.className = `image-tile status-${img.status}`;
    const previewUrl = imagePreviewUrl(s, img);
    const originalUrl = imageOriginalUrl(s, img);
    const canReject = s.status === 'pending' && img.status === 'pending';
    wrapper.innerHTML = `
        <a href="${originalUrl}" target="_blank" rel="noopener" class="image-tile-link">
            <img src="${previewUrl}" alt="${img.id}" loading="lazy"
                onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🖼️</text></svg>'">
        </a>
        <div class="image-tile-meta">
            <span class="image-id" title="${img.id}">${img.id}</span>
            <span class="status-pill status-${img.status}">${img.status}</span>
        </div>
        ${canReject ? `<button class="btn danger-btn small reject-image-btn">Remove</button>` : ''}
    `;
    if (canReject) {
        wrapper.querySelector('.reject-image-btn').addEventListener('click', () => rejectImage(s, img));
    }
    return wrapper;
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ---------------- Actions ----------------

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
        if (e.message !== 'Unauthorized') toast(`Reject failed: ${e.message}`, 'error');
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
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/${encodeURIComponent(s.id)}`, {
            method: 'DELETE',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Deleted ${s.id}`, 'success');
        refresh();
    } catch (e) {
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !editModal.classList.contains('hidden')) closeEditModal();
});

// ---------------- Filters ----------------

statusFilter.value = state.status;
statusFilter.addEventListener('change', () => {
    state.status = statusFilter.value;
    refresh();
});

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
