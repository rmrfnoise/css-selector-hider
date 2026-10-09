/* global chrome */
// ============================================================
// CSS Selector Hider - 国际化
// ============================================================
// 语言存在 chrome.storage.local 的 lang 字段，值为 'en' 或 'zh'。
// 页面里用 data-i18n / data-i18n-placeholder / data-i18n-title
// 标记需要翻译的元素。
// JS 里用 t('key') 或 t('key', arg1) 取文案。
// ============================================================

// I18N 里的属性是通过 t() 用字符串 key 动态取的，IDE 看不到引用，
// 会误报“未使用的属性”。运行时正常，这里关掉静态提示。
//noinspection JSUnusedGlobalSymbols
const I18N = {
    en: {
        // ---- options.html ----
        options_title: 'CSS Selector Hider',
        options_subtitle: "Configure CSS selectors per site to hide elements you don't want to see.",
        options_empty: 'No rules yet. Add one below.',
        options_url_label: 'URL fragment',
        options_placeholder: 'URL fragment, e.g. docs.qq.com',
        options_add: 'Add',
        options_count: (n) => `${n} selector${n === 1 ? '' : 's'}`,
        options_confirm_delete: (m) => `Delete rule "${m}"?`,
        options_duplicate: (m) => `A rule for "${m}" already exists.`,
        options_export: 'Export',
        options_import: 'Import',
        options_import_invalid: 'Invalid file format.',
        options_import_confirm: (n, m) => `Import ${n} rule(s) and replace current ${m}?`,
        options_save_failed: (msg) => `Save failed: ${msg}`,

        // ---- detail.html ----
        detail_title: 'Edit Rule',
        detail_back: '← Back',
        detail_url_label: 'URL contains',
        detail_url_placeholder: 'e.g. docs.qq.com',
        detail_th_selector: 'Selector',
        detail_th_note: 'Note',
        detail_empty: 'No selectors yet — click "Add row" below.',
        detail_add_row: '+ Add row',
        detail_delete_rule: 'Delete rule',
        detail_placeholder_selector: 'e.g. .ad-banner',
        detail_placeholder_note: 'Note (optional)',
        detail_delete_row_title: 'Delete this row',
        detail_dup_selector: (v) => `This selector already exists in this rule: "${v}"`,
        detail_rule_not_found: 'Rule not found. It may have been deleted.',
        detail_url_empty: 'URL cannot be empty.',
        detail_url_dup: (v) => `A rule for "${v}" already exists.`,
        detail_confirm_delete: 'Delete this rule?',
        detail_save_failed: (msg) => `Save failed: ${msg}`,

        // ---- 语言按钮：显示当前语言 ----
        lang_button: 'English'
    }, zh: {
        // ---- options.html ----
        options_title: 'CSS Selector Hider',
        options_subtitle: '按网站配置 CSS 选择器，隐藏不想看到的页面元素。',
        options_empty: '还没有规则，在下面新增一条。',
        options_url_label: '网址片段',
        options_placeholder: '输入网址片段，例如 docs.qq.com',
        options_add: '添加',
        options_count: (n) => `${n} 条选择器`,
        options_confirm_delete: (m) => `删除规则「${m}」？`,
        options_duplicate: (m) => `已存在相同网址的规则：「${m}」`,
        options_export: '导出',
        options_import: '导入',
        options_import_invalid: '文件格式不正确。',
        options_import_confirm: (n, m) => `将导入 ${n} 条规则，替换当前 ${m} 条？`,
        options_save_failed: (msg) => `保存失败：${msg}`,

        // ---- detail.html ----
        detail_title: '编辑规则',
        detail_back: '← 返回',
        detail_url_label: '网址包含',
        detail_url_placeholder: '例如 docs.qq.com',
        detail_th_selector: '选择器',
        detail_th_note: '备注',
        detail_empty: '还没有选择器，点下面「新增一行」开始配置。',
        detail_add_row: '+ 新增一行',
        detail_delete_rule: '删除此规则',
        detail_placeholder_selector: '例如 .ad-banner',
        detail_placeholder_note: '备注（可选）',
        detail_delete_row_title: '删除这一行',
        detail_dup_selector: (v) => `这条规则里已经有相同的选择器：「${v}」`,
        detail_rule_not_found: '规则不存在，可能已被删除。',
        detail_url_empty: '网址不能为空。',
        detail_url_dup: (v) => `已存在相同网址的规则：「${v}」`,
        detail_confirm_delete: '删除这条规则？',
        detail_save_failed: (msg) => `保存失败：${msg}`,

        // ---- 语言按钮：显示当前语言 ----
        lang_button: '中文'
    }
};

let currentLang = 'en';

// ----------------------------------------------------------
// t(key, ...args)：取文案。
// ----------------------------------------------------------
function t(key, ...args) {
    const dict = I18N[currentLang] || I18N.en;
    const val = dict[key];
    if (typeof val === 'function') return val(...args);
    return val != null ? val : key;
}

// ----------------------------------------------------------
// 遍历 DOM，把带 data-i18n* 的元素文案替换成当前语言
// ----------------------------------------------------------
function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.getAttribute('data-i18n-title'));
    });
}

// ----------------------------------------------------------
// 更新语言按钮文字（显示当前语言）
// ----------------------------------------------------------
function updateLangButton() {
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = t('lang_button');
}

// ----------------------------------------------------------
// 校验语言码，非法值回退到 'en'
// ----------------------------------------------------------
function normalizeLang(lang) {
    return I18N[lang] ? lang : 'en';
}

// ----------------------------------------------------------
// 切换语言
// ----------------------------------------------------------
async function setLang(lang) {
    currentLang = normalizeLang(lang);
    try {
        await chrome.storage.local.set({lang: currentLang});
    } catch (e) {
        // 写失败也无所谓，当前会话仍然按 newLang 渲染
        console.warn('Failed to persist language:', e);
    }
    applyI18n();
    updateLangButton();
    document.dispatchEvent(new CustomEvent('langchange', {detail: {lang: currentLang}}));
}

function toggleLang() {
    void setLang(currentLang === 'en' ? 'zh' : 'en');
}

// ----------------------------------------------------------
// 初始化
// ----------------------------------------------------------
let i18nReadyResolve;
const i18nReady = new Promise(resolve => {
    i18nReadyResolve = resolve;
});

async function initI18n() {
    try {
        const {lang = 'en'} = await chrome.storage.local.get('lang');
        currentLang = normalizeLang(lang);
        applyI18n();
        updateLangButton();

        const btn = document.getElementById('lang-toggle');
        if (btn) btn.onclick = toggleLang;
    } finally {
        // 无论 storage 读取成功还是失败，都要让页面继续渲染
        i18nReadyResolve(currentLang);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
} else {
    void initI18n();
}