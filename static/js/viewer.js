// In-app file viewer for CSV/TSV (as a sortable, searchable table) and other
// text files. Lives at the page level (#viewer replaces #content) so the app
// bar stays usable, the phone back gesture closes it, and dialogs stack on top.

import { el, icon, ApiError, fmt, timeEl, keys, setUrlState, store, extOf, TABLE_EXTENSIONS, debounce, srOnly } from './common.js';
import { toast, copyWithFeedback, infoDialog } from './ui.js';

const SEEN_KEY = 'cm_seen';
const URL_RE = /^https?:\/\/\S+$/i;
const CHUNK = 500;

// createViewer({root, contentEl, getPrefix, getFileInfo(filename) -> {key, size, last_modified, sheet_url, isDataFile, publicUrl} | null,
//   fetchPreview(key, {force, signal}) -> Promise<preview>, onSync(filename, button) -> Promise, onClosed()})
export function createViewer({ root, contentEl, getPrefix, getFileInfo, fetchPreview, onSync = null, onClosed = () => {} }) {
    let current = null;        // { filename, key, info, preview, pushed, restoreTo, ac, end }
    let closing = false;
    let seq = 0;
    let wrap = store.get('cm_wrap', false);

    const seen = () => store.get(SEEN_KEY, {}) || {};
    const remember = (key, preview) => {
        const all = seen();
        all[key] = { etag: preview.etag, total_rows: preview.total_rows ?? null, total_chars: preview.total_chars ?? null, at: Date.now() };
        const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 50);
        store.set(SEEN_KEY, Object.fromEntries(entries));
    };

    function isOpen() { return !!current; }
    function currentFile() { return current ? current.filename : null; }

    // Opens the viewer for `filename` in the current prefix.
    async function open(filename, { end = false, push = true, restoreTo = null, force = false } = {}) {
        const info = getFileInfo(filename);
        const key = info ? info.key : getPrefix() + filename;
        const mySeq = ++seq;
        if (current && current.ac) current.ac.abort();
        const wasOpen = !!current;
        current = {
            filename, key, info, preview: null,
            pushed: wasOpen ? current.pushed : push,
            restoreTo: restoreTo || (current && current.restoreTo) || null,
            ac: new AbortController(), end,
        };
        if (!wasOpen) {
            contentEl.hidden = true;
            root.hidden = false;
        }
        if (push && !wasOpen) setUrlState({ view: filename }, { push: true });
        else setUrlState({ view: filename });
        document.title = `${filename} — Content Manager`;
        renderBar();
        renderLoading();
        window.scrollTo({ top: 0 });
        try {
            const preview = await fetchPreview(key, { force, signal: current.ac.signal });
            if (mySeq !== seq) return;
            current.preview = preview;
            renderBar();
            renderBody();
            // Tables longer than one chunk scroll themselves once the last chunk lands.
            if (end && !building) goToEnd();
            remember(key, preview);
        } catch (err) {
            if (mySeq !== seq || (err && err.name === 'AbortError')) return;
            renderError(err);
        }
    }

    function close({ fromHistory = false } = {}) {
        if (!current || closing) return;
        const { pushed, restoreTo, ac } = current;
        if (ac) ac.abort();
        current = null;
        tbody = null;
        table = null;
        building = false;
        root.hidden = true;
        root.replaceChildren();
        contentEl.hidden = false;
        document.title = 'Files — Content Manager';
        if (!fromHistory) {
            if (pushed) {
                closing = true;
                history.back();
                // popstate arrives asynchronously; guard against a double close.
                setTimeout(() => { closing = false; }, 0);
            } else {
                setUrlState({ view: null });
            }
        }
        if (restoreTo && restoreTo.isConnected) restoreTo.focus({ preventScroll: true });
        onClosed();
    }

    // Called by the page after a sync or replace changed the file behind an open viewer.
    function refreshIfOpen(filename) {
        if (current && current.filename === filename) open(filename, { push: false, force: true });
    }

    // ------------------------------------------------------------ rendering

    function renderBar() {
        const { filename, info, preview } = current;
        const ext = extOf(filename);
        const isTable = preview ? preview.kind === 'table' : TABLE_EXTENSIONS.has(ext);
        const isData = !!(info && info.isDataFile);
        const sheetUrl = info && info.sheet_url;
        const publicUrl = info && info.publicUrl;

        const meta = el('div', { class: 'viewer__meta' });
        if (preview) {
            if (preview.kind === 'table') meta.append(el('span', null, `${fmt.int(preview.total_rows)} rows × ${preview.header.length} cols`));
            else meta.append(el('span', null, `${fmt.int(preview.total_chars)} chars`));
            meta.append(el('span', null, fmt.bytes(preview.size)));
            if (preview.last_modified) meta.append(el('span', null, 'modified ', timeEl(preview.last_modified, { relative: false })));
            if (preview.etag) meta.append(el('span', { title: `etag ${preview.etag}` }, `etag ${preview.etag.slice(0, 8)}`));
            const prev = seen()[current.key];
            if (prev && prev.etag) {
                if (prev.etag === preview.etag) meta.append(el('span', { class: 'chip', title: 'Same etag as when you last viewed it' }, 'unchanged since last view'));
                else if (preview.kind === 'table' && prev.total_rows != null) {
                    const d = preview.total_rows - prev.total_rows;
                    meta.append(el('span', { class: `chip ${d < 0 ? 'chip--warn' : 'chip--success'}`, title: 'Compared with when you last viewed it' }, `${d >= 0 ? '+' : ''}${fmt.int(d)} rows since last view`));
                } else meta.append(el('span', { class: 'chip chip--info' }, 'changed since last view'));
            }
            if (preview.encoding && preview.encoding !== 'utf-8') meta.append(el('span', { class: 'chip chip--warn' }, preview.encoding));
        } else if (info) {
            if (info.size != null) meta.append(el('span', null, fmt.bytes(info.size)));
            if (info.last_modified) meta.append(el('span', null, 'modified ', timeEl(info.last_modified, { relative: false })));
        }

        const line1 = el('div', { class: 'viewer__line' },
            el('button', { type: 'button', class: 'btn btn--sm', onclick: () => close(), 'aria-label': 'Back to files' }, icon('arrow-left'), el('span', { class: 'btn__label', text: 'Back' })),
            el('h2', { class: 'viewer__title', id: 'viewer-title' }, icon(isTable ? 'table' : 'file-text'), el('span', { class: 'mono', text: filename })),
            meta,
        );

        const tools = el('div', { class: 'viewer__tools' });
        const findWrap = el('label', { class: 'field viewer__find' }, icon('search'), srOnly(isTable ? 'Find in rows' : 'Find in text'),
            el('input', { type: 'search', id: 'viewer-find', placeholder: isTable ? 'Find in rows…' : 'Find in text…', autocomplete: 'off', spellcheck: 'false', 'aria-controls': 'viewer-tbody' }));
        const count = el('span', { class: 'viewer__count', id: 'viewer-count', role: 'status', 'aria-live': 'polite' });
        const wrapBtn = el('button', { type: 'button', class: 'btn btn--sm', id: 'viewer-wrap', 'aria-pressed': wrap ? 'true' : 'false', title: 'Wrap long cells (w)', onclick: () => toggleWrap() }, 'Wrap');
        const endBtn = el('button', { type: 'button', class: 'btn btn--sm', title: 'Scroll to the last row (End)', onclick: () => goToEnd() }, icon('arrow-down'), el('span', { class: 'btn__label', text: 'End' }));
        const reloadBtn = el('button', { type: 'button', class: 'btn btn--sm', title: 'Re-read the file from the bucket', onclick: () => open(filename, { push: false, force: true }) }, icon('refresh'), el('span', { class: 'btn__label', text: 'Reload' }));
        tools.append(findWrap, count, wrapBtn, endBtn, reloadBtn);
        if (sheetUrl) tools.append(el('a', { class: 'btn btn--sm', href: sheetUrl, target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: 'btn__label', text: 'Open sheet' }), icon('ext'), srOnly('(opens in a new tab)')));
        if (isData && onSync) {
            const syncBtn = el('button', { type: 'button', class: 'btn btn--sm', title: 'Re-download this prefix’s data files from Google Sheets' }, icon('cloud-down'), el('span', { class: 'btn__label', text: 'Update' }));
            syncBtn.addEventListener('click', () => onSync(filename, syncBtn));
            tools.append(syncBtn);
        }
        if (publicUrl) {
            const copyBtn = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', title: publicUrl }, icon('link'), el('span', { class: 'btn__label', text: 'Copy URL' }));
            copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, publicUrl));
            tools.append(copyBtn,
                el('a', { class: 'btn btn--sm btn--ghost', href: publicUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Public CDN copy (may lag behind the bucket)' }, icon('download'), el('span', { class: 'btn__label', text: 'Download' }), srOnly('(opens in a new tab)')));
        }
        const line2 = el('div', { class: 'viewer__line' }, tools);
        const bar = el('div', { class: 'viewer__bar' }, line1, line2);

        const old = root.querySelector('.viewer__bar');
        if (old) old.replaceWith(bar); else root.prepend(bar);
        const find = bar.querySelector('#viewer-find');
        find.addEventListener('input', debounce(() => applyFind(find.value), 150));
        find.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); if (find.value) { find.value = ''; applyFind(''); } else find.blur(); }
        });
        if (!preview) { find.disabled = true; wrapBtn.disabled = true; endBtn.disabled = true; }
    }

    function bodyEl() {
        let b = root.querySelector('.viewer__body');
        if (!b) { b = el('div', { class: 'viewer__body' }); root.append(b); }
        return b;
    }

    function renderLoading() {
        const b = bodyEl();
        b.replaceChildren(...Array.from({ length: 8 }, () => el('div', { class: 'skeleton skeleton--row', 'aria-hidden': 'true' })));
        b.setAttribute('aria-busy', 'true');
    }

    function renderError(err) {
        const b = bodyEl();
        b.removeAttribute('aria-busy');
        const status = err instanceof ApiError ? err.status : 0;
        const detail = (err && err.detail) || (err && err.message) || 'Something went wrong';
        const info = current.info;
        const actions = [];
        const retry = el('button', { type: 'button', class: 'btn', onclick: () => open(current.filename, { push: false, force: true }) }, icon('refresh'), 'Retry');
        let title;
        if (status === 400) title = 'That is not a file';
        else if (status === 404) title = `${current.filename} is no longer in the bucket`;
        else if (status === 413) title = 'Too big to preview';
        else if (status === 415) title = 'No preview for this file';
        else if (status === 422) title = 'Could not parse this file';
        else if (status === 0) { title = 'Network error'; actions.push(retry); }
        else { title = `Could not load ${current.filename}`; actions.push(retry); }
        if (info && info.publicUrl && (status === 413 || status === 415 || status === 422)) {
            actions.push(el('a', { class: 'btn', href: info.publicUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('download'), 'Download'));
        }
        if (info && info.sheet_url && (status === 404 || status === 422)) {
            actions.push(el('a', { class: 'btn', href: info.sheet_url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sheet', icon('ext')));
        }
        if (status === 404 && info && info.isDataFile && onSync) {
            const b2 = el('button', { type: 'button', class: 'btn btn--primary' }, icon('cloud-down'), el('span', { class: 'btn__label', text: 'Update from spreadsheet' }));
            b2.addEventListener('click', () => onSync(current.filename, b2));
            actions.push(b2);
        }
        actions.push(el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => close() }, 'Back to files'));
        b.replaceChildren(el('div', { class: 'viewer__state' },
            icon('alert', 'icon--xl'),
            el('div', { class: 'empty__title', text: title }),
            el('p', { text: status === 400 || status === 404 ? '' : detail }),
            el('div', { class: 'btn-row' }, actions),
        ));
    }

    // ---- table

    let table = null, tbody = null, rowsData = [], header = [], sortState = { col: -1, dir: 0 }, visibleCount = 0, building = false;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    function renderBody() {
        const { preview } = current;
        const b = bodyEl();
        b.removeAttribute('aria-busy');
        b.replaceChildren();
        const notices = [];
        if (preview.truncated) {
            notices.push(el('div', { class: 'notice notice--warn', role: 'status' }, icon('alert'), el('div', { class: 'notice__body' },
                preview.kind === 'table'
                    ? `Showing the first ${fmt.int(preview.row_limit)} of ${fmt.int(preview.total_rows)} rows. Sort and find only cover the loaded rows; download the file for the rest.`
                    : `Showing the first ${fmt.bytes(preview.text.length)} of ${fmt.int(preview.total_chars)} characters. Download the file for the rest.`)));
        }
        if (preview.kind === 'table') {
            const hint = el('p', { class: 'form-hint' }, 'Click a cell to expand it, a column name to sort, or a row number to see the whole row.');
            b.append(...notices, buildTable(preview), hint);
        } else {
            tbody = null;
            table = null;
            building = false;
            b.append(...notices, buildText(preview));
        }
        const find = root.querySelector('#viewer-find');
        if (find) { find.disabled = false; find.value = ''; }
        root.querySelectorAll('.viewer__tools .btn[disabled]').forEach(x => { x.disabled = false; });
        updateCount();
    }

    function buildTable(preview) {
        header = preview.header.length ? preview.header.slice() : [];
        rowsData = preview.rows;
        const width = Math.max(header.length, ...rowsData.slice(0, 200).map(r => r.length));
        while (header.length < width) header.push(`Column ${header.length + 1}`);
        sortState = { col: -1, dir: 0 };

        table = el('table', { class: `table${wrap ? ' table--wrap' : ''}` });
        table.append(el('caption', { class: 'visually-hidden', text: `${current.filename}: ${fmt.int(preview.total_rows)} rows and ${header.length} columns` }));

        // Column widths measured from the first 200 rows so sort/find never re-run auto layout.
        const colgroup = el('colgroup');
        colgroup.append(el('col', { style: { width: '6ch' } }));
        header.forEach((h, c) => {
            let max = h.length;
            for (let i = 0; i < Math.min(rowsData.length, 200); i++) {
                const v = rowsData[i][c];
                if (v && v.length > max) max = Math.min(v.length, 60);
            }
            colgroup.append(el('col', { style: { width: `${Math.min(Math.max(8, max + 2), 32)}ch` } }));
        });
        table.append(colgroup);

        const thead = el('thead');
        const tr = el('tr');
        tr.append(el('th', { scope: 'col', class: 'cell--num', title: 'Data row number. Blank sheet rows are skipped, so the sheet row may be higher.' }, srOnly('Row')));
        header.forEach((h, c) => {
            const th = el('th', { scope: 'col', 'aria-sort': 'none', title: h });
            th.append(el('button', { type: 'button', class: 'th-btn', onclick: () => sortBy(c) }, el('span', { text: h }), icon('chevron-up')));
            tr.append(th);
        });
        thead.append(tr);
        tbody = el('tbody', { id: 'viewer-tbody' });
        table.append(thead, tbody);

        // Build rows in chunks so a 5000-row file never blocks the main thread for
        // long. The chain is bound to this table: a newer open() (or close) makes
        // it stop, and the completion step re-applies any sort/find made meanwhile.
        const myTbody = tbody, myRows = rowsData, myHeader = header;
        let i = 0;
        const total = myRows.length;
        building = total > CHUNK;
        const buildChunk = () => {
            if (tbody !== myTbody || !current) return;
            const frag = document.createDocumentFragment();
            const end = Math.min(i + CHUNK, total);
            for (; i < end; i++) frag.append(buildRow(myRows[i], i, myHeader));
            myTbody.append(frag);
            if (i < total) { requestAnimationFrame(buildChunk); return; }
            building = false;
            if (sortState.dir) applySort();
            const find = root.querySelector('#viewer-find');
            applyFind(find ? find.value : '');
            if (current.end) goToEnd();
        };
        buildChunk();

        const scroll = el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-labelledby': 'viewer-title' }, table);
        scroll.addEventListener('click', onTableClick);
        return scroll;
    }

    function buildRow(cells, i, hdr) {
        const tr = el('tr', { dataset: { i: String(i) } });
        tr.dataset.q = cells.join('').toLowerCase();
        tr.append(el('td', { class: 'cell--num' }, el('button', { type: 'button', class: 'rownum', title: 'Show this row', 'aria-label': `Row ${i + 1}` }, String(i + 1))));
        for (let c = 0; c < hdr.length; c++) {
            const v = cells[c] == null ? '' : cells[c];
            const td = el('td');
            if (v === '') { td.className = 'cell--empty'; td.textContent = '—'; }
            else if (URL_RE.test(v)) {
                td.className = 'cell--link';
                const label = v.replace(/\/+$/, '').split('/').pop() || v;
                td.append(el('a', { href: v, target: '_blank', rel: 'noopener noreferrer', title: v }, label));
            } else {
                if (v.length > 24 || v.includes('\n')) td.className = 'cell--expandable';
                setCellText(td, v, false);
            }
            tr.append(td);
        }
        return tr;
    }

    function setCellText(td, v, expanded) {
        if (expanded || !v.includes('\n')) { td.textContent = v; return; }
        td.replaceChildren();
        v.split('\n').forEach((p, i) => {
            if (i > 0) td.append(el('span', { class: 'nl', 'aria-hidden': 'true' }, ' ↵ '));
            td.append(p);
        });
    }

    function onTableClick(e) {
        const rownum = e.target.closest('.rownum');
        if (rownum) { showRow(Number(rownum.closest('tr').dataset.i)); return; }
        if (e.target.closest('a, button')) return;
        const td = e.target.closest('td');
        if (!td || td.classList.contains('cell--num') || !td.classList.contains('cell--expandable')) return;
        if (window.getSelection && String(window.getSelection()).length) return; // user is selecting text
        const tr = td.parentElement;
        const c = [...tr.children].indexOf(td) - 1;
        const v = rowsData[Number(tr.dataset.i)][c] || '';
        const expanded = td.classList.toggle('is-expanded');
        setCellText(td, v, expanded);
    }

    function showRow(i) {
        const cells = rowsData[i] || [];
        const dl = el('dl', { class: 'kv' });
        header.forEach((h, c) => {
            const v = cells[c] == null ? '' : cells[c];
            const dd = el('dd');
            if (v === '') dd.append(el('span', { class: 'muted', text: '—' }));
            else if (URL_RE.test(v)) dd.append(el('a', { href: v, target: '_blank', rel: 'noopener noreferrer' }, v));
            else dd.textContent = v;
            if (v !== '') {
                const cp = el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--ghost', 'aria-label': `Copy ${h}`, title: 'Copy value' }, icon('copy'));
                cp.addEventListener('click', () => copyWithFeedback(cp, v));
                dd.append(' ', cp);
            }
            dl.append(el('dt', { text: h }), dd);
        });
        const copyRow = el('button', { type: 'button', class: 'btn' }, icon('copy'), el('span', { class: 'btn__label', text: 'Copy row as TSV' }));
        copyRow.addEventListener('click', () => copyWithFeedback(copyRow, header.map((_, c) => (cells[c] == null ? '' : cells[c]).replace(/\t/g, ' ')).join('\t')));
        infoDialog({ title: `${current.filename} · row ${i + 1}`, content: dl, wide: true, actions: [copyRow] });
    }

    // Click on a column header: none → ascending → descending → none.
    function sortBy(c) {
        if (!tbody) return;
        const dir = sortState.col === c ? (sortState.dir === 1 ? -1 : sortState.dir === -1 ? 0 : 1) : 1;
        sortState = { col: dir === 0 ? -1 : c, dir };
        applySort();
        const scroll = root.querySelector('.table-scroll');
        if (scroll) scroll.scrollTop = 0;
    }

    // Re-orders the rows already in the table by sortState (original order when unset).
    function applySort() {
        if (!tbody || !table) return;
        const { col: c, dir } = sortState;
        table.querySelectorAll('thead th[aria-sort]').forEach((th, i) => {
            th.setAttribute('aria-sort', i === c && dir !== 0 ? (dir === 1 ? 'ascending' : 'descending') : 'none');
        });
        const trs = [...tbody.children];
        if (dir === 0) trs.sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
        else trs.sort((a, b) => {
            const va = rowsData[Number(a.dataset.i)][c] || '';
            const vb = rowsData[Number(b.dataset.i)][c] || '';
            if (va === '' && vb === '') return 0;
            if (va === '') return 1;   // empties last either direction
            if (vb === '') return -1;
            return dir * collator.compare(va, vb);
        });
        tbody.replaceChildren(...trs);
    }

    function applyFind(q) {
        const needle = (q || '').trim().toLowerCase();
        if (current && current.preview && current.preview.kind === 'text') { applyTextFind(needle); return; }
        if (!tbody) return;
        let n = 0;
        for (const tr of tbody.children) {
            const show = !needle || tr.dataset.q.includes(needle);
            tr.hidden = !show;
            if (show) n++;
        }
        visibleCount = n;
        updateCount(needle);
    }

    function updateCount(needle = '') {
        const c = root.querySelector('#viewer-count');
        if (!c || !current || !current.preview) return;
        const p = current.preview;
        if (p.kind === 'table') {
            const loaded = p.rows.length;
            c.textContent = needle ? `${fmt.int(visibleCount)} of ${fmt.int(loaded)} rows` : `${fmt.int(loaded)} rows${p.truncated ? ` of ${fmt.int(p.total_rows)}` : ''}`;
        } else {
            c.textContent = needle ? `${fmt.int(visibleCount)} matching lines` : `${fmt.int(p.text.split('\n').length)} lines`;
        }
    }

    function toggleWrap() {
        wrap = !wrap;
        store.set('cm_wrap', wrap);
        const btn = root.querySelector('#viewer-wrap');
        if (btn) btn.setAttribute('aria-pressed', wrap ? 'true' : 'false');
        if (table) table.classList.toggle('table--wrap', wrap);
        const code = root.querySelector('.code');
        if (code) code.classList.toggle('code--wrap', wrap);
    }

    function goToEnd() {
        const scroll = root.querySelector('.table-scroll, .code');
        if (!scroll) return;
        if (tbody) {
            const rows = [...tbody.children].filter(tr => !tr.hidden);
            const last = rows[rows.length - 1];
            scroll.scrollTop = scroll.scrollHeight;
            if (last) {
                last.classList.add('is-flash');
                setTimeout(() => last.classList.remove('is-flash'), 1500);
            }
        } else scroll.scrollTop = scroll.scrollHeight;
        if (current) current.end = false;
    }

    function goToTop() {
        const scroll = root.querySelector('.table-scroll, .code');
        if (scroll) scroll.scrollTop = 0;
    }

    // ---- text

    function buildText(preview) {
        let text = preview.text;
        const ext = extOf(current.filename);
        if (ext === '.json' && !preview.truncated) {
            try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw */ }
        }
        const pre = el('pre', { class: `code${wrap ? ' code--wrap' : ''}`, tabindex: '0' });
        const lines = text.split('\n');
        const frag = document.createDocumentFragment();
        // Block-level spans break lines on their own (and on copy); the real line
        // number rides on the element so hiding non-matching lines keeps it right.
        lines.forEach((line, i) => frag.append(el('span', { class: 'ln', dataset: { n: String(i + 1) } }, line || ' ')));
        pre.append(frag);
        visibleCount = lines.length;
        return pre;
    }

    function applyTextFind(needle) {
        const pre = root.querySelector('.code');
        if (!pre) return;
        let n = 0;
        for (const ln of pre.querySelectorAll('.ln')) {
            const raw = ln.textContent;
            if (!needle) { ln.textContent = raw; ln.hidden = false; n++; continue; }
            const idx = raw.toLowerCase().indexOf(needle);
            ln.hidden = idx < 0;
            if (idx < 0) { ln.textContent = raw; continue; }
            n++;
            ln.replaceChildren(raw.slice(0, idx), el('mark', { text: raw.slice(idx, idx + needle.length) }), raw.slice(idx + needle.length));
        }
        visibleCount = n;
        updateCount(needle);
    }

    // ------------------------------------------------------------ keys

    keys.on('Escape', () => {
        if (!isOpen()) return false;
        const find = root.querySelector('#viewer-find');
        if (find && find.value) { find.value = ''; applyFind(''); return; }
        close();
    });
    keys.on('w', () => { if (!isOpen()) return false; toggleWrap(); });
    keys.on('End', () => { if (!isOpen()) return false; goToEnd(); });
    keys.on('Home', () => { if (!isOpen()) return false; goToTop(); });
    keys.on('/', () => {
        if (!isOpen()) return false;
        const find = root.querySelector('#viewer-find');
        if (find) { find.focus(); find.select(); }
    });

    return { open, close, isOpen, currentFile, refreshIfOpen };
}
