/* global chrome */
// ============================================================
// CSS Selector Hider - 内容脚本
// ============================================================
// 作用：打开任意网站时，自动读取本机存储的规则，
//       匹配当前网址，把规则里列出的 CSS 选择器对应的元素隐藏。
//       多条规则同时匹配时，所有规则的选择器会被合并应用。
//
// 实现方式：向页面注入一个 <style> 标签，而不是逐个元素写 inline style。
//   好处：
//     1. 一次注入搞定所有元素，动态新增的节点自动生效，无需 MutationObserver
//     2. 规则被删/被禁用时，移除 <style> 即可立刻恢复，无需刷新
//     3. 配合 run_at: document_start，能尽量在首屏渲染前生效
//        （注：chrome.storage 是异步读取，慢机器上仍可能有极短暂的闪烁）
//
// 安全边界：
//   - 不发任何网络请求，数据不出本机
//   - 不读 Cookie，不碰其他标签页
//   - 没匹配到规则时立即退出，不修改页面
// ============================================================

(async function () {

    // ----------------------------------------------------------
    // 1. 从本机存储读出所有规则
    // ----------------------------------------------------------
    // 结构是 { rules: [ { id, match, selectors, enabled }, ... ] }
    //
    // 读失败（扩展被 reload/卸载、storage 异常等）时直接退出。
    // 否则整个 async IIFE 会变成一个 unhandled rejection，
    // 后面的 apply 和 onChanged 监听都注册不上——扩展看起来“坏了”。
    let rules = [];
    try {
        const stored = await chrome.storage.local.get('rules');
        rules = Array.isArray(stored.rules) ? stored.rules : [];
    } catch (e) {
        console.warn('[CSS Selector Hider] failed to read rules:', e);
        return;
    }

    // ----------------------------------------------------------
    // 2. 用当前网址匹配规则
    // ----------------------------------------------------------
    // 匹配逻辑（按优先级）：
    //   1) match 里带 "/"       → 当 URL 片段，对 location.href 做子串匹配
    //   2) match 里带 ":"       → 当 host:port，要求端口相等，
    //                              且 hostname 完全相等或以 ".host" 结尾
    //   3) 其余                 → 当域名，要求 hostname 完全相等或以 ".域名" 结尾
    //
    // 域名两端的空白和开头的点会被去掉（容错，比如 ".qq.com" 视作 "qq.com"）
    //
    // 举例（match = "qq.com"）：
    //   ✅ https://qq.com/...           hostname === "qq.com"
    //   ✅ https://docs.qq.com/...      hostname.endsWith(".qq.com")
    //   ❌ https://notqq.com/...        不满足上述任一条件
    //   ❌ https://qq.com.evil.site     hostname.endsWith(".qq.com") 为 false
    //   ❌ https://qq.com.cn/...        同上，不会误匹配
    //
    // 举例（match = "example.com:8080"）：
    //   ✅ http://example.com:8080/...        port === "8080" 且 hostname 匹配
    //   ❌ http://example.com/...             端口不符
    //   ❌ http://example.com:9090/...        端口不符
    function matches(pattern) {
        if (!pattern) return false;
        let p = String(pattern).trim();
        if (!p) return false;

        // 1) URL 片段
        if (p.includes('/')) return location.href.includes(p);

        // 2) 去掉开头的点（容错 ".qq.com" → "qq.com"）
        p = p.replace(/^\.+/, '');
        if (!p) return false;

        // 3) host:port 分支
        //    用 lastIndexOf，让 IPv6 字面量（如 "[::1]:8080"）也能正确切分
        if (p.includes(':')) {
            const colon = p.lastIndexOf(':');
            const hostPart = p.slice(0, colon);
            const portPart = p.slice(colon + 1);
            if (!hostPart || !portPart) return false;
            if (location.port !== portPart) return false;
            const hostname = location.hostname;
            return hostname === hostPart || hostname.endsWith('.' + hostPart);
        }

        // 4) 纯域名
        const hostname = location.hostname;
        return hostname === p || hostname.endsWith('.' + p);
    }

    // 所有 enabled 且匹配当前 URL 的规则
    function pickRules(rules) {
        if (!Array.isArray(rules)) return [];
        return rules.filter(r => r && r.enabled && matches(r.match));
    }

    // ----------------------------------------------------------
    // 3. 取出规则里的合法 selector
    // ----------------------------------------------------------
    // 数据结构是 [{ selector, note }, ...]，只关心 selector 字段。
    // 过滤掉缺少 selector 的项，避免后面拼 CSS 时出现 undefined。
    function extractSelectors(rule) {
        const list = rule && Array.isArray(rule.selectors) ? rule.selectors : [];
        return list.filter(s => s && typeof s === 'object' && s.selector);
    }

    // ----------------------------------------------------------
    // 4. 当前注入的 <style> 元素
    // ----------------------------------------------------------
    let styleEl = null;

    // ----------------------------------------------------------
    // 5. 应用规则
    // ----------------------------------------------------------
    function apply(rules) {
        // 先清掉上一次注入的样式，这样规则被改/被禁用能立刻恢复
        if (styleEl) {
            styleEl.remove();
            styleEl = null;
        }

        const matched = pickRules(rules);
        if (!matched.length) return;

        // 合并所有匹配规则的选择器，去重 + 过滤非法
        // （一条非法选择器会让整段 CSS 失效，所以必须先验一遍）
        const seen = new Set();
        const valid = [];
        for (const rule of matched) {
            for (const {selector} of extractSelectors(rule)) {
                if (seen.has(selector)) continue;
                seen.add(selector);
                try {
                    document.querySelector(selector);
                    valid.push(selector);
                } catch (e) {
                    // 非法选择器，跳过
                }
            }
        }

        if (!valid.length) return;

        const css = valid.map(s => `${s}{display:none !important}`).join('\n');

        styleEl = document.createElement('style');
        styleEl.textContent = css;
        // document_start 时 <head> 可能还不存在，挂到 <html> 上最稳
        document.documentElement.appendChild(styleEl);
    }

    // ----------------------------------------------------------
    // 6. 启动
    // ----------------------------------------------------------
    // document_start 阶段 documentElement 一定存在，直接执行即可。
    // body 还不存在也没关系，因为我们是往 <html> 里加 <style>。
    function boot() {
        apply(rules);
    }

    if (document.documentElement) {
        boot();
    } else {
        // 极端兜底，正常不会走到
        document.addEventListener('DOMContentLoaded', boot, {once: true});
    }

    // ----------------------------------------------------------
    // 7. 监听规则变化：用户在设置页改完规则，已打开的页面立刻生效
    // ----------------------------------------------------------
    // 外面包一层 try/catch：apply 内部虽然对单条选择器做了容错，
    // 但如果是 storage 事件本身传来的数据结构异常（比如 null），
    // 也不应该让异常冒泡到浏览器控制台。
    // noinspection JSUnresolvedVariable,JSDeprecatedSymbols
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.rules) return;
        try {
            apply(changes.rules.newValue || []);
        } catch (e) {
            console.warn('[CSS Selector Hider] failed to apply new rules:', e);
        }
    });

})();