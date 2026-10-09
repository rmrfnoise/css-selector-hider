# CSS Selector Hider

Hide elements you don't want to see on any site, using custom CSS selectors.

A zero-dependency, zero-network Chrome extension (Manifest V3).

---

## What it does

You define a rule for a site, listing one or more CSS selectors. When you open a page that matches the rule, elements
matching those selectors are hidden automatically.

For example:

| URL pattern   | Selector              | Effect                                |
|---------------|-----------------------|---------------------------------------|
| `docs.qq.com` | `.ad-banner`          | Hide ad banners in Tencent Docs       |
| `zhihu.com`   | `.RecommendationList` | Hide the recommendation feed on Zhihu |
| `youtube.com` | `#secondary`          | Hide the right sidebar on YouTube     |

Configure once. After that, every visit to that site just works.

---

## Install

The extension isn't on the Chrome Web Store. Load it manually:

1. Download or clone this repository to any local folder
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** in the top-right corner
4. Click **Load unpacked** and select the root folder of this repository
5. The icon appears in the toolbar. Done.

After installation, click the toolbar icon to open the settings page.

> After editing the code, go back to `chrome://extensions` and click the reload button on the extension card.

---

## Usage

### Add a rule

1. In the settings page, type a **URL fragment** into the input at the bottom and click **Add**
2. You'll be taken to the detail page. Fill in the table row by row:
    - **Selector** — a CSS selector, e.g. `.ad-banner`
    - **Note** — optional, just for your own reference
3. Changes are saved automatically. There's no save button.

### How URL matching works

There are three matching modes, chosen automatically by what you type:

| You type      | Matching mode                                          | Example                             |
|---------------|--------------------------------------------------------|-------------------------------------|
| Contains `/`  | Substring match against the full URL                   | `zhihu.com/question/123`            |
| Contains `:`  | Matches `host:port`, port must match exactly           | `localhost:8080`                    |
| Anything else | Treated as a domain; matches itself and all subdomains | `qq.com` also matches `docs.qq.com` |

**Example** (rule = `qq.com`):

- ✅ `https://qq.com/...` — exact match
- ✅ `https://docs.qq.com/...` — subdomain
- ❌ `https://notqq.com/...` — suffix doesn't match
- ❌ `https://qq.com.evil.site` — suffix doesn't match

A leading `.` is stripped automatically, so `.qq.com` and `qq.com` behave identically.

### How to write selectors

Standard CSS selectors. The easiest way is to copy them from DevTools:

1. Right-click the target element → **Inspect**
2. In the Elements panel, right-click the highlighted line → **Copy** → **Copy selector**
3. Paste it into the extension

You can list multiple selectors in one rule. All of them get applied together.

### Edit or delete

- Click the `×` on the right of a list item to delete the whole rule
- Click the rule name to open the detail page, where you can edit the URL, edit selectors, or delete rows one by one

### Import / export

- **Export** — save all rules as a JSON file
- **Import** — load rules from a JSON file. This **replaces** all current rules.

Before importing, the current rules are backed up to `rules_backup` in `chrome.storage.local` (last 3 backups kept).
Import also fills in missing fields and removes duplicate URLs and IDs automatically.

### Language

Both the settings page and the detail page have a language toggle at the bottom. English and Chinese are supported. Your
preference is stored locally and shared across all pages.

---

## Privacy

- **No network requests.** All data lives in `chrome.storage.local`, on your machine.
- **No cookies, no cross-tab access, no page-context injection.**
- **The only permission requested is `storage`.** The content script does exactly one thing: inject a `<style>` tag
  based on your rules.

---

## File structure

```
.
├── manifest.json     Extension manifest
├── background.js     Service worker; opens the settings page on icon click
├── content.js        Content script; reads rules and injects <style>
├── options.html      Rule list page
├── options.js        Rule list logic
├── detail.html       Rule detail page
├── detail.js         Rule detail logic
└── i18n.js           English + Chinese strings, language switcher
```

No build step. No dependencies. No bundler.

---

## How it works

Three steps, in short:

1. **On page load** (`document_start`), `content.js` reads all rules from `chrome.storage.local`
2. It matches rules against the current URL, then merges, deduplicates, and validates all selectors
3. It injects a `<style>` tag into `<html>`, with `selector { display: none !important }` for each valid selector

Injecting a `<style>` tag (rather than writing inline styles on each element) means:

- Dynamically added nodes are covered automatically, no `MutationObserver` needed
- Removing the `<style>` instantly reverts everything, no page reload
- If no rule matches, the extension doesn't touch the page at all

`content.js` also listens to `chrome.storage.onChanged`, so changes made in the settings page take effect
**immediately** on already-open tabs, without a reload.

---

## Deliberately not included

This is a personal project. The following are intentional trade-offs, not oversights:

- No rule groups, tags, or search
- No visual selector picker (DevTools is good enough)
- No cloud sync
- No auto-update
- No unit tests or build tooling — zero-build is a feature of this project

---

## License

MIT