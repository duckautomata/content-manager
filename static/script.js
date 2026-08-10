// Base path for API calls. Derived from the current page URL so the app works
// when served under a subpath (e.g. domain.com/api/content-manager/).
// Assumes the page URL ends with a "/" or with index.html — standard for index pages.
const BASE_PATH = (() => {
    const p = window.location.pathname;
    return p.substring(0, p.lastIndexOf('/') + 1);
})();

const state = {
    prefix: new URLSearchParams(window.location.search).get('prefix') || 'home/',
    images: [],
    videos: [],
    others: [],
    publicUrlPrefix: '',
    filter: '',
    scheduledByKey: new Map()
};

// DOM Elements
const prefixInput = document.getElementById('prefix-input');
const prefixPresets = document.getElementById('prefix-presets');
const syncSheetBtn = document.getElementById('sync-sheet-btn');
const refreshBtn = document.getElementById('refresh-btn');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const progressFill = document.querySelector('.progress-fill');
const progressText = document.querySelector('.progress-text');

const imagesGrid = document.getElementById('images-grid');
const imagesCount = document.getElementById('images-count');
const videosGrid = document.getElementById('videos-grid');
const videosCount = document.getElementById('videos-count');
const othersList = document.getElementById('others-list');
const othersCount = document.getElementById('others-count');
const dataFilesSection = document.getElementById('data-files-section');
const dataFilesList = document.getElementById('data-files-list');
const dataFilesCount = document.getElementById('data-files-count');
const imagesSection = document.getElementById('images-section');
const videosSection = document.getElementById('videos-section');
const othersSection = document.getElementById('others-section');
const contentEmpty = document.getElementById('content-empty');
const prefixBreadcrumb = document.getElementById('prefix-breadcrumb');
const suggestionsBadge = document.getElementById('suggestions-badge');

const filterInput = document.getElementById('filter-input');
const replaceFileInput = document.getElementById('replace-file-input');
let currentReplaceFilename = null;

const modal = document.getElementById('preview-modal');
const modalImage = document.getElementById('modal-image');
const modalTitle = document.getElementById('modal-title');
const modalMeta = document.getElementById('modal-meta');

const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmBackdrop = confirmModal.querySelector('.modal-backdrop');
const confirmDelayRow = document.getElementById('confirm-delay-row');
const confirmDelay = document.getElementById('confirm-delay');

// Delayed-delete presets offered in the delete dialog (seconds; 0 = delete now).
const DELETE_DELAYS = [
    { label: 'Delete now', seconds: 0 },
    { label: 'In 1 hour', seconds: 3600 },
    { label: 'In 10 hours', seconds: 36000 },
    { label: 'In 1 day', seconds: 86400 },
    { label: 'In 1 week', seconds: 604800 },
    { label: 'In 1 month', seconds: 2592000 },
];
confirmDelay.innerHTML = DELETE_DELAYS
    .map(d => `<option value="${d.seconds}">${d.label}</option>`)
    .join('');

const toastContainer = document.getElementById('toast-container');
const modalOrigLink = document.getElementById('modal-original-link');
const modalPrevLink = document.getElementById('modal-preview-link');
const modalDelBtn = document.getElementById('modal-delete-btn');
const modalCopyIdBtn = document.getElementById('modal-copy-id-btn');
const modalCopyUrlBtn = document.getElementById('modal-copy-url-btn');
const modalCancelScheduleBtn = document.getElementById('modal-cancel-schedule-btn');
const closeBtn = document.querySelector('.close-modal-btn');
const backdrop = document.querySelector('.modal-backdrop');

const resultsModal = document.getElementById('upload-results-modal');
const resultsList = document.getElementById('upload-results-list');
const closeResultsBtn = document.querySelector('.close-results-btn');
const resultsBackdrop = resultsModal.querySelector('.modal-backdrop');

const loginOverlay = document.getElementById('login-overlay');
const apiKeyInput = document.getElementById('api-key-input');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const loginError = document.getElementById('login-error');

// Auth
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

function hideLogin() {
    loginOverlay.classList.add('hidden');
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
            hideLogin();
            fetchContent();
        } else if (res.status === 401) {
            loginError.textContent = 'Invalid API key.';
        } else {
            let detail = '';
            try { detail = (await res.json()).detail || ''; } catch (_) { /* ignore */ }
            loginError.textContent = detail
                ? `Error (${res.status}): ${detail}`
                : `Server error (${res.status}).`;
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

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    prefixInput.value = state.prefix;
    if (!getApiKey()) {
        showLogin();
    } else {
        fetchContent();
    }
});

// Toasts
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

// Custom confirm dialog. Returns Promise<boolean>.
function confirmAction({ title = 'Confirm', message = '', confirmText = 'Confirm', danger = true, withDelay = false } = {}) {
    return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmOkBtn.textContent = confirmText;
        confirmOkBtn.className = `btn ${danger ? 'danger-btn' : 'primary-btn'}`;
        confirmDelayRow.classList.toggle('hidden', !withDelay);
        if (withDelay) confirmDelay.value = '0';

        const cleanup = (result) => {
            confirmModal.classList.add('hidden');
            confirmOkBtn.removeEventListener('click', onOk);
            confirmCancelBtn.removeEventListener('click', onCancel);
            confirmBackdrop.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        // When withDelay, resolve an object; otherwise keep the boolean contract.
        const ok = () => withDelay ? { confirmed: true, delaySeconds: Number(confirmDelay.value) } : true;
        const no = () => withDelay ? { confirmed: false, delaySeconds: 0 } : false;
        const onOk = () => cleanup(ok());
        const onCancel = () => cleanup(no());
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

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
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

function formatBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Navigate to a prefix: update state, input, URL, and reload content.
function goToPrefix(newPrefix) {
    if (!newPrefix) return;
    if (!newPrefix.endsWith('/')) newPrefix += '/';
    state.prefix = newPrefix;
    prefixInput.value = newPrefix;
    updateUrlPrefix(newPrefix);
    fetchContent();
}

// Populate the "Go to" dropdown with the configured common prefixes. Keeps the
// leading placeholder and marks the current prefix as selected when it matches.
let _renderedPresets = '';
function renderPrefixPresets(prefixes) {
    if (!prefixPresets) return;
    const signature = prefixes.join('|');
    if (signature !== _renderedPresets) {
        _renderedPresets = signature;
        prefixPresets.innerHTML = '<option value="" disabled>Go to…</option>';
        for (const p of prefixes) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p.replace(/\/$/, '');
            prefixPresets.appendChild(opt);
        }
    }
    // Reflect the current prefix if it's one of the presets, else show placeholder.
    prefixPresets.value = prefixes.includes(state.prefix) ? state.prefix : '';
}

if (prefixPresets) {
    prefixPresets.addEventListener('change', () => {
        const p = prefixPresets.value;
        if (p) goToPrefix(p);
    });
}

// Show the "Data Files" section (and its "Update from spreadsheet" button) only
// for prefixes that have Google Sheet CSV sources configured on the backend.
let _csvSources = [];
function renderSyncButton(files) {
    _csvSources = files;
    if (dataFilesSection) dataFilesSection.classList.toggle('hidden', files.length === 0);
    if (syncSheetBtn && files.length) {
        syncSheetBtn.title = `Re-download from Google Sheets: ${files.join(', ')}`;
    }
}

if (syncSheetBtn) {
    const syncLabel = syncSheetBtn.querySelector('.sync-label');
    const syncIcon = syncSheetBtn.querySelector('svg');
    syncSheetBtn.addEventListener('click', async () => {
        if (!_csvSources.length) return;
        const ok = await confirmAction({
            title: 'Update from spreadsheet',
            message: `Re-download ${_csvSources.join(', ')} from Google Sheets and overwrite the copies in ${state.prefix}?`,
            confirmText: 'Update',
        });
        if (!ok) return;

        syncSheetBtn.disabled = true;
        syncIcon.classList.add('spinner');
        if (syncLabel) syncLabel.textContent = 'Updating…';
        try {
            const res = await apiFetch(`${BASE_PATH}api/content/sync-csv?prefix=${encodeURIComponent(state.prefix)}`, {
                method: 'POST',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
            const updated = data.updated || [];
            const errs = data.errors || [];
            if (errs.length) {
                toast(`Updated ${updated.length}; failed: ${errs.map(e => `${e.file} (${e.error})`).join(', ')}`, 'error');
            } else {
                toast(`Updated ${updated.join(', ') || 'nothing'}`, 'success');
            }
            fetchContent();
        } catch (e) {
            if (e.message !== 'Unauthorized') toast(`Update failed: ${e.message}`, 'error');
        } finally {
            syncSheetBtn.disabled = false;
            syncIcon.classList.remove('spinner');
            if (syncLabel) syncLabel.textContent = 'Update from spreadsheet';
        }
    });
}

// Update URL without reloading
function updateUrlPrefix(newPrefix) {
    const url = new URL(window.location);
    url.searchParams.set('prefix', newPrefix);
    window.history.pushState({}, '', url);
}

// Handle browser back/forward buttons
window.addEventListener('popstate', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const newPrefix = urlParams.get('prefix') || 'home/';
    if (state.prefix !== newPrefix) {
        state.prefix = newPrefix;
        prefixInput.value = state.prefix;
        fetchContent();
    }
});

let filterDebounceTimer;
filterInput.addEventListener('input', () => {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(() => {
        state.filter = filterInput.value.toLowerCase();
        renderContent();
    }, 200);
});

// "/" focuses the filter from anywhere; Escape inside it clears and blurs.
document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || t instanceof HTMLSelectElement || (t && t.isContentEditable);
    if (typing) return;
    // Every overlay (preview, results, confirm, login) is a .modal that toggles
    // "hidden" — never steal focus from an open one.
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    filterInput.focus();
});

filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        filterInput.value = '';
        state.filter = '';
        renderContent();
        filterInput.blur();
    }
});

// Event Listeners
refreshBtn.addEventListener('click', () => {
    state.prefix = prefixInput.value;
    if (!state.prefix.endsWith('/')) {
        state.prefix += '/';
        prefixInput.value = state.prefix;
    }
    updateUrlPrefix(state.prefix);
    fetchContent();
});

prefixInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        refreshBtn.click();
    }
});

// Drag and Drop
dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
    }
});

dropzone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
        handleFiles(fileInput.files);
    }
});

// Replace File Input Listener
replaceFileInput.addEventListener('change', async () => {
    if (!replaceFileInput.files.length || !currentReplaceFilename) return;

    const file = replaceFileInput.files[0];
    const formData = new FormData();
    formData.append('prefix', state.prefix);
    formData.append('file', file);
    formData.append('override_filename', currentReplaceFilename);

    uploadProgress.classList.remove('hidden');
    progressText.textContent = `Replacing ${currentReplaceFilename}...`;
    progressFill.style.width = '50%';

    try {
        const res = await apiFetch(`${BASE_PATH}api/upload`, {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            const data = await res.json();
            progressFill.style.width = '100%';
            progressText.textContent = `Replaced successfully.`;

            setTimeout(() => {
                uploadProgress.classList.add('hidden');
                progressFill.style.width = '0%';
                fetchContent();
                replaceFileInput.value = ''; // Reset input
                currentReplaceFilename = null;
                showUploadResults([{ ...data, original_name: file.name }]);
            }, 1000);

        } else {
            throw new Error('Upload failed');
        }
    } catch (err) {
        console.error(err);
        toast('Failed to replace file.', 'error');

        setTimeout(() => {
            uploadProgress.classList.add('hidden');
            progressFill.style.width = '0%';
            fetchContent();
            replaceFileInput.value = ''; // Reset input
            currentReplaceFilename = null;
        }, 1500);
    }
});

// Modal Listeners
closeBtn.addEventListener('click', closeModal);
backdrop.addEventListener('click', closeModal);
closeResultsBtn.addEventListener('click', () => resultsModal.classList.add('hidden'));
resultsBackdrop.addEventListener('click', () => resultsModal.classList.add('hidden'));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
        resultsModal.classList.add('hidden');
    }
});

function getPublicUrl(key) {
    if (!key) return '#';
    const cleanPrefix = state.publicUrlPrefix.endsWith('/') ? state.publicUrlPrefix.slice(0, -1) : state.publicUrlPrefix;
    if (cleanPrefix) {
        return `${cleanPrefix}/${key}`;
    }
    // Fallback if no public URL prefix is given, maybe the frontend endpoint itself is the proxy (though we don't serve R2 directly here)
    // Assuming bucket URLs or similar:
    return `${BASE_PATH}api/content?key=${encodeURIComponent(key)}`; // Mock fallback
}

// Pending-suggestions badge on the header's Suggestions link. Best-effort:
// failures just leave the badge hidden.
async function loadSuggestionsBadge() {
    if (!suggestionsBadge) return;
    try {
        const res = await apiFetch(`${BASE_PATH}api/suggestions/counts`);
        if (!res.ok) return;
        const counts = await res.json();
        const pending = Object.values(counts).reduce((sum, c) => sum + (c.pending || 0), 0);
        suggestionsBadge.textContent = pending;
        suggestionsBadge.classList.toggle('hidden', pending === 0);
    } catch (_) { /* non-fatal */ }
}

// Clickable path segments for the current prefix, shown when it nests.
function renderBreadcrumb() {
    if (!prefixBreadcrumb) return;
    const segments = state.prefix.split('/').filter(Boolean);
    if (segments.length < 2) {
        prefixBreadcrumb.classList.add('hidden');
        prefixBreadcrumb.innerHTML = '';
        return;
    }
    prefixBreadcrumb.innerHTML = '';
    segments.forEach((seg, idx) => {
        if (idx > 0) {
            const sep = document.createElement('span');
            sep.className = 'crumb-sep';
            sep.textContent = '/';
            prefixBreadcrumb.appendChild(sep);
        }
        const target = segments.slice(0, idx + 1).join('/') + '/';
        if (idx === segments.length - 1) {
            const here = document.createElement('span');
            here.className = 'crumb current';
            here.textContent = seg;
            prefixBreadcrumb.appendChild(here);
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'crumb';
            btn.textContent = seg;
            btn.title = `Go to ${target}`;
            btn.addEventListener('click', () => goToPrefix(target));
            prefixBreadcrumb.appendChild(btn);
        }
    });
    prefixBreadcrumb.classList.remove('hidden');
}

function renderGridSkeletons(container, n) {
    for (let i = 0; i < n; i++) {
        const sk = document.createElement('div');
        sk.className = 'skeleton-tile';
        container.appendChild(sk);
    }
}

// Fetch State
async function fetchContent() {
    refreshBtn.classList.add('spinner', 'loading');
    imagesGrid.innerHTML = '';
    videosGrid.innerHTML = '';
    othersList.innerHTML = '';
    contentEmpty.classList.add('hidden');
    // Show the images section as the loading canvas (a previous render may have
    // hidden it); tuck the rest away until we know what this prefix holds.
    imagesSection.classList.remove('hidden');
    videosSection.classList.add('hidden');
    othersSection.classList.add('hidden');
    renderGridSkeletons(imagesGrid, 6);
    // Depends only on state.prefix, so render before the fetch — a failed load
    // must not leave the previous prefix's crumbs on screen.
    renderBreadcrumb();

    try {
        const res = await apiFetch(`${BASE_PATH}api/content?prefix=${encodeURIComponent(state.prefix)}`);
        if (!res.ok) throw new Error('Failed to fetch content');
        const data = await res.json();

        state.images = data.images || [];
        state.videos = data.videos || [];
        state.others = data.others || [];
        state.publicUrlPrefix = data.public_url_prefix || '';

        renderPrefixPresets(data.common_prefixes || []);
        renderSyncButton(data.csv_sources || []);
        await loadScheduledDeletes();
        renderContent();
        loadSuggestionsBadge();
    } catch (err) {
        // Leave a coherent page behind: clear stale state, then show an error
        // message where the content would have been.
        state.images = [];
        state.videos = [];
        state.others = [];
        renderSyncButton([]);
        renderContent();
        contentEmpty.textContent = `Could not load ${state.prefix}. Check the console and refresh.`;
        contentEmpty.classList.remove('hidden');
        console.error(err);
        toast('Error fetching content. Check console for details.', 'error');
    } finally {
        refreshBtn.classList.remove('spinner', 'loading');
    }
}

// Render UI
const RENDER_BATCH = 60;
let _renderObservers = [];

function clearRenderObservers() {
    _renderObservers.forEach(o => o.disconnect());
    _renderObservers = [];
}

// Render `items` into `container` in batches, revealing more as a sentinel
// scrolls into view. Keeps the DOM light even for very large prefixes.
function renderIncrementally(container, items, createNode) {
    let i = 0;
    const sentinel = document.createElement('div');
    sentinel.className = 'render-sentinel';
    sentinel.style.minHeight = '1px';

    const renderNext = () => {
        const frag = document.createDocumentFragment();
        const end = Math.min(i + RENDER_BATCH, items.length);
        for (; i < end; i++) frag.appendChild(createNode(items[i]));
        container.appendChild(frag);
        if (i < items.length) {
            container.appendChild(sentinel); // keep the sentinel after the last card
        } else {
            obs.disconnect();
            sentinel.remove();
        }
    };

    const obs = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) renderNext();
    }, { rootMargin: '300px' });

    renderNext();
    if (i < items.length) obs.observe(sentinel);
    _renderObservers.push(obs);
}

function createMediaCard(item, fallbackEmoji) {
    const thumbKey = item.files.thumbnail || item.files.original; // Fallback to original if no thumb somehow
    const url = getPublicUrl(state.prefix + thumbKey);

    const sched = scheduledRecordFor(item);
    const card = document.createElement('div');
    card.className = `image-card glass-panel${sched ? ' scheduled' : ''}`;
    card.innerHTML = `
        <img src="${escapeHtml(url)}" alt="${escapeHtml(item.slug)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>${fallbackEmoji}</text></svg>'">
        ${sched ? `<span class="sched-badge" title="Scheduled to delete ${escapeHtml(formatWhen(sched.due_at))}">⏳ ${escapeHtml(remainingShort(sched.due_at))}</span>` : ''}
        <div class="overlay">
            <span>${escapeHtml(item.slug)}</span>
        </div>
    `;
    card.addEventListener('click', () => openModal(item));
    return card;
}

function createOtherItem(item) {
    const div = document.createElement('div');
    const sched = scheduledRecordFor(item);
    div.className = `list-item${sched ? ' scheduled' : ''}`;

    const size = formatBytes(item.size);
    const date = formatDate(item.last_modified);

    div.innerHTML = `
        <div class="item-info">
            <svg class="item-icon" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
            <div class="item-details">
                <div class="item-name">${escapeHtml(item.filename)}</div>
                <div class="item-meta">
                    <span>${size}</span>
                    <span>${date}</span>
                    ${sched ? `<span class="sched-badge" title="Scheduled to delete ${escapeHtml(formatWhen(sched.due_at))}">⏳ deletes in ${escapeHtml(remainingShort(sched.due_at))}</span>` : ''}
                </div>
            </div>
        </div>
        <div class="item-actions">
            ${sched ? `<button class="btn secondary-btn cancel-sched-btn" title="Cancel scheduled deletion">Cancel deletion</button>` : ''}
            <button class="btn secondary-btn replace-item-btn" title="Replace File">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.3-11.23l4.63 4.66"/></svg>
            </button>
            <a href="${escapeHtml(getPublicUrl(item.key))}" target="_blank" class="btn secondary-btn" title="Download">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </a>
            <button class="btn danger-btn delete-item-btn" data-key="${escapeHtml(item.key)}" title="Delete">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>
    `;

    div.querySelector('.replace-item-btn').addEventListener('click', () => {
        currentReplaceFilename = item.filename;
        replaceFileInput.click();
    });
    div.querySelector('.delete-item-btn').addEventListener('click', () => deleteItem(item));
    if (sched) {
        div.querySelector('.cancel-sched-btn').addEventListener('click', () => cancelScheduledDelete(sched.id, item.filename));
    }

    return div;
}

function renderContent() {
    clearRenderObservers();
    imagesGrid.innerHTML = '';
    videosGrid.innerHTML = '';
    othersList.innerHTML = '';
    dataFilesList.innerHTML = '';

    const f = state.filter;
    const imgs = f ? state.images.filter(i => i.slug.toLowerCase().includes(f)) : state.images;
    const vids = f ? state.videos.filter(v => v.slug.toLowerCase().includes(f)) : state.videos;

    // Split "others" into configured data files (from CSV_SOURCES) and the rest.
    const csvSet = new Set(_csvSources);
    const isDataFile = (o) => csvSet.has(o.filename);
    const dataAll = state.others.filter(isDataFile);
    const otherAll = state.others.filter(o => !isDataFile(o));
    const dataFiles = f ? dataAll.filter(o => o.filename.toLowerCase().includes(f)) : dataAll;
    const others = f ? otherAll.filter(o => o.filename.toLowerCase().includes(f)) : otherAll;

    imagesCount.textContent = imgs.length;
    videosCount.textContent = vids.length;
    othersCount.textContent = others.length;
    dataFilesCount.textContent = dataFiles.length;

    // Hide sections with nothing to show; when everything is empty, say so once
    // instead of stacking empty headings.
    imagesSection.classList.toggle('hidden', imgs.length === 0);
    videosSection.classList.toggle('hidden', vids.length === 0);
    othersSection.classList.toggle('hidden', others.length === 0);
    // Data files: visible whenever CSV sources are configured (the sync button
    // lives here, and it must stay reachable even before the first sync), but
    // hidden when a filter matches none of them.
    if (dataFilesSection) {
        dataFilesSection.classList.toggle('hidden', _csvSources.length === 0 || (!!f && dataFiles.length === 0));
    }
    const nothing = !imgs.length && !vids.length && !others.length && !dataFiles.length;
    contentEmpty.textContent = f
        ? `Nothing in ${state.prefix} matches “${filterInput.value.trim()}”.`
        : `Nothing under ${state.prefix} yet. Drop files above to upload.`;
    contentEmpty.classList.toggle('hidden', !nothing);

    renderIncrementally(dataFilesList, dataFiles, createOtherItem);
    renderIncrementally(imagesGrid, imgs, (it) => createMediaCard(it, '🖼️'));
    renderIncrementally(videosGrid, vids, (it) => createMediaCard(it, '🎥'));
    renderIncrementally(othersList, others, createOtherItem);
}

// Modal Functions
function openModal(img) {
    // Try to load preview webp, fallback to thumbnail or original if missing
    const previewKey = img.files.preview || img.files.original || img.files.thumbnail;
    const origKey = img.files.original || img.files.preview || img.files.thumbnail;

    const originalName = img.files.original || '';
    const dotIdx = originalName.lastIndexOf('.');
    const originalType = dotIdx > -1 ? originalName.slice(dotIdx + 1).toUpperCase() : '';

    const sched = scheduledRecordFor(img);
    const metaParts = {
        dim: '',
        type: originalType ? `Original: ${originalType}` : '',
        size: formatBytes(img.size),
        date: formatDate(img.last_modified),
        sched: sched ? `⏳ Deletes ${formatWhen(sched.due_at)}` : '',
    };
    const renderMeta = () => {
        modalMeta.textContent = [metaParts.dim, metaParts.type, metaParts.size, metaParts.date, metaParts.sched]
            .filter(Boolean)
            .join(' • ');
    };

    // Show a "Cancel deletion" button only when this item has a pending schedule.
    modalCancelScheduleBtn.classList.toggle('hidden', !sched);
    modalCancelScheduleBtn.onclick = sched
        ? async () => { closeModal(); await cancelScheduledDelete(sched.id, img.slug); }
        : null;

    // Clear previous image
    modalImage.src = '';
    renderMeta();
    // Set to new image
    modalImage.src = getPublicUrl(state.prefix + previewKey);
    modalImage.onload = () => {
        if (modalImage.naturalWidth && modalImage.naturalHeight) {
            metaParts.dim = `${modalImage.naturalWidth} × ${modalImage.naturalHeight}`;
            renderMeta();
        }
    };
    modalTitle.textContent = img.slug;

    modalCopyIdBtn.onclick = async () => {
        const ok = await copyToClipboard(img.slug);
        toast(ok ? `Copied ${img.slug}` : 'Copy failed', ok ? 'success' : 'error');
    };

    // Captured now: state.prefix can change while the modal is open (popstate),
    // and this URL must keep matching the item on display.
    const origUrl = getPublicUrl(state.prefix + origKey);
    modalCopyUrlBtn.onclick = async () => {
        const ok = await copyToClipboard(origUrl);
        toast(ok ? 'Copied public URL' : 'Copy failed', ok ? 'success' : 'error');
    };

    modalOrigLink.href = origUrl;
    modalOrigLink.style.display = img.files.original ? 'inline-flex' : 'none';

    modalPrevLink.href = getPublicUrl(state.prefix + img.files.preview);
    modalPrevLink.style.display = img.files.preview ? 'inline-flex' : 'none';

    // Delete action removes all associated files in one bulk request
    modalDelBtn.onclick = async () => {
        const choice = await confirmAction({
            title: 'Delete file',
            message: `Delete ${img.slug} and all its variants?`,
            confirmText: 'Delete',
            withDelay: true,
        });
        if (!choice.confirmed) return;

        const keys = [img.files.original, img.files.preview, img.files.thumbnail]
            .filter(Boolean)
            .map(k => state.prefix + k);

        closeModal();
        if (choice.delaySeconds > 0) {
            await scheduleDelete(keys, choice.delaySeconds, img.slug);
            fetchContent();
            return;
        }
        try {
            const res = await apiFetch(`${BASE_PATH}api/content/bulk-delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.errors && data.errors.length) {
                toast(`Deleted ${data.deleted.length} of ${keys.length} files`, 'error');
            } else {
                toast(`Deleted ${img.slug}`, 'success');
            }
        } catch (err) {
            console.error(err);
            toast('Delete failed', 'error');
        }
        fetchContent();
    };

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

async function deleteItem(item) {
    const choice = await confirmAction({
        title: 'Delete file',
        message: `Delete ${item.filename}?`,
        confirmText: 'Delete',
        withDelay: true,
    });
    if (!choice.confirmed) return;
    if (choice.delaySeconds > 0) {
        await scheduleDelete([item.key], choice.delaySeconds, item.filename);
        fetchContent();
        return;
    }
    try {
        const res = await apiFetch(`${BASE_PATH}api/content?key=${encodeURIComponent(item.key)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        toast(`Deleted ${item.filename}`, 'success');
        fetchContent();
    } catch (err) {
        console.error(err);
        toast('Delete failed', 'error');
    }
}

// ---------------- Scheduled (delayed) deletion ----------------

async function scheduleDelete(keys, delaySeconds, label) {
    try {
        const res = await apiFetch(`${BASE_PATH}api/content/schedule-delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys, delay_seconds: delaySeconds, label, prefix: state.prefix }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        toast(`${label} will be deleted ${formatWhen(data.due_at)}`, 'success');
    } catch (e) {
        if (e.message !== 'Unauthorized') toast(`Schedule failed: ${e.message}`, 'error');
    }
}

async function cancelScheduledDelete(id, label) {
    try {
        const res = await apiFetch(`${BASE_PATH}api/scheduled-deletes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Cancelled scheduled deletion${label ? ` of ${label}` : ''}`, 'success');
        fetchContent();
    } catch (e) {
        if (e.message !== 'Unauthorized') toast(`Cancel failed: ${e.message}`, 'error');
    }
}

// Load pending scheduled deletions for the current prefix into a key -> record map.
async function loadScheduledDeletes() {
    state.scheduledByKey = new Map();
    try {
        const res = await apiFetch(`${BASE_PATH}api/scheduled-deletes?prefix=${encodeURIComponent(state.prefix)}`);
        if (!res.ok) return;
        const data = await res.json();
        for (const rec of data.scheduled || []) {
            for (const k of rec.keys || []) state.scheduledByKey.set(k, rec);
        }
    } catch (_) { /* non-fatal: badges just won't show */ }
}

// The R2 keys an item maps to (media items carry `files`, others carry `key`).
function itemKeys(item) {
    if (item.files) {
        return [item.files.original, item.files.preview, item.files.thumbnail]
            .filter(Boolean)
            .map(k => state.prefix + k);
    }
    return item.key ? [item.key] : [];
}

function scheduledRecordFor(item) {
    const map = state.scheduledByKey;
    if (!map) return null;
    for (const k of itemKeys(item)) {
        const rec = map.get(k);
        if (rec) return rec;
    }
    return null;
}

function formatWhen(iso) {
    if (!iso) return 'later';
    const d = new Date(iso);
    if (isNaN(d)) return 'later';
    return `on ${d.toLocaleString()}`;
}

// Compact remaining time, e.g. "3h", "2d", used for badges.
function remainingShort(iso) {
    const ms = new Date(iso) - new Date();
    if (isNaN(ms) || ms <= 0) return 'soon';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
}

// Upload Handling
async function handleFiles(files) {
    uploadProgress.classList.remove('hidden');
    progressText.textContent = `Uploading 0 / ${files.length}`;

    let successCount = 0;
    const uploadResults = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append('prefix', state.prefix);
        formData.append('file', file);

        try {
            progressFill.style.width = `${((i) / files.length) * 100}%`;
            progressText.textContent = `Uploading ${i + 1} / ${files.length}: ${file.name}`;

            const res = await apiFetch(`${BASE_PATH}api/upload`, {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                successCount++;
                const data = await res.json();
                uploadResults.push({ ...data, original_name: file.name });
            } else {
                let errorMessage = `HTTP Error ${res.status}`;
                try {
                    const data = await res.json();
                    if (data.detail) {
                        errorMessage = data.detail;
                    }
                } catch (e) { /* ignore parse error */ }

                uploadResults.push({
                    status: 'error',
                    original_name: file.name,
                    error_message: errorMessage
                });
                console.error(`Failed to upload ${file.name}`, errorMessage);
            }
        } catch (err) {
            uploadResults.push({
                status: 'error',
                original_name: file.name,
                error_message: err.message || 'Network error'
            });
            console.error(`Error uploading ${file.name}`, err);
        }
    }

    progressFill.style.width = '100%';
    progressText.textContent = `Complete! ${successCount} successful, ${files.length - successCount} failed.`;

    setTimeout(() => {
        uploadProgress.classList.add('hidden');
        progressFill.style.width = '0%';
        fetchContent();
        if (uploadResults.length > 0) {
            showUploadResults(uploadResults);
        }
    }, 1500);
}

function showUploadResults(results) {
    resultsList.innerHTML = '';

    results.forEach(res => {
        const div = document.createElement('div');
        div.className = 'upload-result-item';
        div.style.padding = '1rem';
        div.style.background = 'var(--glass-bg)';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid var(--glass-border)';
        div.style.transition = 'all 0.3s ease';

        if (res.status === 'error') {
            div.style.border = '1px solid var(--danger)';
            div.style.background = 'rgba(239, 68, 68, 0.1)';
            div.innerHTML = `
                <strong style="color: var(--danger); display:block; margin-bottom:0.5rem;">Failed to upload <span>${escapeHtml(res.original_name)}</span></strong>
                <div style="font-size: 0.85rem; color: var(--text-muted);">
                    <div><span style="color:var(--text-main);">Error:</span> ${escapeHtml(res.error_message)}</div>
                </div>
            `;
        } else if (res.type === 'image' || res.type === 'video') {
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                    <strong style="color: var(--primary);">${escapeHtml(res.slug)}</strong>
                    <button class="btn secondary-btn copy-id-btn" data-id="${escapeHtml(res.slug)}" title="Copy ID" style="padding: 0.25rem 0.5rem;">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-muted); display:flex; flex-direction:column; gap:0.25rem;">
                    <div><span style="color:var(--text-main);">Original:</span> ${escapeHtml(res.original_name)} -> ${escapeHtml(res.original)}</div>
                    <div><span style="color:var(--text-main);">Preview:</span> ${escapeHtml(res.preview)}</div>
                    <div><span style="color:var(--text-main);">Thumbnail:</span> ${escapeHtml(res.thumbnail)}</div>
                </div>
            `;
        } else {
            const displayName = res.original_name ? res.original_name : res.key.split('/').pop();
            div.innerHTML = `
                <strong style="color: var(--accent-1); display:block; margin-bottom:0.5rem;">${escapeHtml(displayName)}</strong>
                <div style="font-size: 0.85rem; color: var(--text-muted);">
                    <div><span style="color:var(--text-main);">Path:</span> ${escapeHtml(res.key)}</div>
                </div>
            `;
        }
        resultsList.appendChild(div);
    });

    resultsModal.classList.remove('hidden');

    // Wire up copy buttons
    resultsList.querySelectorAll('.copy-id-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const textToCopy = btn.dataset.id;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(textToCopy);
            } else {
                // Fallback for non-secure contexts
                const textArea = document.createElement("textarea");
                textArea.value = textToCopy;
                // Avoid scrolling to bottom
                textArea.style.top = "0";
                textArea.style.left = "0";
                textArea.style.position = "fixed";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                } catch (err) {
                    console.error('Fallback: Oops, unable to copy', err);
                }
                document.body.removeChild(textArea);
            }

            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

            const parentItem = btn.closest('.upload-result-item');
            if (parentItem) {
                parentItem.style.background = 'rgba(52, 211, 153, 0.2)';
                parentItem.style.borderColor = 'rgba(52, 211, 153, 0.5)';
                setTimeout(() => {
                    btn.innerHTML = originalHTML;
                }, 1500);
            } else {
                setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
            }
        });
    });
}
