// Singleton UI chrome shared by both pages: login / confirm / text-editor /
// info / shortcuts dialogs, toasts, popover menus and small button helpers.
// mountShell() must run once before anything else uses these.

import { el, icon, api, setLoginPrompt, setApiKey, copyText, fmt, detailFrom, ApiError, keys, popoverOpen } from './common.js';

let toastsEl, loginEl, confirmEl, textEl, infoEl, shortcutsEl, menuEl;

export function mountShell() {
    if (toastsEl) return;
    toastsEl = el('div', { id: 'toasts', class: 'toasts', popover: 'manual', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastsEl);
    showToastsLayer();

    loginEl = buildLoginDialog();
    confirmEl = buildConfirmDialog();
    textEl = buildTextDialog();
    infoEl = buildInfoDialog();
    shortcutsEl = buildShortcutsDialog();
    menuEl = el('div', { id: 'menu', class: 'menu', popover: 'auto', role: 'menu' });
    document.body.append(loginEl, confirmEl, textEl, infoEl, shortcutsEl, menuEl);

    setLoginPrompt(requireLoginImpl);

    // Escape closes the topmost popover or dialog. Browsers do this natively,
    // but some embedded ones swallow the default action, so handle it here with
    // native semantics (a cancelable `cancel` event, then close) and prevent
    // the default so a real browser does not close twice.
    keys.on('Escape', () => {
        const pop = popoverOpen();
        if (pop) { try { pop.hidePopover(); } catch { /* already closed */ } return; }
        const d = topDialog();
        if (!d) return false;
        if (d.dispatchEvent(new Event('cancel', { cancelable: true }))) d.close('cancel');
    }, { allowInDialog: true, allowTyping: true, allowInPopover: true });

    // Any [data-close] control inside a dialog closes it.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-close]');
        if (!btn) return;
        const d = btn.closest('dialog');
        if (d && d.open) d.close('cancel');
    });
}

// ---------------------------------------------------------------- dialogs

// Modal dialogs currently open, innermost last; lets page shortcuts act only on
// the topmost one (a confirm stacked over the preview must not move the preview).
const dialogStack = [];
export function topDialog() { return dialogStack[dialogStack.length - 1] || null; }

// Opens a <dialog> modally, focuses `initialFocus` (selector or element, else
// [autofocus]), closes on backdrop click unless lightDismiss is false, and
// restores focus to the opener on close.
export function openDialog(dialog, { initialFocus = null, onClose = null, lightDismiss = true, restoreFocus = true } = {}) {
    const opener = document.activeElement;
    if (dialog.open) dialog.close();
    dialog.returnValue = '';
    dialog.showModal();
    dialogStack.push(dialog);
    const target = typeof initialFocus === 'string' ? dialog.querySelector(initialFocus) : initialFocus;
    const focusTarget = target || dialog.querySelector('[autofocus]');
    if (focusTarget) focusTarget.focus();

    // Backdrop click closes only when the press also started on the backdrop, so
    // dragging a video scrubber or a text selection out of the dialog does not.
    let downOnBackdrop = false;
    const onDown = (e) => { downOnBackdrop = e.target === dialog; };
    const onClick = (e) => {
        if (lightDismiss && downOnBackdrop && e.target === dialog) dialog.close('cancel');
        downOnBackdrop = false;
    };
    dialog.addEventListener('pointerdown', onDown);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('close', function handler() {
        dialog.removeEventListener('close', handler);
        dialog.removeEventListener('click', onClick);
        dialog.removeEventListener('pointerdown', onDown);
        const i = dialogStack.lastIndexOf(dialog);
        if (i >= 0) dialogStack.splice(i, 1);
        // Toasts raised while this dialog was open live inside it (the rest of the
        // page is inert under a modal); hand them back to the page-level stack.
        const inline = dialog.querySelector(':scope > .toasts--inline');
        if (inline) { toastsEl.append(...inline.children); inline.remove(); showToastsLayer(); }
        if (restoreFocus && opener && opener.isConnected && typeof opener.focus === 'function') {
            opener.focus({ preventScroll: true });
        }
        if (onClose) onClose(dialog.returnValue);
    });
    return dialog;
}

function dialogFrame({ id, cls = '', titleId, closeButton = true }) {
    const d = el('dialog', { id, class: cls || null, 'aria-labelledby': titleId });
    const head = el('div', { class: 'dialog__head' }, el('h2', { class: 'dialog__title', id: titleId }));
    if (closeButton) head.append(el('button', { type: 'button', class: 'btn btn--icon btn--ghost', 'data-close': true, 'aria-label': 'Close' }, icon('x')));
    d.append(head, el('div', { class: 'dialog__body' }), el('div', { class: 'dialog__actions' }));
    return d;
}

// ---- login

let loginPromise = null;

function buildLoginDialog() {
    const d = dialogFrame({ id: 'login', cls: 'dialog--narrow', titleId: 'login-title', closeButton: false });
    d.querySelector('.dialog__title').textContent = 'Sign in';
    const input = el('input', { type: 'password', id: 'api-key', autocomplete: 'off', placeholder: 'API key', 'aria-describedby': 'login-error' });
    const error = el('p', { class: 'form-error', id: 'login-error', role: 'alert' });
    const form = el('form', { id: 'login-form', novalidate: true },
        el('p', { text: 'Enter the API key to continue.' }),
        el('label', { class: 'field field--mono', for: 'api-key' }, icon('link'), el('span', { class: 'visually-hidden', text: 'API key' }), input),
        error,
    );
    d.querySelector('.dialog__body').append(form);
    const submit = el('button', { type: 'submit', class: 'btn btn--primary push', form: 'login-form' }, 'Continue');
    d.querySelector('.dialog__actions').append(submit);
    d.addEventListener('cancel', (e) => e.preventDefault());

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const key = input.value.trim();
        if (!key) { input.focus(); return; }
        error.textContent = '';
        setBusy(submit, true);
        try {
            const res = await fetch(api('auth/check'), { headers: { 'X-API-KEY': key }, cache: 'no-store' });
            if (res.ok) {
                setApiKey(key);
                const resolve = d._resolve;
                d._resolve = null;
                d.close('ok');
                if (resolve) resolve();
            } else if (res.status === 401) {
                error.textContent = 'That key was rejected.';
                input.select();
            } else {
                let body = null;
                try { body = await res.json(); } catch { /* not json */ }
                error.textContent = detailFrom(body, `Server error (HTTP ${res.status}).`);
            }
        } catch {
            error.textContent = 'Network error. Try again.';
        } finally {
            setBusy(submit, false);
        }
    });
    return d;
}

function requireLoginImpl() {
    if (loginPromise) return loginPromise;
    loginPromise = new Promise((resolve) => {
        const input = loginEl.querySelector('#api-key');
        input.value = '';
        loginEl.querySelector('#login-error').textContent = '';
        loginEl._resolve = resolve;
        openDialog(loginEl, { initialFocus: input, lightDismiss: false, onClose: () => { loginPromise = null; } });
    });
    return loginPromise;
}

// ---- confirm (with optional delayed-delete picker)

export const DELETE_DELAYS = [
    { label: 'Now', seconds: 0 },
    { label: '1 hour', seconds: 3600 },
    { label: '10 hours', seconds: 36000 },
    { label: '1 day', seconds: 86400 },
    { label: '1 week', seconds: 604800 },
    { label: '1 month', seconds: 2592000 },
];

function buildConfirmDialog() {
    const d = dialogFrame({ id: 'confirm', titleId: 'confirm-title', closeButton: false });
    d.querySelector('.dialog__body').append(el('form', { method: 'dialog', id: 'confirm-form' }));
    return d;
}

// confirmDialog({title, message, confirmText, tone: 'danger'|'neutral', delay: null|{default}, extra: [{label, onClick, href}]})
// -> Promise<{confirmed, delaySeconds}>. Danger dialogs open with focus on Cancel.
export function confirmDialog({
    title = 'Confirm', message = '', confirmText = 'Confirm', cancelText = 'Cancel',
    tone = 'danger', delay = null, extra = [],
} = {}) {
    return new Promise((resolve) => {
        const d = confirmEl;
        d.querySelector('.dialog__title').textContent = title;
        const body = d.querySelector('.dialog__body');
        const actions = d.querySelector('.dialog__actions');
        body.replaceChildren();
        actions.replaceChildren();

        const form = el('form', { method: 'dialog', id: 'confirm-form' });
        for (const m of [].concat(message)) {
            if (m == null || m === '') continue;
            form.append(m.nodeType ? m : el('p', { text: String(m) }));
        }

        let delaySeconds = 0;
        const okBtn = el('button', { type: 'submit', value: 'ok', form: 'confirm-form', class: `btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}` }, confirmText);
        if (delay) {
            delaySeconds = Number(delay.default || 0);
            const live = el('p', { class: 'form-hint', 'aria-live': 'polite' });
            const radios = el('div', { class: 'radios' });
            for (const opt of DELETE_DELAYS) {
                const input = el('input', { type: 'radio', name: 'delay', value: String(opt.seconds), checked: opt.seconds === delaySeconds });
                radios.append(el('label', null, input, opt.label));
            }
            const update = () => {
                const chosen = Number(form.querySelector('input[name=delay]:checked').value);
                delaySeconds = chosen;
                const dangerNow = chosen === 0 && tone === 'danger';
                okBtn.classList.toggle('btn--danger', dangerNow);
                okBtn.classList.toggle('btn--primary', !dangerNow);
                if (chosen === 0) {
                    live.textContent = 'Deletes now. This cannot be undone.';
                    okBtn.textContent = confirmText;
                } else {
                    live.textContent = `Deletes ${fmt.dateTime(new Date(Date.now() + chosen * 1000).toISOString())}. You can cancel from the file until then.`;
                    okBtn.textContent = 'Schedule deletion';
                }
            };
            radios.addEventListener('change', update);
            form.append(el('fieldset', null, el('legend', { text: 'When' }), radios, live));
            update();
        }
        body.append(form);

        // Cancel is the form's first submit button, so Enter from a radio picks it.
        const cancelBtn = el('button', { type: 'submit', value: 'cancel', form: 'confirm-form', class: 'btn' }, cancelText);
        actions.append(cancelBtn);
        for (const x of extra) {
            if (x.href) actions.append(el('a', { class: 'btn btn--ghost', href: x.href, target: '_blank', rel: 'noopener noreferrer' }, x.label, icon('ext')));
            else actions.append(el('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { d.close('cancel'); x.onClick && x.onClick(); } }, x.label));
        }
        okBtn.classList.add('push');
        actions.append(okBtn);

        openDialog(d, {
            initialFocus: tone === 'danger' ? cancelBtn : okBtn,
            onClose: (rv) => resolve({ confirmed: rv === 'ok', delaySeconds: rv === 'ok' ? delaySeconds : 0 }),
        });
    });
}

// ---- text editor (payload / summary / feedback)

function buildTextDialog() {
    const d = dialogFrame({ id: 'text-dialog', titleId: 'text-title' });
    return d;
}

// openTextDialog({title, label, value, mono, maxlength, hint, placeholder, validate(value)->error|null, save(value)->Promise, saveText})
// -> Promise<boolean saved>. Ctrl/Cmd+Enter saves; Escape with unsaved edits asks first.
export function openTextDialog({
    title, label = 'Text', value = '', mono = false, maxlength = null, hint = '', placeholder = '',
    validate = null, save, saveText = 'Save', rows = 10,
}) {
    return new Promise((resolve) => {
        const d = textEl;
        d.querySelector('.dialog__title').textContent = title;
        const body = d.querySelector('.dialog__body');
        const actions = d.querySelector('.dialog__actions');
        body.replaceChildren();
        actions.replaceChildren();

        const ta = el('textarea', {
            id: 'text-input', class: `textarea${mono ? ' textarea--mono' : ''}`, rows: String(rows),
            maxlength: maxlength ? String(maxlength) : null, placeholder, spellcheck: mono ? 'false' : 'true',
            'aria-describedby': 'text-hint text-error',
        });
        ta.value = value;
        const hintEl = el('p', { class: 'form-hint', id: 'text-hint', text: hint });
        const errorEl = el('p', { class: 'form-error', id: 'text-error', role: 'alert' });
        body.append(el('label', { class: 'label', for: 'text-input', text: label }), ta, hintEl, errorEl);

        const cancelBtn = el('button', { type: 'button', class: 'btn' }, 'Cancel');
        const saveBtn = el('button', { type: 'button', class: 'btn btn--primary push', disabled: true }, saveText);
        actions.append(cancelBtn, saveBtn);

        const dirty = () => ta.value !== value;
        let saved = false;
        const showError = (msg) => { errorEl.textContent = msg || ''; ta.setAttribute('aria-invalid', msg ? 'true' : 'false'); };

        ta.addEventListener('input', () => {
            saveBtn.disabled = !dirty();
            if (errorEl.textContent) showError('');
        });

        const doSave = async () => {
            if (!dirty()) return;
            const v = ta.value;
            if (validate) {
                const problem = validate(v);
                if (problem) { showError(problem); ta.focus(); return; }
            }
            setBusy(saveBtn, true);
            try {
                await save(v);
                saved = true;
                d.close('ok');
            } catch (err) {
                if (err instanceof ApiError && err.status === 401) return; // login prompt is showing; keep the editor
                showError(err && err.message ? err.message : 'Save failed');
            } finally {
                setBusy(saveBtn, false);
                saveBtn.disabled = !dirty();
            }
        };
        saveBtn.addEventListener('click', doSave);
        ta.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doSave(); }
        });

        const tryClose = async () => {
            if (dirty()) {
                const { confirmed } = await confirmDialog({ title: 'Discard changes?', message: 'Your edits have not been saved.', confirmText: 'Discard', cancelText: 'Keep editing' });
                if (!confirmed) { ta.focus(); return; }
            }
            d.close('cancel');
        };
        cancelBtn.addEventListener('click', tryClose);
        const onCancel = (e) => { e.preventDefault(); tryClose(); };
        d.addEventListener('cancel', onCancel);
        d.querySelector('[data-close]').onclick = (e) => { e.stopPropagation(); tryClose(); };

        openDialog(d, {
            initialFocus: ta, lightDismiss: false,
            onClose: () => { d.removeEventListener('cancel', onCancel); resolve(saved); },
        });
        ta.setSelectionRange(ta.value.length, ta.value.length);
    });
}

// ---- info dialog (arbitrary content, one Close button)

function buildInfoDialog() {
    return dialogFrame({ id: 'info-dialog', titleId: 'info-title' });
}

export function infoDialog({ title, content, wide = false, actions = [] }) {
    const d = infoEl;
    d.classList.toggle('dialog--wide', wide);
    d.querySelector('.dialog__title').textContent = title;
    const body = d.querySelector('.dialog__body');
    body.replaceChildren(...[].concat(content).filter(Boolean).map(c => c.nodeType ? c : el('p', { text: String(c) })));
    const act = d.querySelector('.dialog__actions');
    act.replaceChildren();
    for (const a of actions) act.append(a);
    act.append(el('button', { type: 'button', class: 'btn push', 'data-close': true }, 'Close'));
    openDialog(d, { initialFocus: '[data-close].push' });
    return d;
}

// ---- shortcuts sheet

function buildShortcutsDialog() {
    const d = dialogFrame({ id: 'shortcuts', titleId: 'shortcuts-title' });
    d.querySelector('.dialog__title').textContent = 'Keyboard shortcuts';
    d.querySelector('.dialog__actions').append(el('button', { type: 'button', class: 'btn push', 'data-close': true }, 'Close'));
    return d;
}

// showShortcuts([{title, items: [{keys: ['/'], label}]}])
export function showShortcuts(sections) {
    const body = shortcutsEl.querySelector('.dialog__body');
    const grid = el('div', { class: 'shortcuts' });
    for (const s of sections) {
        grid.append(el('h3', { text: s.title }));
        for (const it of s.items) {
            grid.append(el('div', null, el('span', { text: it.label }), el('span', null, it.keys.map(k => el('kbd', { text: k })))));
        }
    }
    body.replaceChildren(grid);
    openDialog(shortcutsEl, { initialFocus: '[data-close].push' });
}

// ---------------------------------------------------------------- toasts

// The toasts container is a manual popover so it sits in the top layer above
// any open dialog; re-showing it on every toast keeps it on top of dialogs
// opened later.
function showToastsLayer() {
    if (!toastsEl || typeof toastsEl.showPopover !== 'function') return;
    try { if (toastsEl.matches(':popover-open')) toastsEl.hidePopover(); } catch { /* ignore */ }
    try { toastsEl.showPopover(); } catch { /* ignore */ }
}

// toast('Saved', {tone: 'success'|'error'|'info', sticky, actions: [{label, onClick}], details})
export function toast(message, { tone = 'info', sticky = tone === 'error', actions = [], details = null, duration = 4000 } = {}) {
    const body = el('div', { class: 'toast__body' }, el('div', { text: message }));
    const t = el('div', { class: `toast toast--${tone}` },
        icon(tone === 'success' ? 'check-circle' : tone === 'error' ? 'alert' : 'info'), body);
    const close = () => { t.classList.add('is-leaving'); setTimeout(() => t.remove(), 200); };
    const acts = [];
    for (const a of actions) {
        acts.push(el('button', { type: 'button', class: 'btn btn--sm', onclick: () => { a.onClick && a.onClick(); if (!a.keepOpen) close(); } }, a.label));
    }
    if (details) {
        acts.push(el('button', { type: 'button', class: 'btn btn--sm btn--ghost', onclick: async () => { await copyText(details); } }, 'Copy details'));
    }
    if (acts.length) body.append(el('div', { class: 'toast__actions' }, acts));
    if (sticky || actions.length) {
        t.append(el('button', { type: 'button', class: 'btn btn--icon btn--sm btn--ghost toast__close', 'aria-label': 'Dismiss', onclick: close }, icon('x')));
    }
    // Under a modal dialog everything outside it is inert, so a toast raised
    // then must live inside the dialog to stay clickable.
    const host = topDialog();
    if (host) {
        let inline = host.querySelector(':scope > .toasts--inline');
        if (!inline) { inline = el('div', { class: 'toasts toasts--inline', role: 'status', 'aria-live': 'polite' }); host.append(inline); }
        inline.append(t);
    } else {
        toastsEl.append(t);
        showToastsLayer();
    }
    if (!sticky) {
        let timer = setTimeout(close, duration);
        t.addEventListener('mouseenter', () => clearTimeout(timer));
        t.addEventListener('mouseleave', () => { timer = setTimeout(close, 1500); });
        t.addEventListener('focusin', () => clearTimeout(timer));
        t.addEventListener('focusout', () => { timer = setTimeout(close, 1500); });
    }
    while (toastsEl.children.length > 5) toastsEl.firstElementChild.remove();
    return { close };
}

// ---------------------------------------------------------------- buttons

// Copies `text`, flips the button to a check mark + "Copied" for 1.2s.
export async function copyWithFeedback(btn, text, { copiedLabel = 'Copied', toastOnSuccess = null } = {}) {
    const ok = await copyText(text);
    if (!ok) { toast('Copy failed. Your browser blocked clipboard access.', { tone: 'error' }); return false; }
    // A repeat click inside the feedback window must not snapshot "Copied" as the original.
    if (btn && !btn.classList.contains('is-copied')) {
        const label = btn.querySelector('.btn__label');
        const prevLabel = label ? label.textContent : null;
        const prevHtml = label ? null : btn.innerHTML;
        const svg = btn.querySelector('svg use');
        const prevIcon = svg ? svg.getAttribute('href') : null;
        btn.classList.add('is-copied');
        if (svg) svg.setAttribute('href', '#i-check');
        if (label) label.textContent = copiedLabel;
        else if (!svg) btn.textContent = copiedLabel;
        setTimeout(() => {
            btn.classList.remove('is-copied');
            if (svg && prevIcon) svg.setAttribute('href', prevIcon);
            if (label) label.textContent = prevLabel;
            else if (!svg) btn.innerHTML = prevHtml;
        }, 1200);
    }
    if (toastOnSuccess) toast(toastOnSuccess, { tone: 'success', duration: 2000 });
    return true;
}

// Disables a button and spins its icon while an action runs; optional label swap.
export function setBusy(btn, busy, label = null) {
    if (!btn) return;
    if (busy) {
        btn.dataset.busyLabel = btn.dataset.busyLabel || '';
        btn.disabled = true;
        btn.classList.add('is-busy');
        btn.setAttribute('aria-busy', 'true');
        if (!btn.querySelector('svg')) {
            btn.prepend(icon('loader'));
            btn.dataset.busySpinner = '1';
        }
        if (label) {
            const l = btn.querySelector('.btn__label');
            if (l) { btn.dataset.busyLabel = l.textContent; l.textContent = label; }
        }
    } else {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        if (btn.dataset.busySpinner) { const s = btn.querySelector('svg'); if (s) s.remove(); delete btn.dataset.busySpinner; }
        if (btn.dataset.busyLabel) {
            const l = btn.querySelector('.btn__label');
            if (l) l.textContent = btn.dataset.busyLabel;
        }
        delete btn.dataset.busyLabel;
    }
}

// ---------------------------------------------------------------- menus

// openMenu(anchorButton, [{label, icon, danger, onSelect, href}, 'sep', …])
export function openMenu(anchor, items) {
    const m = menuEl;
    m.replaceChildren();
    for (const it of items) {
        if (it === 'sep') { m.append(el('div', { class: 'menu__sep', role: 'separator' })); continue; }
        const cls = `menu__item${it.danger ? ' menu__item--danger' : ''}`;
        let node;
        if (it.href) {
            node = el('a', { class: cls, role: 'menuitem', href: it.href, target: it.target || '_blank', rel: 'noopener noreferrer' }, it.icon ? icon(it.icon) : null, it.label);
        } else {
            node = el('button', { type: 'button', class: cls, role: 'menuitem', onclick: () => { closeMenu(); it.onSelect && it.onSelect(); } }, it.icon ? icon(it.icon) : null, it.label);
        }
        m.append(node);
    }
    const closeMenu = () => { try { m.hidePopover(); } catch { /* already closed */ } };
    const onKey = (e) => {
        const focusables = [...m.querySelectorAll('[role=menuitem]')];
        const i = focusables.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); (focusables[i + 1] || focusables[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (focusables[i - 1] || focusables[focusables.length - 1]).focus(); }
        else if (e.key === 'Home') { e.preventDefault(); focusables[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); focusables[focusables.length - 1].focus(); }
        else if (e.key === 'Tab') { closeMenu(); }
    };
    m.addEventListener('keydown', onKey);
    m.addEventListener('toggle', function onToggle(e) {
        if (e.newState === 'open') {
            anchor.setAttribute('aria-expanded', 'true');
            const first = m.querySelector('[role=menuitem]');
            if (first) first.focus();
        } else {
            m.removeEventListener('toggle', onToggle);
            m.removeEventListener('keydown', onKey);
            anchor.setAttribute('aria-expanded', 'false');
            // Restore focus only if the user did not deliberately move it elsewhere
            // (light-dismissing by clicking into the filter field must keep that focus).
            const ae = document.activeElement;
            if (anchor.isConnected && (!ae || ae === document.body || m.contains(ae))) anchor.focus({ preventScroll: true });
        }
    });
    positionPopover(m, anchor);
    m.showPopover();
}

// Places a fixed popover under its anchor, kept inside the viewport.
export function positionPopover(pop, anchor, { align = 'end' } = {}) {
    const r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = '0px';
    pop.style.left = '0px';
    pop.style.maxWidth = 'calc(100vw - 16px)';
    // Measure after it is displayable.
    const measure = () => {
        const w = pop.offsetWidth || 200;
        const h = pop.offsetHeight || 100;
        let left = align === 'end' ? r.right - w : r.left;
        left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
        let top = r.bottom + 4;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
        pop.style.top = `${Math.round(top)}px`;
        pop.style.left = `${Math.round(left)}px`;
    };
    measure();
    requestAnimationFrame(measure);
}
