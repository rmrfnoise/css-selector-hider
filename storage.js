/* global chrome */
// ============================================================
// CSS Selector Hider - 存储层
// ============================================================
// options.html 和 detail.html 共用的读写逻辑。
//
// 这些函数原来在两个页面里各复制了一份，已经漂移出不一致的行为
// （详情页删整条规则没走 safeSetRules，写盘失败也照样跳转）。
// 现在统一收口在这里，两个页面都不再自己碰 chrome.storage。
//
// 加载顺序：storage.js → ui.js → options.js / detail.js
//
// 用法（普通 script，无构建、无模块）：
//   const {getRules, safeSetRules} = CSHStorage;
// ============================================================

(function (global) {

    // 导入备份保留份数
    const MAX_BACKUPS = 3;

    // ----------------------------------------------------------
    // 数据规整
    // ----------------------------------------------------------

    // 判断一个 selector 条目是否“空”（没有任何有效信息）
    function isEmptySel(s) {
        if (!s || typeof s !== 'object') return true;
        const sel = typeof s.selector === 'string' ? s.selector.trim() : '';
        const note = typeof s.note === 'string' ? s.note.trim() : '';
        return !sel && !note;
    }

    // 把导入或其他来源的 selectors 归一化成 [{selector, note}]，并清掉空行。
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

    // 网址 pattern 归一化。两件事必须在这里做，而且两个页面必须用同一份：
    //   1. 去掉开头的点 —— ".qq.com" 和 "qq.com" 是同一件事
    //   2. 域名/端口转小写 —— location.hostname 恒为小写，
    //      不转的话 "QQ.com" 存进去永远匹配不上，用户只会觉得“规则没生效”
    //
    // 含 "/" 的是 URL 片段：路径大小写敏感、点号有意义，原样保留。
    //
    // 不做归一化的话，qq.com / .qq.com / QQ.com 会变成三条看着不同、
    // 实际等价（或者干脆不生效）的规则，去重也就形同虚设。
    function normalizeMatch(m) {
        const v = String(m == null ? '' : m).trim();
        if (!v || v.includes('/')) return v;
        return v.replace(/^\.+/, '').toLowerCase();
    }

    // 一条 match 实际会被当成哪种匹配方式（顺序要和 content.js 的 matches() 一致）：
    //   含 "/"   → 'url'    对完整网址做子串匹配
    //   含 ":"   → 'port'   host:port，端口必须相等
    //   其余     → 'domain' 域名，含子域
    // 界面用它把隐式规则显式标出来；空值返回 ''，不显示标签。
    function matchMode(pattern) {
        const v = String(pattern == null ? '' : pattern).trim();
        if (!v) return '';
        if (v.includes('/')) return 'url';
        if (v.replace(/^\.+/, '').includes(':')) return 'port';
        return 'domain';
    }

    function genId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // 把任意来源（导入文件、导入前的备份）的规则数组清洗成可以存的样子：
    //   1. 过滤掉 null / 数组 / 非对象
    //   2. 补 id、补 enabled，规范化 selectors 和 match
    //   3. 去掉空 match
    //   4. 按归一化后的 match 去重（保留第一条）
    //   5. 按 id 去重（重复的重新生成 id）—— 否则后续按 id 编辑/删除会命中错行
    function sanitizeRules(input) {
        if (!Array.isArray(input)) return [];

        const seenMatch = new Set();
        const seenId = new Set();

        return input
            .filter(r => r && typeof r === 'object' && !Array.isArray(r))
            .map(r => {
                let id = typeof r.id === 'string' && r.id ? r.id : genId();
                if (seenId.has(id)) id = genId();
                seenId.add(id);
                return {
                    id,
                    match: typeof r.match === 'string' ? normalizeMatch(r.match) : '',
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
    }

    // ----------------------------------------------------------
    // 基础读写
    // ----------------------------------------------------------
    async function getRules() {
        const {rules = []} = await chrome.storage.local.get('rules');
        return Array.isArray(rules) ? rules : [];
    }

    async function setRules(rules) {
        await chrome.storage.local.set({rules});
    }

    // 写盘 + 错误提示。返回是否成功。
    // 调用方必须根据返回值决定要不要继续（刷新 UI、跳页等），
    // 否则一次失败的写入会静默丢掉，用户以为改好了，实际没有。
    async function safeSetRules(rules) {
        try {
            await setRules(rules);
            return true;
        } catch (e) {
            alert('Save failed: ' + ((e && e.message) || String(e)));
            return false;
        }
    }

    // ----------------------------------------------------------
    // 串行写队列
    // ----------------------------------------------------------
    // 所有 read-modify-write 都排进同一条链串行执行。
    // 否则两次快速改动会各自读到同一份旧快照，
    // 后写的那次直接覆盖先写的那次，前一次的改动就丢了。
    //
    // 两个页面共用一条链，所以详情页删规则不会和正在排队的编辑互相踩。
    let writeChain = Promise.resolve();

    function enqueue(run) {
        // 前一个任务无论成功还是失败，都要继续排下一个
        const next = writeChain.then(run, run);
        writeChain = next.then(() => {
        }, () => {
        });
        return next;
    }

    // 修改一条规则。mutator 直接改传入的规则对象（就地改，别返回新对象）。
    //
    // 返回值：
    //   {ok: true,  rule}            写盘成功，rule 是更新后的规则
    //   {ok: false, reason: 'gone'}  规则已不存在（比如在另一个标签页删掉了）
    //   {ok: false, reason: 'save'}  写盘失败（已 alert），或 mutator 自己抛错
    function updateRuleById(id, mutator) {
        return enqueue(async () => {
            const rules = await getRules();
            const i = rules.findIndex(r => String(r.id) === String(id));
            if (i < 0) return {ok: false, reason: 'gone'};

            // mutator 抛错（比如行号已经越界）不应该变成一个没人处理的 rejection，
            // 当成“这次没改成”处理，让调用方回滚界面。
            try {
                mutator(rules[i]);
            } catch (e) {
                console.warn('[CSS Selector Hider] mutator failed:', e);
                return {ok: false, reason: 'save'};
            }

            try {
                await setRules(rules);
            } catch (e) {
                alert('Save failed: ' + ((e && e.message) || String(e)));
                return {ok: false, reason: 'save'};
            }

            return {ok: true, rule: rules[i]};
        });
    }

    // 删除一条规则。同样排队，避免和别的页面里正在排队的编辑互相覆盖。
    function removeRuleById(id) {
        return enqueue(async () => {
            const rules = await getRules();
            const i = rules.findIndex(r => String(r.id) === String(id));
            if (i < 0) return {ok: false, reason: 'gone'};

            rules.splice(i, 1);
            if (!await safeSetRules(rules)) return {ok: false, reason: 'save'};
            return {ok: true};
        });
    }

    // ----------------------------------------------------------
    // 导入备份 / 撤销导入
    // ----------------------------------------------------------
    // 导入是全项目唯一会大面积覆盖数据的操作，而且它依赖用户"记得先导出"。
    // 所以导入前自动存一份快照，导入后可以通过"撤销导入"读回来。
    //
    // 快照按时间倒序排列，最多留 MAX_BACKUPS 份；撤销一次就弹出一份，
    // 连点两次会继续往前回滚（恢复到上一次导入之前的状态）。
    //
    // 存的结构：[{at: '2026-11-04T...', rules: [...]}, ...]
    async function getBackups() {
        const {rules_backup = []} = await chrome.storage.local.get('rules_backup');
        if (!Array.isArray(rules_backup)) return [];
        // 结构不对的条目直接丢掉，别让一条脏数据挡住整个撤销入口
        return rules_backup.filter(b => b && typeof b === 'object' && Array.isArray(b.rules));
    }

    // 把当前规则存成一份快照（导入前调用）
    async function pushBackup(rules) {
        const list = await getBackups();
        const next = [{at: new Date().toISOString(), rules}, ...list].slice(0, MAX_BACKUPS);
        await chrome.storage.local.set({rules_backup: next});
    }

    // 撤销上次导入：把最新一份快照还原成 rules，并把它从栈里弹出。
    // 走写队列，避免和正在排队的编辑互相覆盖。
    //
    // 返回值：
    //   {ok: true, ruleCount, at}   已还原
    //   {ok: false, reason: 'empty'} 没有可用的备份
    //   {ok: false, reason: 'save'}  写盘失败（已 alert）
    function restoreLastBackup() {
        return enqueue(async () => {
            const backups = await getBackups();
            if (!backups.length) return {ok: false, reason: 'empty'};

            const [latest, ...rest] = backups;
            const cleaned = sanitizeRules(latest.rules);
            if (!await safeSetRules(cleaned)) return {ok: false, reason: 'save'};

            // 还原成功后把这快照移出栈；这一步失败不影响已经还原的规则，
            // 只是下次撤销会重复恢复同一份
            try {
                await chrome.storage.local.set({rules_backup: rest});
            } catch (e) {
                console.warn('[CSS Selector Hider] failed to drop restored backup:', e);
            }

            return {ok: true, ruleCount: cleaned.length, at: latest.at};
        });
    }

    global.CSHStorage = {
        genId,
        getRules,
        safeSetRules,
        normalizeMatch,
        matchMode,
        sanitizeRules,
        getBackups,
        pushBackup,
        restoreLastBackup,
        updateRuleById,
        removeRuleById
    };
})(globalThis);
