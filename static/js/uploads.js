// Upload queue + the bottom-right uploads tray. Two uploads run at a time,
// each with byte-level progress via XMLHttpRequest; results stay in the tray
// (with Copy ID) until the user clears them.

import { el, icon, api, getApiKey, requireLogin, ApiError, fmt, detailFrom, extOf, copyText } from './common.js';
import { toast } from './ui.js';

const CONCURRENCY = 2;

// Resolves with the parsed JSON body of POST /api/upload. Rejects with ApiError
// (status 0 = network), or an AbortError-shaped error when cancelled.
export function uploadFile(file, { prefix, overrideFilename = null, onProgress = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const form = new FormData();
        form.append('prefix', prefix);
        form.append('file', file, file.name);
        if (overrideFilename) form.append('override_filename', overrideFilename);
        xhr.open('POST', api('upload'));
        const key = getApiKey();
        if (key) xhr.setRequestHeader('X-API-KEY', key);
        xhr.responseType = 'text';
        xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
            let body = null;
            try { body = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { body = null; }
            if (xhr.status >= 200 && xhr.status < 300) resolve(body || {});
            else reject(new ApiError(xhr.status, detailFrom(body, `HTTP ${xhr.status}`), body));
        };
        xhr.onerror = () => reject(new ApiError(0, 'Network error'));
        xhr.onabort = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); };
        if (signal) {
            if (signal.aborted) { xhr.abort(); return; }
            signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }
        xhr.send(form);
    });
}

let nextId = 1;

// createUploader({getPrefix, thumbUrl(prefix, result), onDone(item), onDrained()})
export function createUploader({ getPrefix, thumbUrl = () => '', onDone = () => {}, onDrained = () => {} }) {
    const tray = document.getElementById('uploads-tray');
    const list = document.getElementById('tray-list');
    const summary = document.getElementById('tray-summary');
    const copyAllBtn = document.getElementById('tray-copy-all');
    const cancelAllBtn = document.getElementById('tray-cancel-all');
    const toggleBtn = document.getElementById('tray-toggle');
    const clearBtn = document.getElementById('tray-clear');
    const items = [];
    let running = 0;

    const isActive = (it) => it.status === 'queued' || it.status === 'uploading' || it.status === 'processing';
    // Once the whole body has been sent the server will finish regardless, so
    // only queued/uploading items can genuinely be cancelled.
    const isCancellable = (it) => it.status === 'queued' || it.status === 'uploading';

    function add(files, { overrideFilename = null } = {}) {
        const prefix = getPrefix();
        for (const file of files) {
            const it = { id: nextId++, file, name: file.name, size: file.size, status: 'queued', pct: 0, prefix, overrideFilename, result: null, detail: '', controller: null, node: null, copied: false };
            items.push(it);
            it.node = renderRow(it);
            list.prepend(it.node);
        }
        tray.hidden = false;
        tray.classList.remove('is-collapsed');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
        renderSummary();
        pump();
    }

    function pump() {
        while (running < CONCURRENCY) {
            const next = items.find(it => it.status === 'queued');
            if (!next) break;
            run(next);
        }
        if (running === 0 && !items.some(isActive)) onDrained();
    }

    async function run(it) {
        running++;
        it.status = 'uploading';
        it.pct = 0;
        it.controller = new AbortController();
        updateRow(it);
        try {
            const result = await uploadFile(it.file, {
                prefix: it.prefix,
                overrideFilename: it.overrideFilename,
                signal: it.controller.signal,
                onProgress: (p) => {
                    it.pct = Math.round(p * 100);
                    if (it.pct >= 100 && it.status === 'uploading') it.status = 'processing';
                    updateRow(it);
                },
            });
            it.result = result;
            it.status = 'done';
            updateRow(it);
            announce(it);
            onDone(it);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                it.status = 'cancelled';
                announce(it);
            } else if (err instanceof ApiError && err.status === 401) {
                // Sign in, then put it back at the front of the queue.
                it.status = 'queued';
                it.pct = 0;
                updateRow(it);
                running--;
                try { await requireLogin(); } catch { /* login dialog dismissed */ }
                pump();
                return;
            } else {
                it.status = 'error';
                it.detail = (err && err.detail) || (err && err.message) || 'Upload failed';
                announce(it);
            }
            updateRow(it);
        } finally {
            it.controller = null;
        }
        running--;
        renderSummary();
        pump();
    }

    // The tray summary is the single live region: announce only terminal states,
    // never per-percent progress (the progressbar carries that silently).
    let announced = '';
    function announce(it) {
        announced = `${it.name}: ${statusText(it)}`;
        renderSummary();
    }

    function cancel(it) {
        if (it.status === 'queued') { it.status = 'cancelled'; announce(it); updateRow(it); renderSummary(); pump(); return; }
        if (it.status !== 'uploading') return;
        if (it.controller) it.controller.abort();
    }

    function retry(it) {
        if (it.status !== 'error' && it.status !== 'cancelled') return;
        it.status = 'queued';
        it.pct = 0;
        it.detail = '';
        updateRow(it);
        renderSummary();
        pump();
    }

    function clearFinished() {
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (isActive(it)) continue;
            it.node.remove();
            items.splice(i, 1);
        }
        renderSummary();
        if (!items.length) tray.hidden = true;
    }

    function slugOf(it) {
        const r = it.result;
        if (!r) return '';
        if (r.type === 'image' || r.type === 'video') return r.slug || '';
        return (r.key || '').split('/').pop();
    }

    const isMediaDone = (it) => it.status === 'done' && it.result && (it.result.type === 'image' || it.result.type === 'video');

    // Copying an ID marks its row so it is obvious which IDs still need copying.
    async function copyId(it) {
        const ok = await copyText(slugOf(it));
        if (!ok) { toast('Copy failed. Your browser blocked clipboard access.', { tone: 'error' }); return; }
        it.copied = true;
        updateRow(it);
        renderSummary();
        const fresh = it.node && it.node.querySelector('.tray-row__actions .btn');
        if (fresh) fresh.focus({ preventScroll: true });
    }

    function renderSummary() {
        const total = items.length;
        const done = items.filter(it => it.status === 'done').length;
        const failed = items.filter(it => it.status === 'error').length;
        const cancelled = items.filter(it => it.status === 'cancelled').length;
        const active = items.filter(isActive).length;
        const parts = [];
        if (total) parts.push(`${done} of ${total} done`);
        if (active) parts.push(`${active} in progress`);
        if (failed) parts.push(`${failed} failed`);
        if (cancelled) parts.push(`${cancelled} cancelled`);
        const media = items.filter(isMediaDone);
        const uncopied = media.filter(it => !it.copied).length;
        if (media.length) parts.push(uncopied ? `${fmt.plural(uncopied, 'ID')} not copied yet` : 'all IDs copied');
        summary.textContent = announced ? `${parts.join(' · ')} — ${announced}` : parts.join(' · ');
        copyAllBtn.hidden = media.length < 2;
        copyAllBtn.textContent = uncopied && uncopied < media.length ? `Copy all IDs (${uncopied} left)` : 'Copy all IDs';
        cancelAllBtn.hidden = !items.some(isCancellable);
    }

    function statusText(it) {
        switch (it.status) {
            case 'queued': return 'Queued';
            case 'uploading': return `Uploading ${it.pct}%`;
            case 'processing': return 'Processing…';
            case 'cancelled': return 'Cancelled';
            case 'error': return `Failed: ${it.detail}`;
            case 'done': {
                const r = it.result || {};
                if (it.overrideFilename) return `Replaced ${it.prefix}${it.overrideFilename}`;
                if (r.type === 'image' || r.type === 'video') return `Done · ${r.slug}`;
                return `Done · ${r.key || ''}`;
            }
            default: return '';
        }
    }

    function renderRow(it) {
        const thumb = el('span', { class: 'tray-row__thumb' }, icon(extOf(it.name) && /\.(mp4|mov|webm|mkv|avi)$/i.test(it.name) ? 'video' : 'file'));
        const row = el('div', { class: 'tray-row', dataset: { id: String(it.id) } },
            thumb,
            el('div', { class: 'tray-row__main' },
                el('div', { class: 'tray-row__name', title: it.name, text: it.name }),
                el('div', { class: 'tray-row__status' }, el('span', { class: 'tray-row__size', text: fmt.bytes(it.size) }), el('span', { class: 'tray-row__state' })),
            ),
            el('div', { class: 'tray-row__actions' }),
            el('div', { class: 'tray-row__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': `Upload progress for ${it.name}` }),
        );
        updateRow(it, row);
        return row;
    }

    function updateRow(it, row = it.node) {
        if (!row) return;
        row.className = `tray-row tray-row--${it.status}${it.copied ? ' tray-row--copied' : ''}`;
        row.querySelector('.tray-row__state').textContent = statusText(it);
        const mark = row.querySelector('.tray-row__copied');
        if (it.copied && !mark) row.querySelector('.tray-row__status').append(el('span', { class: 'chip chip--success tray-row__copied' }, icon('check'), 'copied'));
        else if (!it.copied && mark) mark.remove();
        const bar = row.querySelector('.tray-row__bar');
        bar.style.setProperty('--pct', String(it.status === 'done' ? 100 : it.pct));
        bar.setAttribute('aria-valuenow', String(it.status === 'done' ? 100 : it.pct));
        bar.hidden = it.status === 'done' || it.status === 'error' || it.status === 'cancelled';
        const actions = row.querySelector('.tray-row__actions');
        actions.replaceChildren();
        if (isCancellable(it)) {
            actions.append(el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--ghost', 'aria-label': `Cancel upload of ${it.name}`, onclick: () => cancel(it) }, icon('x')));
        } else if (it.status === 'error' || it.status === 'cancelled') {
            actions.append(el('button', { type: 'button', class: 'btn btn--sm', onclick: () => retry(it) }, 'Retry'));
        } else if (it.status === 'done') {
            const r = it.result || {};
            if (r.type === 'image' || r.type === 'video') {
                const url = thumbUrl(it.prefix, r);
                if (url) {
                    const t = row.querySelector('.tray-row__thumb');
                    t.replaceChildren(el('img', { src: url, alt: '', loading: 'lazy' }));
                }
                const slug = slugOf(it);
                const btn = el('button', {
                    type: 'button', class: `btn btn--sm${it.copied ? ' btn--ghost' : ''}`,
                    'aria-label': it.copied ? `Copy ID ${slug} again` : `Copy ID ${slug}`, 'aria-pressed': it.copied ? 'true' : 'false',
                }, icon(it.copied ? 'check' : 'copy'), el('span', { class: 'btn__label', text: it.copied ? 'Copied' : 'Copy ID' }));
                btn.addEventListener('click', () => copyId(it));
                actions.append(btn);
            }
        }
    }

    copyAllBtn.addEventListener('click', async () => {
        const media = items.filter(isMediaDone);
        const ok = await copyText(media.map(slugOf).join('\n'));
        if (!ok) { toast('Copy failed. Your browser blocked clipboard access.', { tone: 'error' }); return; }
        media.forEach(it => { it.copied = true; updateRow(it); });
        renderSummary();
        toast(`Copied ${fmt.plural(media.length, 'ID')}, one per line`, { tone: 'success', duration: 2500 });
    });
    cancelAllBtn.addEventListener('click', () => { items.filter(isCancellable).forEach(cancel); });
    clearBtn.addEventListener('click', clearFinished);
    toggleBtn.addEventListener('click', () => {
        const collapsed = tray.classList.toggle('is-collapsed');
        toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', collapsed ? 'Expand uploads' : 'Collapse uploads');
        toggleBtn.querySelector('use').setAttribute('href', collapsed ? '#i-chevron-up' : '#i-chevron-down');
    });

    window.addEventListener('beforeunload', (e) => {
        if (items.some(isActive)) { e.preventDefault(); e.returnValue = ''; }
    });

    return { add, cancel, retry, clearFinished, items, hasActive: () => items.some(isActive) };
}

// Client-side guard for the replace path: the new file must keep the extension
// and must not be an image/video (those go through the converter, not overwrite).
export function replaceProblem(targetName, file) {
    const want = extOf(targetName);
    const got = extOf(file.name);
    if (want && got !== want) return `Choose a ${want} file to replace ${targetName}.`;
    if (/^(image|video)\//.test(file.type || '')) return `${file.name} is media; it would be converted and stored under a new ID instead of replacing ${targetName}.`;
    return null;
}

export { toast as _toast };
