// Image-reference check: one notice in the data panel, under the update summary,
// saying whether every image the prefix's CSV/TSV files name is in the bucket. A
// site builds each image URL from a row's id and ext ({id}{ext}, {id}_p.webp,
// {id}_t.webp), so a mistyped extension in the sheet breaks the image without any
// error showing. The server checks what each Update from spreadsheet just wrote
// and sends the report back with the update (POST content/sync-csv); this draws it.

import { el, icon, fmt, srOnly } from './common.js';
import { copyWithFeedback } from './ui.js';

// A file with more problems than this lists them folded, so one badly broken
// sheet does not push the media a screen further down.
const FOLD_AFTER = 10;

// "a", "a and b", "a, b and c".
function listOf(items) {
    return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('');
}

// createDataCheck({root, hasImage(slug) -> bool, onOpenImage(slug)}) -> {show(report, error), clear()}
export function createDataCheck({ root, hasImage = () => false, onOpenImage = () => {} }) {
    let prefix = null;          // folder of the last report drawn
    let unusedOpen = false;     // the unused-images list stays open across that folder's updates
    const listsOpen = new Set();    // files whose folded problem list the user opened, likewise

    // The lead line is built once and never replaced.
    const glyph = icon('alert');
    const summary = el('span', { class: 'datacheck__summary' });
    const stamp = el('span', { class: 'muted' });
    const lead = el('div', { class: 'notice__line' }, summary, el('span', { class: 'datacheck__meta' }, stamp));
    const body = el('div', { class: 'notice__body' }, lead);
    root.replaceChildren(glyph, body,
        el('button', { type: 'button', class: 'btn btn--sm btn--icon btn--ghost notice__close', 'aria-label': 'Dismiss', onclick: clear }, icon('x')));
    // The verdict is announced from a live region of its own that stays rendered
    // while the notice is hidden: one inside the notice is hidden along with it
    // and misses the first result. It only ever holds the one-line verdict, so a
    // result is not read out problem by problem.
    const live = el('div', { class: 'visually-hidden', role: 'status' });
    root.after(live);

    // Draws the check an update brought back: its report, or, when the check
    // itself failed, why.
    function show(report, error = null) {
        if (report) render(report);
        else if (error) renderFailure(error);
        else clear();
    }

    // Hides the notice (an update is starting, the folder changed, or Dismiss).
    function clear() {
        root.hidden = true;
        summary.replaceChildren();
        live.textContent = '';
        replaceBelow([]);
    }

    // Swaps everything under the lead line.
    function replaceBelow(nodes) {
        while (lead.nextSibling) lead.nextSibling.remove();
        body.append(...nodes);
    }

    // ------------------------------------------------------------ rendering

    function setGlyph(name) {
        glyph.querySelector('use').setAttribute('href', `#i-${name}`);
    }

    function render(report) {
        const files = Array.isArray(report.files) ? report.files : [];
        const checked = files.filter(f => f.columns && f.columns.length);
        const unreadable = files.filter(f => f.error);
        // No data file names an image and none was unreadable: nothing to say.
        if (!checked.length && !unreadable.length) { clear(); return; }
        if (report.prefix !== prefix) {
            prefix = report.prefix;
            unusedOpen = false;
            listsOpen.clear();
        }
        const tone = report.errors ? 'danger' : unreadable.length ? 'warn' : 'success';
        root.className = `notice datacheck notice--${tone}`;
        setGlyph(tone === 'success' ? 'check-circle' : 'alert');
        summary.replaceChildren(...verdict(report, checked, unreadable));
        const at = report.checked_at || new Date().toISOString();
        stamp.replaceChildren('checked ', el('time', { datetime: at, title: fmt.dateTime(at) }, fmt.time(at)));
        stamp.hidden = false;
        const below = files.filter(f => f.error || (f.problems && f.problems.length)).map(f => fileSection(f, tone));
        if (report.unreferenced_count > 0) below.push(unusedList(report));
        replaceBelow(below);
        root.hidden = false;
        live.textContent = summary.textContent;
    }

    // The update itself went through; only the check did not.
    function renderFailure(error) {
        root.className = 'notice datacheck notice--warn';
        setGlyph('alert');
        summary.replaceChildren(el('strong', { text: 'Could not check image references' }), `: ${error}`);
        stamp.hidden = true;
        replaceBelow([]);
        root.hidden = false;
        live.textContent = summary.textContent;
    }

    // The one-line verdict. It is all a screen reader hears, so it must stand alone.
    function verdict(report, checked, unreadable) {
        const errors = report.errors || 0;
        const skipped = unreadable.length ? `${fmt.plural(unreadable.length, 'file')} not checked` : null;
        if (errors) {
            // Problems, not rows: one row can have two (a wrong ext and a missing
            // thumbnail), and a misspelt header is not a row at all.
            return [el('strong', { text: [fmt.plural(errors, 'image reference problem'), skipped].filter(Boolean).join(', ') }),
                ' — the site cannot load these images until the data is fixed.'];
        }
        if (unreadable.length) {
            return [el('strong', { text: `${fmt.plural(unreadable.length, 'data file')} could not be checked` }),
                ` — ${unreadable.length === 1 ? 'its' : 'their'} image references were not verified.`];
        }
        const counted = checked.filter(f => f.refs > 0);
        let detail;
        if (!counted.length) detail = ` — no row in ${listOf(checked.map(f => f.file))} names an image yet.`;
        else if (counted.length === 1 && counted[0].refs === 1) detail = ` — the one in ${counted[0].file} resolves.`;
        else detail = ` — all ${listOf(counted.map(f => `${fmt.int(f.refs)} in ${f.file}`))} resolve.`;
        return [el('strong', { text: 'Image references OK' }), detail];
    }

    function sheetLink(f) {
        if (!f.sheet_url) return null;
        return el('a', { class: 'btn btn--sm btn--ghost', href: f.sheet_url, target: '_blank', rel: 'noopener noreferrer', title: `Open the Google Sheet for ${f.file}` },
            el('span', { class: 'btn__label', text: 'Open sheet' }), icon('ext'), srOnly('(opens in a new tab)'));
    }

    function fileSection(f, tone) {
        if (f.error) {
            return el('div', { class: 'datacheck__file' },
                el('div', { class: `notice__line ${tone === 'danger' ? 'text-danger' : 'text-warn'}` },
                    icon('alert'), el('strong', { class: 'mono', text: f.file }), ` could not be checked: ${f.error}`, sheetLink(f)));
        }
        const problems = f.problems || [];
        const total = Math.max(f.problem_count || 0, problems.length);
        const list = el('ul', { class: 'datacheck__list', 'aria-label': `Problems in ${f.file}` }, problems.map(p => problemItem(p, f)));
        // The server lists the first 200 per file; the rest show up once these are
        // fixed and the next update checks again.
        if (total > problems.length) {
            list.append(el('li', { class: 'datacheck__more', text: `… and ${fmt.int(total - problems.length)} more. Fix these, then press Update from spreadsheet again to see the rest.` }));
        }
        // A header problem is not a reference, so a file can have problems and no references.
        const counts = f.refs ? `${fmt.plural(total, 'problem')} in ${fmt.plural(f.refs, 'reference')}` : fmt.plural(total, 'problem');
        return el('div', { class: 'datacheck__file' },
            el('div', { class: 'notice__line' },
                el('strong', { class: 'mono', text: f.file }),
                el('span', { class: 'muted', text: counts }),
                f.encoding && f.encoding !== 'utf-8' ? el('span', { class: 'chip chip--warn', text: f.encoding }) : null,
                sheetLink(f)),
            problems.length > FOLD_AFTER ? folded(f, list, problems.length) : list);
    }

    // A long list starts folded behind its count; one the user opened stays open
    // when the next update redraws it.
    function folded(f, list, n) {
        const details = el('details', { class: 'datacheck__problems', open: listsOpen.has(f.file) },
            el('summary', { text: `Show ${fmt.plural(n, 'problem')}` }), list);
        details.addEventListener('toggle', () => {
            if (!details.isConnected) return;
            if (details.open) listsOpen.add(f.file); else listsOpen.delete(f.file);
        });
        return details;
    }

    // Row numbers are sheet rows, so a synced file links straight to the cell to fix.
    function problemItem(p, f) {
        const column = p.column ? ` (${p.column})` : '';
        const row = f.sheet_url && p.cell
            ? el('a', { class: 'datacheck__row', href: `${f.sheet_url}&range=${encodeURIComponent(p.cell)}`, target: '_blank', rel: 'noopener noreferrer', title: `Open ${p.cell}${column} in the sheet` },
                `Row ${p.row}`, srOnly('(opens in a new tab)'))
            : el('span', { class: 'datacheck__row', title: p.column ? `Column ${p.column}` : null, text: `Row ${p.row}` });
        let id = null;
        if (p.id && hasImage(p.id)) id = el('button', { type: 'button', class: 'datacheck__id', title: 'Open the preview', 'aria-label': `Preview ${p.id}`, onclick: () => onOpenImage(p.id) }, p.id);
        else if (p.id) id = el('code', { class: 'datacheck__id', text: p.id });
        let fix = null;
        if (p.fix) {
            fix = el('button', { type: 'button', class: 'btn btn--sm btn--ghost', title: `Copy ${p.fix} to paste into ${p.cell || p.column || 'the cell'}` },
                icon('copy'), el('span', { class: 'btn__label', text: `Copy ${p.fix}` }));
            fix.addEventListener('click', () => copyWithFeedback(fix, p.fix));
        }
        return el('li', { class: 'datacheck__item' },
            icon('alert', 'text-danger'),
            el('div', { class: 'datacheck__what' },
                srOnly('Error:'), row, id, el('span', { class: 'datacheck__msg', text: p.message || '' }), fix));
    }

    // Images no data file names: leftovers, or the other half of a typo above.
    // Collapsed by default, since a folder can have hundreds.
    function unusedList(report) {
        const slugs = report.unreferenced || [];
        const n = report.unreferenced_count;
        const details = el('details', { class: 'datacheck__unused', open: unusedOpen },
            el('summary', null, `${fmt.plural(n, 'image')} in ${report.prefix} ${n === 1 ? 'is' : 'are'} not used by any data file`,
                slugs.length < n ? el('span', { class: 'muted', text: ` (the first ${fmt.int(slugs.length)} are listed)` }) : null),
            el('div', { class: 'datacheck__chips' }, slugs.map(slug => (hasImage(slug)
                ? el('button', { type: 'button', class: 'id-chip', title: 'Open the preview', 'aria-label': `Preview ${slug}`, onclick: () => onOpenImage(slug) }, el('code', { text: slug }))
                : el('span', { class: 'id-chip' }, el('code', { text: slug }))))),
        );
        details.addEventListener('toggle', () => { if (details.isConnected) unusedOpen = details.open; });
        return details;
    }

    return { show, clear };
}
