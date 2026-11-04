/* global chrome, CSHStorage, CSHUI */
// ============================================================
// CSS Selector Hider - rule list
// ============================================================
// Read/write goes through storage.js (CSHStorage); this file is UI only.
// ============================================================

const {
    genId, getRules, safeSetRules, normalizeMatch, sanitizeRules,
    getBackups, pushBackup, restoreLastBackup, updateRuleById, removeRuleById
} = CSHStorage;

const listEl = document.getElementById('list');
const emptyHint = document.getElementById('empty-hint');
const metaEl = document.getElementById('meta');

const addForm = document.getElementById('add-form');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');
const undoBtn = document.getElementById('undo-btn');

// How many selectors in this rule actually have content.
// Empty rows the user hasn't filled in don't hide anything, so they don't count.
function countSelectors(rule) {
    const list = Array.isArray(rule.selectors) ? rule.selectors : [];
    return list.filter(s => s && typeof s === 'object' && typeof s.selector === 'string' && s.selector.trim()).length;
}

// Header summary: how many names, how many struck out
function renderMeta(rules) {
    if (!rules.length) {
        metaEl.textContent = '';
        return;
    }
    const off = rules.filter(r => r.enabled === false).length;
    const base = `${rules.length} name${rules.length === 1 ? '' : 's'}`;
    metaEl.innerHTML = off ? `${base} · <b>${off} struck</b>` : base;
}

// ----------------------------------------------------------
// Render
// ----------------------------------------------------------
function render(rules) {
    renderMeta(rules);

    emptyHint.hidden = rules.length > 0;
    listEl.innerHTML = '';

    rules.forEach(rule => {
        const isOff = rule.enabled === false;

        const row = document.createElement('li');
        row.className = isOff ? 'row is-off' : 'row';

        // ---- The dot: filled while the name is in force, hollow once struck ----
        // Clicking it writes the name out of the book, or back into it.
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dot-btn';

        const syncDot = (enabled) => {
            const label = enabled ? 'Strike this name out' : 'Restore this name';
            dot.title = label;
            dot.setAttribute('aria-label', label);
            dot.setAttribute('aria-pressed', String(!enabled));
        };
        syncDot(!isOff);

        dot.onclick = async () => {
            // Read the intent from the row, not the captured rule: the row is
            // what the user is looking at.
            const nextEnabled = row.classList.contains('is-off');

            // Through the write queue, so this never races the detail page.
            const res = await updateRuleById(rule.id, r => {
                r.enabled = nextEnabled;
            });

            if (res.ok) {
                const nowOff = res.rule.enabled === false;
                row.classList.toggle('is-off', nowOff);
                syncDot(!nowOff);
                renderMeta(await getRules());
            } else if (res.reason === 'gone') {
                render(await getRules());
            }
        };

        // ---- Name + what it hides ----
        const link = document.createElement('a');
        link.className = 'entry';
        link.href = `detail.html?id=${encodeURIComponent(rule.id)}`;

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = rule.match;

        const n = countSelectors(rule);
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = `${CSHStorage.matchMode(rule.match)} · ${n} selector${n === 1 ? '' : 's'}`;

        link.append(name, meta);

        // ---- Delete ----
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'row-del';
        del.title = 'Delete this name';
        del.setAttribute('aria-label', `Delete the name "${rule.match}"`);
        del.innerHTML = CSHUI.icon.x;
        del.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm(`Delete the name "${rule.match}"?`)) return;

            const res = await removeRuleById(rule.id);
            // Write failed (safeSetRules already alerted): keep the list as it is
            if (!res.ok && res.reason !== 'gone') return;
            render(await getRules());
        };

        row.append(dot, link, del);
        listEl.appendChild(row);
    });
}

// ----------------------------------------------------------
// Add a rule
// ----------------------------------------------------------
addForm.onsubmit = async (e) => {
    e.preventDefault();
    // Normalize before comparing and storing: ".QQ.com" and "qq.com" are the
    // same rule, and without this you get two that look different
    const match = normalizeMatch(document.getElementById('new-match').value);
    if (!match) return;

    const rules = await getRules();

    if (rules.some(r => normalizeMatch(r.match) === match)) {
        alert(`A rule for "${match}" already exists.`);
        return;
    }

    const newRule = {
        id: genId(), match, selectors: [], enabled: true
    };
    rules.push(newRule);

    // Don't navigate if the write failed: that would open a detail page for a
    // rule that isn't stored.
    if (!await safeSetRules(rules)) return;

    location.href = `detail.html?id=${encodeURIComponent(newRule.id)}`;
};

// ----------------------------------------------------------
// Export: download all rules as JSON
// ----------------------------------------------------------
exportBtn.onclick = async () => {
    const rules = await getRules();

    const data = {
        version: 1, exportedAt: new Date().toISOString(), rules
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json'
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `css-selector-hider-${date}.json`;
    a.click();

    // Release later: some browsers may not have read the blob yet
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ----------------------------------------------------------
// Import: pick file -> validate -> confirm -> back up -> replace
// ----------------------------------------------------------
importBtn.onclick = () => importFile.click();

importFile.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Clear the value so the same file can be picked again
    e.target.value = '';

    // Read and parse
    let data;
    try {
        const text = await file.text();
        data = JSON.parse(text);
    } catch (err) {
        alert('Invalid file format.');
        return;
    }

    if (!data || !Array.isArray(data.rules)) {
        alert('Invalid file format.');
        return;
    }

    const current = await getRules();

    if (!confirm(`Import ${data.rules.length} rule(s) and replace current ${current.length}?`)) {
        return;
    }

    // Snapshot the current rules (max 3) so "Undo import" can bring them back
    try {
        await pushBackup(current);
    } catch (err) {
        // A failed backup must not block the import
        console.warn('Backup failed:', err);
    }

    // Cleaning, defaults and de-duplication all live in storage.js, so import
    // and undo-import can't drift into producing two different shapes.
    const imported = sanitizeRules(data.rules);

    // Keep the old list on screen if the write failed
    if (!await safeSetRules(imported)) return;
    render(await getRules());
    await refreshUndo();
};

// ----------------------------------------------------------
// Undo the last import
// ----------------------------------------------------------
// Importing is the only operation that can overwrite everything, and it
// assumes you remembered to export first. So an import snapshots the current
// rules, and this button reads the newest snapshot back.
//
// Hidden while no snapshot exists; each undo pops one, so clicking twice
// walks further back.
function formatAt(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString();
}

async function refreshUndo() {
    const latest = (await getBackups())[0];
    undoBtn.style.display = latest ? '' : 'none';
    undoBtn.title = latest ? `Rules backed up before the last import (${formatAt(latest.at)})` : '';
}

undoBtn.onclick = async () => {
    const latest = (await getBackups())[0];

    // The button may be stale (another tab undid an import already); trust storage
    if (!latest) {
        await refreshUndo();
        return;
    }

    if (!confirm(`Replace current rules with the ${latest.rules.length} rule(s) from the backup taken at ${formatAt(latest.at)}?`)) return;

    const res = await restoreLastBackup();
    if (!res.ok) {
        // Write failed (safeSetRules alerted) or the snapshot vanished
        await refreshUndo();
        return;
    }

    render(await getRules());
    await refreshUndo();
};

// ----------------------------------------------------------
// Init
// ----------------------------------------------------------
(async () => {
    render(await getRules());
    await refreshUndo();
})();
