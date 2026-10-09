/* global chrome */
// ============================================================
// CSS Selector Hider - 列表页
// ============================================================

const listEl = document.getElementById('list');
const addForm = document.getElementById('add-form');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');

// 导入时保留最近几次备份
const MAX_BACKUPS = 3;

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 判断一个 selector 条目是否“空”（没有任何有效信息）
function isEmptySel(s) {
    if (!s || typeof s !== 'object') return true;
    const sel = typeof s.selector === 'string' ? s.selector.trim() : '';
    const note = typeof s.note === 'string' ? s.note.trim() : '';
    return !sel && !note;
}

// 把导入的 selectors 归一化成 [{selector, note}]，并清掉空行。
// 只做字段类型校验和清洗，不处理历史格式。
function normalizeSelectors(input) {
    if (!Array.isArray(input)) return [];
    return input
        .filter(s => s && typeof s === 'object')
        .map(s => ({
            selector: typeof s.selector === 'string' ? s.selector : '', note: typeof s.note === 'string' ? s.note : ''
        }))
        .filter(s => !isEmptySel(s));
}

// 纯读
async function getRules() {
    const {rules = []} = await chrome.storage.local.get('rules');
    return Array.isArray(rules) ? rules : [];
}

async function setRules(rules) {
    await chrome.storage.local.set({rules});
}

// 写盘 + 错误提示。返回是否成功。
// 调用方必须根据返回值决定要不要继续（比如刷新 UI、跳页）。
// 否则一次失败的写入会静默丢掉，用户以为改好了，实际没有。
async function safeSetRules(rules) {
    try {
        await setRules(rules);
        return true;
    } catch (e) {
        alert(t('options_save_failed', (e && e.message) || String(e)));
        return false;
    }
}

// ----------------------------------------------------------
// 渲染
// ----------------------------------------------------------
function render(rules) {
    if (!rules.length) {
        listEl.innerHTML = `<p class="empty">${t('options_empty')}</p>`;
        return;
    }

    listEl.innerHTML = '';
    rules.forEach(rule => {
        const item = document.createElement('div');
        item.className = 'rule-item';

        const link = document.createElement('a');
        link.className = 'body';
        link.href = `detail.html?id=${encodeURIComponent(rule.id)}`;

        const match = document.createElement('span');
        match.className = 'match';
        match.textContent = rule.match;

        const count = document.createElement('span');
        count.className = 'count';
        const selCount = Array.isArray(rule.selectors) ? rule.selectors.length : 0;
        count.textContent = t('options_count', selCount);

        link.append(match, count);

        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '×';
        del.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm(t('options_confirm_delete', rule.match))) return;
            const rules = await getRules();
            const idx = rules.findIndex(r => r.id === rule.id);
            if (idx >= 0) rules.splice(idx, 1);
            if (!await safeSetRules(rules)) return;
            render(await getRules());
        };

        item.append(link, del);
        listEl.appendChild(item);
    });
}

// ----------------------------------------------------------
// 新增规则
// ----------------------------------------------------------
addForm.onsubmit = async (e) => {
    e.preventDefault();
    const match = document.getElementById('new-match').value.trim();
    if (!match) return;

    const rules = await getRules();

    if (rules.some(r => (r.match || '').trim() === match)) {
        alert(t('options_duplicate', match));
        return;
    }

    const newRule = {
        id: genId(), match, selectors: [], enabled: true
    };
    rules.push(newRule);

    // 写盘失败就不跳页，避免在详情页里编辑一个磁盘上不存在的规则
    if (!await safeSetRules(rules)) return;

    location.href = `detail.html?id=${encodeURIComponent(newRule.id)}`;
};

// ----------------------------------------------------------
// 导出：把 rules 存成 JSON 文件下载
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

    // 延迟释放，避免部分浏览器还没读完 blob 就被回收
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ----------------------------------------------------------
// 导入：选文件 → 校验 → 确认 → 备份 → 覆盖
// ----------------------------------------------------------
importBtn.onclick = () => importFile.click();

importFile.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 清空 value，允许连续导入同一个文件
    e.target.value = '';

    // 读文件 + 解析 JSON
    let data;
    try {
        const text = await file.text();
        data = JSON.parse(text);
    } catch (err) {
        alert(t('options_import_invalid'));
        return;
    }

    // 校验结构
    if (!data || !Array.isArray(data.rules)) {
        alert(t('options_import_invalid'));
        return;
    }

    const current = await getRules();

    // 确认替换
    if (!confirm(t('options_import_confirm', data.rules.length, current.length))) {
        return;
    }

    // 备份当前规则（保留最近 MAX_BACKUPS 次，最新的排最前）
    try {
        const {rules_backup = []} = await chrome.storage.local.get('rules_backup');
        const list = Array.isArray(rules_backup) ? rules_backup : [];
        const newBackup = [{at: new Date().toISOString(), rules: current}, ...list].slice(0, MAX_BACKUPS);
        await chrome.storage.local.set({rules_backup: newBackup});
    } catch (err) {
        // 备份失败不阻断导入流程
        console.warn('Backup failed:', err);
    }

    // 规整导入的规则：
    //   1. 过滤掉 null / 数组 / 非对象
    //   2. 补 id、补 enabled、规范化 selectors
    //   3. 去掉空 match
    //   4. 按 match 去重（保留第一条）
    //   5. 按 id 去重（重复的重新生成 id）—— 否则后续按 id 编辑/删除会命中错行
    const seenMatch = new Set();
    const seenId = new Set();
    const imported = data.rules
        .filter(r => r && typeof r === 'object' && !Array.isArray(r))
        .map(r => {
            let id = typeof r.id === 'string' && r.id ? r.id : genId();
            if (seenId.has(id)) id = genId();
            seenId.add(id);
            return {
                id,
                match: typeof r.match === 'string' ? r.match.trim() : '',
                selectors: normalizeSelectors(r.selectors),
                enabled: r.enabled !== false
            };
        })
        .filter(r => {
            if (!r.match) return false;
            if (seenMatch.has(r.match)) return false;
            seenMatch.add(r.match);
            return true;
        });

    // 写盘失败就不刷新列表，保持旧数据展示
    if (!await safeSetRules(imported)) return;
    render(await getRules());
};

// ----------------------------------------------------------
// 初始化：等 i18n 就绪
// ----------------------------------------------------------
i18nReady.then(async () => {
    render(await getRules());

    document.addEventListener('langchange', async () => {
        render(await getRules());
    });
});