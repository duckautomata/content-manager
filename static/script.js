const state = {
    prefix: 'home/',
    images: [],
    others: [],
    publicUrlPrefix: '',
    filter: ''
};

// DOM Elements
const prefixInput = document.getElementById('prefix-input');
const refreshBtn = document.getElementById('refresh-btn');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');
const progressFill = document.querySelector('.progress-fill');
const progressText = document.querySelector('.progress-text');

const imagesGrid = document.getElementById('images-grid');
const imagesCount = document.getElementById('images-count');
const othersList = document.getElementById('others-list');
const othersCount = document.getElementById('others-count');

const filterInput = document.getElementById('filter-input');
const replaceFileInput = document.getElementById('replace-file-input');
let currentReplaceFilename = null;

const modal = document.getElementById('preview-modal');
const modalImage = document.getElementById('modal-image');
const modalTitle = document.getElementById('modal-title');
const modalOrigLink = document.getElementById('modal-original-link');
const modalPrevLink = document.getElementById('modal-preview-link');
const modalDelBtn = document.getElementById('modal-delete-btn');
const closeBtn = document.querySelector('.close-modal-btn');
const backdrop = document.querySelector('.modal-backdrop');

const resultsModal = document.getElementById('upload-results-modal');
const resultsList = document.getElementById('upload-results-list');
const closeResultsBtn = document.querySelector('.close-results-btn');
const resultsBackdrop = resultsModal.querySelector('.modal-backdrop');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    prefixInput.value = state.prefix;
    fetchContent();
});

filterInput.addEventListener('input', () => {
    state.filter = filterInput.value.toLowerCase();
    renderContent();
});

// Event Listeners
refreshBtn.addEventListener('click', () => {
    state.prefix = prefixInput.value;
    if (!state.prefix.endsWith('/')) {
        state.prefix += '/';
        prefixInput.value = state.prefix;
    }
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
        const res = await fetch('/api/upload', {
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
        alert('Failed to replace file.');

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
    return `/api/content?key=${encodeURIComponent(key)}`; // Mock fallback
}

// Fetch State
async function fetchContent() {
    refreshBtn.classList.add('spinner', 'loading');
    imagesGrid.innerHTML = '';
    othersList.innerHTML = '';

    try {
        const res = await fetch(`/api/content?prefix=${encodeURIComponent(state.prefix)}`);
        if (!res.ok) throw new Error('Failed to fetch content');
        const data = await res.json();

        state.images = data.images || [];
        state.others = data.others || [];
        state.publicUrlPrefix = data.public_url_prefix || '';

        renderContent();
    } catch (err) {
        console.error(err);
        alert('Error fetching content. Check console for details.');
    } finally {
        refreshBtn.classList.remove('spinner', 'loading');
    }
}

// Render UI
function renderContent() {
    imagesGrid.innerHTML = '';
    othersList.innerHTML = '';

    let imageMatchCount = 0;
    // Images
    state.images.forEach(img => {
        if (state.filter && !img.slug.toLowerCase().includes(state.filter)) return;
        imageMatchCount++;

        const thumbKey = img.files.thumbnail || img.files.original; // Fallback to original if no thumb somehow
        const url = getPublicUrl(state.prefix + thumbKey);

        const card = document.createElement('div');
        card.className = 'image-card glass-panel';
        card.innerHTML = `
            <img src="${url}" alt="${img.slug}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🖼️</text></svg>'">
            <div class="overlay">
                <span>${img.slug}</span>
            </div>
        `;

        card.addEventListener('click', () => openModal(img));
        imagesGrid.appendChild(card);
    });
    imagesCount.textContent = imageMatchCount;

    let othersMatchCount = 0;
    // Others
    state.others.forEach(item => {
        if (state.filter && !item.filename.toLowerCase().includes(state.filter)) return;
        othersMatchCount++;

        const div = document.createElement('div');
        div.className = 'list-item';

        const sizeMb = (item.size / (1024 * 1024)).toFixed(2);
        const date = new Date(item.last_modified).toLocaleDateString();

        div.innerHTML = `
            <div class="item-info">
                <svg class="item-icon" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                <div class="item-details">
                    <div class="item-name">${item.filename}</div>
                    <div class="item-meta">
                        <span>${sizeMb} MB</span>
                        <span>${date}</span>
                    </div>
                </div>
            </div>
            <div class="item-actions">
                <button class="btn secondary-btn replace-item-btn" title="Replace File">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.3-11.23l4.63 4.66"/></svg>
                </button>
                <a href="${getPublicUrl(item.key)}" target="_blank" class="btn secondary-btn" title="Download">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </a>
                <button class="btn danger-btn delete-item-btn" data-key="${item.key}" title="Delete">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;

        const replaceBtn = div.querySelector('.replace-item-btn');
        replaceBtn.addEventListener('click', () => {
            currentReplaceFilename = item.filename;
            replaceFileInput.click();
        });

        const delBtn = div.querySelector('.delete-item-btn');
        delBtn.addEventListener('click', () => deleteItem(item.key));

        othersList.appendChild(div);
    });
    othersCount.textContent = othersMatchCount;
}

// Modal Functions
function openModal(img) {
    // Try to load preview webp, fallback to thumbnail or original if missing
    const previewKey = img.files.preview || img.files.original || img.files.thumbnail;
    const origKey = img.files.original || img.files.preview || img.files.thumbnail;

    modalImage.src = getPublicUrl(state.prefix + previewKey);
    modalTitle.textContent = img.slug;

    modalOrigLink.href = getPublicUrl(state.prefix + origKey);
    modalOrigLink.style.display = img.files.original ? 'inline-flex' : 'none';

    modalPrevLink.href = getPublicUrl(state.prefix + img.files.preview);
    modalPrevLink.style.display = img.files.preview ? 'inline-flex' : 'none';

    // Delete action needs to delete all associated files
    modalDelBtn.onclick = async () => {
        if (confirm(`Delete image group ${img.slug}?`)) {
            const keys = [img.files.original, img.files.preview, img.files.thumbnail]
                .filter(Boolean)
                .map(k => state.prefix + k);

            closeModal();
            for (let key of keys) {
                await fetch(`/api/content?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
            }
            fetchContent();
        }
    };

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

async function deleteItem(key) {
    if (confirm(`Delete ${key}?`)) {
        try {
            const res = await fetch(`/api/content?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Delete failed');
            fetchContent();
        } catch (err) {
            console.error(err);
            alert('Delete failed');
        }
    }
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

            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (res.ok) {
                successCount++;
                const data = await res.json();
                uploadResults.push({ ...data, original_name: file.name });
            }
            else console.error(`Failed to upload ${file.name}`);
        } catch (err) {
            console.error(`Error uploading ${file.name}`, err);
        }
    }

    progressFill.style.width = '100%';
    progressText.textContent = `Complete! ${successCount} successful.`;

    setTimeout(() => {
        uploadProgress.classList.add('hidden');
        progressFill.style.width = '0%';
        fetchContent();
        if (uploadResults.length > 0) {
            showUploadResults(uploadResults);
        }
    }, 1000);
}

function showUploadResults(results) {
    resultsList.innerHTML = '';

    results.forEach(res => {
        const div = document.createElement('div');
        div.style.padding = '1rem';
        div.style.background = 'var(--glass-bg)';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid var(--glass-border)';

        if (res.type === 'image') {
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                    <strong style="color: var(--primary);">${res.slug}</strong>
                    <button class="btn secondary-btn copy-id-btn" data-id="${res.slug}" title="Copy ID" style="padding: 0.25rem 0.5rem;">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
                <div style="font-size: 0.85rem; color: var(--text-muted); display:flex; flex-direction:column; gap:0.25rem;">
                    <div><span style="color:var(--text-main);">Original:</span> ${res.original}</div>
                    <div><span style="color:var(--text-main);">Preview:</span> ${res.preview}</div>
                    <div><span style="color:var(--text-main);">Thumbnail:</span> ${res.thumbnail}</div>
                </div>
            `;
        } else {
            const displayName = res.original_name ? res.original_name : res.key.split('/').pop();
            div.innerHTML = `
                <strong style="color: var(--accent-1); display:block; margin-bottom:0.5rem;">${displayName}</strong>
                <div style="font-size: 0.85rem; color: var(--text-muted);">
                    <div><span style="color:var(--text-main);">Path:</span> ${res.key}</div>
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
            setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
        });
    });
}
