/* global chrome */
// ============================================================
// CSS Selector Hider - 详情页
// ============================================================
// 作用：编辑一条规则的 URL 和选择器列表。
// 逻辑：页面打开时按 URL 上的 ?id=xxx 找到规则，用表格展示；
//       用户改动时实时写回 chrome.storage.local。
// ============================================================

const params = new URLSearchParams(location.search);
const ruleId = params.get('id');

const matchInput = document.getElementById('match-input');
const tbody = document.getElementById('tbody');
const emptyHint = document.getElementById('empty-hint');

// 当前规则的引用（页面生命周期内主要靠它读写）
let loadedRule = null;

// ----------------------------------------------------------
// storage 读写
// ----------------------------------------------------------
async function getRules() {
    const {rules = []} = await chrome.storage.local.get('rules');
    return Array.isArray(rules) ? rules : [];
}

async function setRules(rules) {
    await chrome.storage.local.set({rules});
}

async function getRule() {
    const rules = await getRules();
    return rules.find(r => String(r.id) === ruleId);
}

// ----------------------------------------------------------
// 写队列 + updateRule
// ----------------------------------------------------------
// 所有 read-modify-write 都排进 writeChain 串行执行。
// 否则两次快速 onchange 会各自读到同一份旧快照，
// 后写的那次直接覆盖先写的那次，前一次的改动就丢了。
//
// 返回值：
//   {ok: true,  rule}            写盘成功，rule 是更新后的规则
//   {ok: false, reason: 'gone'}  规则已不存在
//   {ok: false, reason: 'save'}  写盘失败（已 alert）
let writeChain = Promise.resolve();

function updateRule(mutator) {
    const run = async () => {
        const rules = await getRules();
        const i = rules.findIndex(r => String(r.id) === ruleId);
        if (i < 0) return {ok: false, reason: 'gone'};

        mutator(rules[i]);

        try {
            await setRules(rules);
        } catch (e) {
            alert(t('detail_save_failed', (e && e.message) || String(e)));
            return {ok: false, reason: 'save'};
        }

        loadedRule = rules[i];
        return {ok: true, rule: rules[i]};
    };

    // 前一个任务无论成功还是失败，都要继续排下一个
    const next = writeChain.then(run, run);
    writeChain = next.then(() => {
    }, () => {
    });
    return next;
}

// 规则已被删除时的统一提示（比如在另一个标签页删掉了）
function warnRuleGone() {
    alert(t('detail_rule_not_found'));
}

// ----------------------------------------------------------
// 渲染表格
// ----------------------------------------------------------
function renderTable(rule) {
    tbody.innerHTML = '';
    const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];

    // 没有选择器时显示空提示
    emptyHint.style.display = selectors.length ? 'none' : 'block';

    selectors.forEach((sel, i) => {
        const tr = document.createElement('tr');

        // ---- 选择器列 ----
        const tdSel = document.createElement('td');
        tdSel.className = 'sel';
        const inputSel = document.createElement('input');
        inputSel.type = 'text';
        inputSel.value = sel.selector || '';
        inputSel.placeholder = t('detail_placeholder_selector');
        tdSel.appendChild(inputSel);

        // ---- 备注列 ----
        const tdNote = document.createElement('td');
        tdNote.className = 'note';
        const inputNote = document.createElement('input');
        inputNote.type = 'text';
        inputNote.value = sel.note || '';
        inputNote.placeholder = t('detail_placeholder_note');
        tdNote.appendChild(inputNote);

        // ---- 删除按钮 ----
        const tdDel = document.createElement('td');
        tdDel.className = 'del-cell';
        const btnDel = document.createElement('button');
        btnDel.className = 'del';
        btnDel.textContent = '×';
        btnDel.title = t('detail_delete_row_title');
        tdDel.appendChild(btnDel);

        tr.append(tdSel, tdNote, tdDel);

        // ---- 选择器事件 ----
        // 用 onchange（失焦且值有变才触发），而不是 oninput。
        // 输入过程中不写盘，确认一格输完才保存一次。
        let prevValue = inputSel.value;
        inputSel.onfocus = () => {
            prevValue = inputSel.value;
        };

        inputSel.onchange = async () => {
            const v = inputSel.value.trim();

            // 与其他行比，看是否重复（loadedRule 里 i 位置还是旧值，跳过 i 自己）
            if (v && loadedRule) {
                const dup = loadedRule.selectors.some((s, idx) => idx !== i && (s.selector || '').trim() === v);
                if (dup) {
                    alert(t('detail_dup_selector', v));
                    inputSel.value = prevValue;
                    return;
                }
            }

            const res = await updateRule(rule => {
                rule.selectors[i].selector = inputSel.value;
            });

            if (!res.ok) {
                if (res.reason === 'gone') {
                    warnRuleGone();
                } else {
                    // 保存失败：回滚到内存里的旧值（此时 loadedRule 未变）
                    inputSel.value = prevValue;
                }
            }
        };

        // ---- 备注事件 ----
        let prevNote = inputNote.value;
        inputNote.onfocus = () => {
            prevNote = inputNote.value;
        };

        inputNote.onchange = async () => {
            const res = await updateRule(rule => {
                rule.selectors[i].note = inputNote.value;
            });
            if (!res.ok) {
                if (res.reason === 'gone') {
                    warnRuleGone();
                } else {
                    inputNote.value = prevNote;
                }
            }
        };

        // ---- 删除这一行 ----
        btnDel.onclick = async () => {
            const res = await updateRule(rule => {
                rule.selectors.splice(i, 1);
            });
            if (!res.ok) {
                if (res.reason === 'gone') warnRuleGone();
                return;
            }
            renderTable(res.rule);
        };

        tbody.appendChild(tr);
    });
}

// ----------------------------------------------------------
// 首次加载
// ----------------------------------------------------------
async function loadAndRender() {
    const rule = await getRule();
    if (!rule) {
        document.body.innerHTML = `<p style="padding:20px;color:#888;">${t('detail_rule_not_found')}<br><br>` + `<a href="options.html">${t('detail_back')}</a></p>`;
        return;
    }

    // 清理两字段都为空的行（用户点 Add row 后没填的情况）。
    // 这种行不产生任何效果，留着只会让表格无谓地变长。
    const selectors = Array.isArray(rule.selectors) ? rule.selectors : [];
    const cleaned = selectors.filter(s => s && typeof s === 'object' && ((s.selector && s.selector.trim()) || (s.note && s.note.trim())));

    let finalRule = rule;
    if (cleaned.length !== selectors.length) {
        const res = await updateRule(r => {
            r.selectors = cleaned;
        });
        if (!res.ok) {
            if (res.reason === 'gone') warnRuleGone();
            return;
        }
        finalRule = res.rule;
    }

    matchInput.value = finalRule.match;
    loadedRule = finalRule;
    renderTable(finalRule);
}

// ----------------------------------------------------------
// 修改 URL：失焦时校验
// ----------------------------------------------------------
matchInput.onchange = async () => {
    const v = matchInput.value.trim();

    // 空 URL 不允许
    if (!v) {
        alert(t('detail_url_empty'));
        matchInput.value = loadedRule ? loadedRule.match : '';
        return;
    }

    // 和其他规则比对，不允许重复
    const rules = await getRules();
    const dup = rules.some(r => String(r.id) !== ruleId && (r.match || '').trim() === v);

    if (dup) {
        alert(t('detail_url_dup', v));
        matchInput.value = loadedRule ? loadedRule.match : '';
        return;
    }

    const res = await updateRule(rule => {
        rule.match = v;
    });
    if (!res.ok) {
        if (res.reason === 'gone') {
            warnRuleGone();
        } else {
            matchInput.value = loadedRule ? loadedRule.match : '';
        }
    }
};

// ----------------------------------------------------------
// 新增一行
// ----------------------------------------------------------
document.getElementById('add-row').onclick = async () => {
    const res = await updateRule(rule => {
        if (!Array.isArray(rule.selectors)) rule.selectors = [];
        rule.selectors.push({selector: '', note: ''});
    });
    if (!res.ok) {
        if (res.reason === 'gone') warnRuleGone();
        return;
    }

    renderTable(res.rule);

    // 聚焦到新加的那一行的选择器输入框
    const rows = tbody.querySelectorAll('tr');
    const last = rows[rows.length - 1];
    if (last) last.querySelector('input').focus();
};

// ----------------------------------------------------------
// 删除整条规则
// ----------------------------------------------------------
document.getElementById('delete-rule').onclick = async () => {
    if (!confirm(t('detail_confirm_delete'))) return;

    const rules = await getRules();
    const i = rules.findIndex(r => String(r.id) === ruleId);
    if (i >= 0) {
        rules.splice(i, 1);
        await setRules(rules);
    }
    location.href = 'options.html';
};

// ----------------------------------------------------------
// 初始化：等 i18n 就绪后再渲染
// ----------------------------------------------------------
i18nReady.then(() => {
    void loadAndRender();

    // 切换语言时重渲染，让 placeholder 和 title 跟着更新
    document.addEventListener('langchange', async () => {
        if (loadedRule) {
            const fresh = await getRule();
            if (!fresh) return;
            loadedRule = fresh;
            renderTable(fresh);
        }
    });
});