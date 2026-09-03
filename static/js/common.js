// Shared plumbing for both pages: API access (with a login prompt on 401),
// formatting, keyboard shortcuts, URL state and small DOM helpers.
// No page-specific knowledge lives here.

// The app may be served under a subpath (e.g. /content-manager/), so derive the
// API base from the page URL rather than hard-coding "/".
export const BASE_PATH = new URL('.', location.href).pathname;
export const API_KEY_STORAGE = 'content_manager_api_key';

export class ApiError extends Error {
    constructor(status, detail, body = null) {
        super(detail || (status ? `HTTP ${status}` : 'Network error'));
        this.name = 'ApiError';
        this.status = status;
        this.detail = this.message;
        this.body = body;
    }
}

export function getApiKey() {
    try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch { return ''; }
}

export function setApiKey(key) {
    try { localStorage.setItem(API_KEY_STORAGE, key); } catch { /* storage unavailable */ }
}

// ui.js installs the real login dialog; until then a 401 simply rejects.
let loginPrompt = () => Promise.reject(new ApiError(401, 'Unauthorized'));
export function setLoginPrompt(fn) { loginPrompt = fn; }
export function requireLogin() { return loginPrompt(); }

export const api = (path) => BASE_PATH + 'api/' + String(path).replace(/^\/+/, '');

// fetch() with the API key attached. On 401 the user is asked to sign in and the
// request is retried once. Network failures become ApiError(0).
export async function apiFetch(path, options = {}, { retry = true } = {}) {
    const url = /^(https?:)?\/\//.test(path) || path.startsWith('/') ? path : api(path);
    const headers = new Headers(options.headers || {});
    const key = getApiKey();
    if (key) headers.set('X-API-KEY', key);
    let res;
    try {
        res = await fetch(url, { cache: 'no-store', ...options, headers });
    } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new ApiError(0, 'Network error');
    }
    if (res.status === 401 && retry) {
        await requireLogin();
        return apiFetch(path, options, { retry: false });
    }
    return res;
}

// FastAPI puts human-readable errors in `detail`; validation errors send a list.
export function detailFrom(body, fallback) {
    const d = body && body.detail;
    if (typeof d === 'string' && d) return d;
    if (Array.isArray(d)) return d.map(x => (x && x.msg) || JSON.stringify(x)).join('; ');
    if (d && typeof d === 'object') return JSON.stringify(d);
    return fallback;
}

// apiFetch + JSON parse; non-2xx becomes an ApiError carrying the server detail.
export async function apiJson(path, options, opts) {
    const res = await apiFetch(path, options, opts);
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }
    if (!res.ok) throw new ApiError(res.status, detailFrom(body, text.slice(0, 200) || `HTTP ${res.status}`), body);
    return body;
}

// ---------------------------------------------------------------- formatting

export function parseDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d;
}

const DATE_OPTS = { year: 'numeric', month: 'short', day: 'numeric' };
const DATETIME_OPTS = { ...DATE_OPTS, hour: '2-digit', minute: '2-digit' };

export const fmt = {
    bytes(n) {
        if (n == null || isNaN(n)) return '';
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
        return `${(n / 1073741824).toFixed(2)} GB`;
    },
    int(n) { return Number(n || 0).toLocaleString(); },
    date(iso) { const d = parseDate(iso); return d ? d.toLocaleDateString(undefined, DATE_OPTS) : ''; },
    dateTime(iso) { const d = parseDate(iso); return d ? d.toLocaleString(undefined, DATETIME_OPTS) : ''; },
    time(iso) { const d = parseDate(iso); return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''; },
    // "just now", "5 min ago", "3 h ago", "2 days ago", then the date itself.
    relative(iso) {
        const d = parseDate(iso);
        if (!d) return '';
        const secs = Math.round((Date.now() - d) / 1000);
        if (secs < 45) return 'just now';
        const mins = Math.round(secs / 60);
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs} h ago`;
        const days = Math.round(hrs / 24);
        if (days === 1) return 'yesterday';
        if (days < 31) return `${days} days ago`;
        return d.toLocaleDateString(undefined, DATE_OPTS);
    },
    // Compact time-until for badges: "45m", "3h", "2d".
    until(iso) {
        const d = parseDate(iso);
        if (!d) return '';
        const ms = d - Date.now();
        if (ms <= 0) return 'soon';
        const mins = Math.round(ms / 60000);
        if (mins < 60) return `${mins}m`;
        const hrs = Math.round(mins / 60);
        if (hrs < 48) return `${hrs}h`;
        return `${Math.round(hrs / 24)}d`;
    },
    untilLong(iso) {
        const d = parseDate(iso);
        if (!d) return '';
        const ms = d - Date.now();
        if (ms <= 0) return 'any moment now';
        const mins = Math.round(ms / 60000);
        if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
        const hrs = Math.round(mins / 60);
        if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
        const days = Math.round(hrs / 24);
        return `in ${days} day${days === 1 ? '' : 's'}`;
    },
    plural(n, one, many = `${one}s`) { return `${fmt.int(n)} ${n === 1 ? one : many}`; },
};

// Elements carrying data-relative / data-until refresh their text every minute.
export function tickTimes(root = document) {
    root.querySelectorAll('[data-relative]').forEach(el => { el.textContent = fmt.relative(el.dataset.relative); });
    root.querySelectorAll('[data-until]').forEach(el => { el.textContent = fmt.until(el.dataset.until); });
}
let tickerStarted = false;
export function startTicker() {
    if (tickerStarted) return;
    tickerStarted = true;
    setInterval(() => tickTimes(), 60000);
}

export function extOf(name) {
    const m = /\.([^./\\]+)$/.exec(name || '');
    return m ? '.' + m[1].toLowerCase() : '';
}

// Mirrors the server's preview support (_PREVIEW_TABLE_DELIMITERS + _PREVIEW_TEXT_EXTENSIONS).
export const TABLE_EXTENSIONS = new Set(['.csv', '.tsv']);
export const PREVIEWABLE_EXTENSIONS = new Set([
    '.csv', '.tsv', '.txt', '.text', '.md', '.markdown', '.json', '.jsonl', '.ndjson', '.xml', '.yaml', '.yml',
    '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.ini', '.cfg', '.toml', '.log', '.svg', '.py', '.sh', '.env',
]);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
export const PLAYABLE_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

// ---------------------------------------------------------------- URL state

export function urlParams() { return new URLSearchParams(location.search); }

// Update query params in place; push only when the caller says the change is a
// navigation (prefix/site), replace for view state (section, filter, viewer).
export function setUrlState(partial, { push = false } = {}) {
    const url = new URL(location.href);
    for (const [k, v] of Object.entries(partial)) {
        if (v == null || v === '') url.searchParams.delete(k);
        else url.searchParams.set(k, v);
    }
    if (url.href === location.href) return;
    if (push) history.pushState({}, '', url); else history.replaceState({}, '', url);
}

// ---------------------------------------------------------------- keyboard

const keyBindings = [];

export function isTypingTarget(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
export function dialogOpen() { return document.querySelector('dialog[open]'); }
export function popoverOpen() {
    try { return document.querySelector(':popover-open:not(.toasts)'); } catch { return null; }
}

function comboOf(e) {
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1 && /[a-z]/i.test(k)) k = k.toLowerCase();
    return (e.ctrlKey || e.metaKey ? 'Mod+' : '') + (e.altKey ? 'Alt+' : '') + k;
}

// keys.on('r', handler, {allowTyping, allowInDialog, allowInPopover, when})
// Handlers returning false leave the event alone; anything else preventDefaults it.
export const keys = {
    on(combo, handler, opts = {}) {
        const b = { combo, handler, ...opts };
        keyBindings.push(b);
        return () => { const i = keyBindings.indexOf(b); if (i >= 0) keyBindings.splice(i, 1); };
    },
};

document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    for (const b of keyBindings) {
        if (b.combo !== combo) continue;
        if (!b.allowTyping && isTypingTarget(e.target)) continue;
        if (!b.allowInDialog && dialogOpen()) continue;
        if (!b.allowInPopover && popoverOpen()) continue;
        if (b.when && !b.when(e)) continue;
        // A handler returning false declines the event so later bindings can try.
        if (b.handler(e) === false) continue;
        e.preventDefault();
        return;
    }
});

// ---------------------------------------------------------------- misc

export async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall back */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

export function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
};

export function publicUrl(prefixUrl, key) {
    const base = (prefixUrl || '').replace(/\/+$/, '');
    return base && key ? `${base}/${key}` : '';
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- DOM helpers

const SVG_NS = 'http://www.w3.org/2000/svg';

export function append(node, children) {
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

// el('button', {class: 'btn', onclick: fn, dataset: {key: 'x'}, 'aria-label': '…'}, child, …)
export function el(tag, attrs = null, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k === 'style' && typeof v === 'object') {
                for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
            }
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v === true) node.setAttribute(k, '');
            else node.setAttribute(k, v);
        }
    }
    return append(node, children);
}

export function icon(name, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

export function timeEl(iso, { relative = true, prefix = '' } = {}) {
    const t = el('time', { datetime: iso || null, title: fmt.dateTime(iso) });
    if (relative) { t.dataset.relative = iso || ''; t.textContent = prefix + fmt.relative(iso); }
    else t.textContent = prefix + fmt.dateTime(iso);
    return t;
}

export function srOnly(text) { return el('span', { class: 'visually-hidden', text }); }

export const FALLBACK_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
);

// Swap in the placeholder when a thumbnail fails to load (capture phase: error events do not bubble).
export function installImageFallback(root) {
    root.addEventListener('error', (e) => {
        const img = e.target;
        if (img && img.tagName === 'IMG' && !img.dataset.fallback) {
            img.dataset.fallback = '1';
            img.src = FALLBACK_IMG;
        }
    }, true);
}
