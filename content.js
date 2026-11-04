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
//   - 拒绝一切 @ 开头的 at-rule：@import 会联网，@media 会让语义变形
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

    // 当前生效的规则。storage 变化时整份替换，网址巡检时复用它。
    let activeRules = rules;

    // ----------------------------------------------------------
    // 2. 用当前网址匹配规则
    // ----------------------------------------------------------
    // 匹配逻辑（按优先级）：
    //   1) match 里带 "/"       → 当 URL 片段，对 location.href 做子串匹配
    //   2) match 里带 ":"       → 当 host:port，要求端口相等，
    //                              且 hostname 完全相等或以 ".host" 结尾
    //   3) 其余                 → 当域名，要求 hostname 完全相等或以 ".域名" 结尾
    //
    // 域名两端的空白、开头的点会被去掉，并且转成小写
    // （location.hostname 恒为小写，存储层写入时也做过同样归一化，
    //   这里兜的是手改 storage 或旧版本留下的数据）
    //
    // 举例（match = "qq.com"）：
    //   ✅ https://qq.com/...           hostname === "qq.com"
    //   ✅ https://docs.qq.com/...      hostname.endsWith(".qq.com")
    //   ❌ https://notqq.com/...        不满足上述任一条件
    //   ❌ https://qq.com.evil.site     hostname.endsWith(".qq.com") 为 false
    //   ❌ https://qq.com.cn/...        同上，不会误匹配
    //   ✅ https://qq.com/...           match 写成 "QQ.com" 也能匹配
    //
    // 举例（match = "example.com:8080"）：
    //   ✅ http://example.com:8080/...        port === "8080" 且 hostname 匹配
    //   ❌ http://example.com/...             端口不符
    //   ❌ http://example.com:9090/...        端口不符
    function matches(pattern) {
        if (!pattern) return false;
        let p = String(pattern).trim();
        if (!p) return false;

        // 1) URL 片段：路径大小写敏感，不做任何改写
        if (p.includes('/')) return location.href.includes(p);

        // 2) 去掉开头的点（容错 ".qq.com" → "qq.com"）并转小写
        p = p.replace(/^\.+/, '').toLowerCase();
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

    // 所有匹配当前 URL 的规则。
    // enabled 判定用 !== false：手改 storage、或者从别处导入的旧数据可能根本没有
    // enabled 字段，按"缺省即启用"处理更符合预期。
    function pickRules(list) {
        if (!Array.isArray(list)) return [];
        return list.filter(r => r && r.enabled !== false && matches(r.match));
    }

    // ----------------------------------------------------------
    // 3. 取出规则里的合法 selector
    // ----------------------------------------------------------
    // 数据结构是 [{ selector, note }, ...]，只关心 selector 字段。
    function extractSelectors(rule) {
        const list = rule && Array.isArray(rule.selectors) ? rule.selectors : [];
        return list.filter(s => s && typeof s === 'object' && s.selector);
    }

    // ----------------------------------------------------------
    // 4. 判断一个选择器能不能写进样式表
    // ----------------------------------------------------------
    // 用 CSS 解析器本身判断（CSSStyleSheet.insertRule），而不是 document.querySelector：
    //   - querySelector 会拒掉 ::before / ::-webkit-scrollbar 这类伪元素，
    //     但它们完全可以写进样式表——用 querySelector 校验等于白丢一组功能
    //   - insertRule 失败会抛 SyntaxError，跟浏览器真正解析样式表时的规则一致，
    //     不会出现"校验通过了、实际整条规则被丢掉"的情况
    //
    // 必须自己挡的洞：以 @ 开头的是 at-rule。
    //   @import 会发起网络请求，直接推翻"不发任何网络请求"的承诺；
    //   @media / @supports 等则会让选择器的语义整体变形，用户根本预料不到。
    let probeSheet = null;

    function isUsableSelector(selector) {
        if (typeof selector !== 'string') return false;
        const s = selector.trim();
        if (!s || s.startsWith('@')) return false;

        if (!probeSheet) {
            try {
                probeSheet = new CSSStyleSheet();
            } catch (e) {
                return false;
            }
        }

        try {
            probeSheet.insertRule(`${s}{display:none !important}`, 0);
            probeSheet.deleteRule(0);
            return true;
        } catch (e) {
            // 非法选择器，跳过
            return false;
        }
    }

    // ----------------------------------------------------------
    // 5. 把规则算成 CSS 文本
    // ----------------------------------------------------------
    // 合并所有匹配规则的选择器，去重 + 过滤非法。
    // 返回空字符串表示"当前网址不需要隐藏任何东西"。
    function buildCss(list) {
        const matched = pickRules(list);
        if (!matched.length) return '';

        const seen = new Set();
        const valid = [];
        for (const rule of matched) {
            for (const item of extractSelectors(rule)) {
                // 存储里的 selector 理论上都是字符串，但手改 storage 可能塞别的类型，
                // 这里挡一下，避免 .trim() 抛错把整个 apply 打断
                if (typeof item.selector !== 'string') continue;
                const selector = item.selector.trim();
                if (!selector || seen.has(selector)) continue;
                seen.add(selector);
                if (!isUsableSelector(selector)) continue;
                valid.push(selector);
            }
        }

        if (!valid.length) return '';
        return valid.map(s => `${s}{display:none !important}`).join('\n');
    }

    // ----------------------------------------------------------
    // 6. 当前注入的 <style> 元素
    // ----------------------------------------------------------
    let styleEl = null;
    // 上一次真正写进页面里的 CSS。null 表示还没写过，
    // 保证第一次调用一定会注入（哪怕 CSS 是空字符串）。
    let lastCss = null;

    function swapStyle(css) {
        // 先清掉上一次注入的样式，这样规则被改/被禁用能立刻恢复
        if (styleEl) {
            styleEl.remove();
            styleEl = null;
        }
        if (!css) return;

        styleEl = document.createElement('style');
        styleEl.textContent = css;
        // document_start 时 <head> 可能还不存在，挂到 <html> 上最稳
        (document.head || document.documentElement).appendChild(styleEl);
    }

    // 注入的 <style> 是否还挂在文档上。
    // 少数页面会整体重写 <head> 或 <html>，连带把我们的 <style> 清掉；
    // 这种情况 CSS 内容没变，但仍然要重新注入一次。
    // （isConnected 不存在的环境当作"还在"，退回纯内容比较）
    function isStyleAlive() {
        return !styleEl || styleEl.isConnected !== false;
    }

    // 核心入口：算 CSS → 变了才动 DOM。
    // 网址巡检和 storage 变化都会高频调用它，所以"没变化就直接返回"
    // 是必须的，否则 SPA 每次 pushState 都要重建一次 <style>。
    function apply() {
        const css = buildCss(activeRules);
        if (css === lastCss && isStyleAlive()) return;
        lastCss = css;
        swapStyle(css);
    }

    // ----------------------------------------------------------
    // 7. 启动
    // ----------------------------------------------------------
    // document_start 阶段 documentElement 一定存在，直接执行即可。
    // body 还不存在也没关系，因为我们是往 <html> 里加 <style>。
    function boot() {
        apply();
    }

    if (document.documentElement) {
        boot();
    } else {
        // 极端兜底，正常不会走到
        document.addEventListener('DOMContentLoaded', boot, {once: true});
    }

    // ----------------------------------------------------------
    // 8. 监听规则变化：用户在设置页改完规则，已打开的页面立刻生效
    // ----------------------------------------------------------
    // 外面包一层 try/catch：buildCss 内部虽然对单条选择器做了容错，
    // 但如果是 storage 事件本身传来的数据结构异常（比如 null），
    // 也不应该让异常冒泡到浏览器控制台。
    // noinspection JSUnresolvedVariable,JSDeprecatedSymbols
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.rules) return;
        try {
            const next = changes.rules.newValue;
            activeRules = Array.isArray(next) ? next : [];
            apply();
        } catch (e) {
            console.warn('[CSS Selector Hider] failed to apply new rules:', e);
        }
    });

    // ----------------------------------------------------------
    // 9. 监听网址变化（SPA 内部跳转）
    // ----------------------------------------------------------
    // 只监听文档加载是不够的：知乎、YouTube、腾讯文档这类站点都在同一个
    // document 里用 history.pushState 换页，不会重新执行内容脚本。于是
    //   - 从首页点进文章，带路径的规则（如 zhihu.com/question/123）不生效
    //   - 从文章页跳回首页，旧规则还在继续隐藏，用户只觉得内容缺了一块
    //
    // pushState / replaceState 不派发任何事件，而内容脚本跑在隔离世界，
    // 覆写 window.history.pushState 拦不到页面自己的调用（改的是自己那份
    // 函数对象），所以只能"事件 + 低频巡检"双保险。
    let lastHref = location.href;

    function refreshIfNeeded() {
        const urlChanged = location.href !== lastHref;
        // lastCss 非 null 说明之前确实往页面里写过东西，
        // 这时候 style 掉了才需要补（没匹配到规则的页面本来就没有 style）
        const styleLost = lastCss !== null && !isStyleAlive();

        if (!urlChanged && !styleLost) return;

        lastHref = location.href;
        // 清掉内容缓存，让 apply 跳过"内容没变就不动 DOM"的短路
        if (styleLost) lastCss = null;

        try {
            apply();
        } catch (e) {
            console.warn('[CSS Selector Hider] failed to apply on url change:', e);
        }
    }

    window.addEventListener('popstate', refreshIfNeeded);
    window.addEventListener('hashchange', refreshIfNeeded);

    // 500ms 巡检：可见标签页里只是一次字符串比较，开销可以忽略；
    // 后台标签页会被浏览器节流到 1 分钟一次，也不影响使用。
    setInterval(refreshIfNeeded, 500);

})();
