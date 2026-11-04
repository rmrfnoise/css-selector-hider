/* global chrome, CSHStorage, CSHUI */
// ============================================================
// CSS Selector Hider - rule detail
// ============================================================
// Edits one rule's pattern and selector list. The rule is found by ?id=xxx;
// every change is written back to chrome.storage.local immediately.
//
// Read/write goes through storage.js (CSHStorage), including the serial write
// queue. Never touch chrome.storage directly from here.
// ============================================================

const {getRules, normalizeMatch, updateRuleById, removeRuleById} = CSHStorage;

const params = new URLSearchParams(location.search);
const ruleId = params.get('id');

const matchInput = document.getElementById('match-input');
const matchModeEl = document.getElementById('match-mode');
const tbody = document.getElementById('tbody');
const emptyHint = document.getElementById('empty-hint');
const addRowBtn = document.getElementById('add-row');
const deleteRuleBtn = document.getElementById('delete-rule');

// The rule as last read/written; most handlers work from this
let loadedRule = null;

async function getRule() {
    const rules = await getRules();
    return rules.find(r => String(r.id) === ruleId);
}

// Single notice for "the rule is gone" (e.g. deleted in another tab)
function warnRuleGone() {
    alert('Rule not found. It may have been deleted.');
}

// ----------------------------------------------------------
// Every change goes through this
// ----------------------------------------------------------
// Wraps updateRuleById: keeps loadedRule in sync, notices a deleted rule.
// The resolved value is still {ok, reason, rule}, so callers can decide
// whether to roll their input back.
//
// Not getRules + setRules here: the write queue lives in storage.js, and
// going around it brings back the "two quick onchange handlers each read the
// same old snapshot, the second overwrites the first" bug.
async function commit(mutator) {
    const res = await updateRuleById(ruleId, mutator);

    if (res.ok) {
        loadedRule = res.rule;
    } else if (res.reason === 'gone') {
        warnRuleGone();
    }

    return res;
}

// ----------------------------------------------------------
// Matching mode beside the pattern: updates as you type
// ----------------------------------------------------------
// The three-way detection (url / port / domain) is implicit in the extension.
// Showing it while you type is how you find out how this rule will be read.
function updateModeLabel() {
    matchModeEl.textContent = CSHStorage.matchMode(matchInput.value);
}

// ----------------------------------------------------------
// Render the selector table
// ----------------------------------------------------------
function renderTable(rule) {
    tbody.innerHTML = '';
    const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];

    emptyHint.hidden = selectors.length > 0;

    selectors.forEach((sel, i) => {
        const tr = document.createElement('tr');

        // ---- Selector ----
        const tdSel = document.createElement('td');
        tdSel.className = 'sel';
        const inputSel = document.createElement('input');
        inputSel.type = 'text';
        inputSel.value = sel.selector || '';
        inputSel.spellcheck = false;
        tdSel.appendChild(inputSel);

        // ---- Note ----
        const tdNote = document.createElement('td');
        tdNote.className = 'note';
        const inputNote = document.createElement('input');
        inputNote.type = 'text';
        inputNote.value = sel.note || '';
        tdNote.appendChild(inputNote);

        // ---- Delete this row ----
        const tdDel = document.createElement('td');
        tdDel.className = 'del-cell';
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'row-del';
        btnDel.title = 'Delete this row';
        btnDel.setAttribute('aria-label', 'Delete this row');
        btnDel.innerHTML = CSHUI.icon.x;
        tdDel.appendChild(btnDel);

        tr.append(tdSel, tdNote, tdDel);

        // ---- Selector editing ----
        // onchange (blur + changed value), not oninput: don't write to storage
        // on every keystroke, only when a cell is finished.
        let prevValue = inputSel.value;
        inputSel.onfocus = () => {
            prevValue = inputSel.value;
        };

        inputSel.onchange = async () => {
            const v = inputSel.value.trim();

            // Compare against the other rows (loadedRule still holds the old
            // value at index i, so skip it)
            if (v && loadedRule) {
                const dup = loadedRule.selectors.some((s, idx) => idx !== i && (s.selector || '').trim() === v);
                if (dup) {
                    alert(`This selector already exists in this rule: "${v}"`);
                    inputSel.value = prevValue;
                    return;
                }
            }

            const res = await commit(rule => {
                rule.selectors[i].selector = inputSel.value;
            });

            if (!res.ok && res.reason !== 'gone') {
                // Write failed: roll back to the in-memory value (loadedRule unchanged)
                inputSel.value = prevValue;
            }
        };

        // ---- Note editing ----
        let prevNote = inputNote.value;
        inputNote.onfocus = () => {
            prevNote = inputNote.value;
        };

        inputNote.onchange = async () => {
            const res = await commit(rule => {
                rule.selectors[i].note = inputNote.value;
            });
            if (!res.ok && res.reason !== 'gone') {
                inputNote.value = prevNote;
            }
        };

        // ---- Delete this row ----
        btnDel.onclick = async () => {
            const res = await commit(rule => {
                rule.selectors.splice(i, 1);
            });
            if (!res.ok) return;
            renderTable(res.rule);
        };

        tbody.appendChild(tr);
    });
}

// ----------------------------------------------------------
// First load
// ----------------------------------------------------------
async function loadAndRender() {
    const rule = await getRule();
    if (!rule) {
        document.querySelector('main').innerHTML =
            '<p class="notice">Rule not found. It may have been deleted.<br><br>'
            + '<a href="options.html">All names</a></p>';
        return;
    }

    // Drop rows where both fields are empty (added with "Add selector" and
    // left alone). They hide nothing and only make the table longer.
    const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];
    const cleaned = selectors.filter(s => s && typeof s === 'object' && ((s.selector && s.selector.trim()) || (s.note && s.note.trim())));

    let finalRule = rule;
    if (cleaned.length !== selectors.length) {
        const res = await commit(r => {
            r.selectors = cleaned;
        });
        if (!res.ok) return;
        finalRule = res.rule;
    }

    matchInput.value = finalRule.match;
    updateModeLabel();
    loadedRule = finalRule;
    renderTable(finalRule);
}

// ----------------------------------------------------------
// Editing the pattern: validated on blur
// ----------------------------------------------------------
matchInput.oninput = updateModeLabel;

matchInput.onchange = async () => {
    // Normalize first: ".QQ.com" -> "qq.com". Same function the storage layer
    // and the import path use, so two equivalent rules can never coexist.
    const v = normalizeMatch(matchInput.value);

    // No empty pattern (normalizing can leave nothing, e.g. a lone ".")
    if (!v) {
        alert('URL cannot be empty.');
        matchInput.value = loadedRule ? loadedRule.match : '';
        updateModeLabel();
        return;
    }

    // Show the normalized value, so "I typed QQ.com, why is it qq.com" never happens
    matchInput.value = v;
    updateModeLabel();

    // Reject duplicates against the other rules
    const rules = await getRules();
    const dup = rules.some(r => String(r.id) !== ruleId && normalizeMatch(r.match) === v);

    if (dup) {
        alert(`A rule for "${v}" already exists.`);
        matchInput.value = loadedRule ? loadedRule.match : '';
        updateModeLabel();
        return;
    }

    const res = await commit(rule => {
        rule.match = v;
    });
    if (!res.ok && res.reason !== 'gone') {
        matchInput.value = loadedRule ? loadedRule.match : '';
        updateModeLabel();
    }
};

// ----------------------------------------------------------
// Add a row
// ----------------------------------------------------------
addRowBtn.onclick = async () => {
    const res = await commit(rule => {
        if (!Array.isArray(rule.selectors)) rule.selectors = [];
        rule.selectors.push({selector: '', note: ''});
    });
    if (!res.ok) return;

    renderTable(res.rule);

    // Focus the selector field of the new row
    const rows = tbody.querySelectorAll('tr');
    const last = rows[rows.length - 1];
    if (last) last.querySelector('input').focus();
};

// ----------------------------------------------------------
// Delete the whole rule
// ----------------------------------------------------------
deleteRuleBtn.onclick = async () => {
    if (!confirm('Delete this rule?')) return;

    // Through the write queue (shared with every edit above). If the write
    // fails, stay on the page instead of pretending it was deleted.
    const res = await removeRuleById(ruleId);
    if (!res.ok && res.reason !== 'gone') return;

    location.href = 'options.html';
};

// ----------------------------------------------------------
// Init
// ----------------------------------------------------------
void loadAndRender();
