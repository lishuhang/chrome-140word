// ===== 140字摘要 v1.8 — Background Service Worker =====
// NOTE: Turndown.js is NOT loaded here — Service Workers lack DOMParser,
// which Turndown needs when parsing HTML strings. Instead, we inject
// turndown.js into the PAGE context (which has full DOM APIs) and
// pass a DOM node directly to Turndown, bypassing DOMParser entirely.

const DEFAULT_PROMPT = `简化下列文章表述为200字以内的类似techmeme的一句话总结，不分段，无样式，一整段话；在一条微博的长度内尽可能容纳所有有效信息，以倒金字塔形式，将最重要的信息最先说出；必须保留原文中的关键数字（金额、比例、数量、日期等），数字是最重要的信息之一；不论提供给你任何语言，输出语言均为中文。输入内容为网页完整Markdown，你应聚焦于正文主体，忽略导航菜单、页头页脚、广告、社交分享、侧边栏、站内推广等非正文内容；除非品牌名是报道事件中的当事人，否则摘要中不得出现网站品牌名或宣传用语。`;

// Built-in site-specific supplementary prompts (behavioral hints only, no more CSS selectors)
const BUILTIN_SITE_PROMPTS = [
  {
    domain: 'businessinsider.com',
    prompt: '【businessinsider.com专属规则】此网站页面中充斥大量自我推广口号（如"Business Insider tells the innovative stories you want to know"等），以及订阅推广、导航链接等非正文内容；你必须完全忽略这些内容，摘要中绝对不得出现"Business Insider"品牌名或其宣传用语，除非它是报道事件中的当事人；只从最长的连贯正文段落提取信息。',
    builtin: true
  }
];

// Internal browser pages that can never be summarized
const INTERNAL_URL_PREFIXES = /^(chrome|chrome-extension|edge|about|devtools|chrome-search|blob|data|javascript|view-source):/i;

// Check if URL is a local file
function isLocalFileUrl(url) { return /^file:/i.test(url); }

// Extract the registrable domain (eTLD+1) from a hostname
function extractRegistrableDomain(hostname) {
  if (!hostname) return hostname;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname) || hostname === 'localhost') return hostname;
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const SLD_SET = new Set([
    'co.uk','org.uk','ac.uk','gov.uk','net.uk',
    'co.jp','or.jp','ne.jp','ac.jp','go.jp',
    'co.kr','or.kr','go.kr',
    'com.au','net.au','org.au',
    'com.br','net.br','org.br',
    'com.cn','net.cn','org.cn','gov.cn',
    'com.hk','com.tw','com.sg',
    'co.in','net.in','org.in',
    'co.nz','net.nz','org.nz',
    'co.za','org.za','web.za',
    'com.mx','org.mx',
    'com.ar','com.tr','com.my',
    'co.il','co.th'
  ]);

  const lastTwo = parts.slice(-2).join('.');
  if (SLD_SET.has(lastTwo)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// Queue state
let summarizeQueue = [];
let isProcessing = false;
let currentProcessingItem = null;
let sidebarPort = null;

// --- Init ---
chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (details.reason === 'install') {
    chrome.storage.sync.get('sitePrompts', ({ sitePrompts }) => {
      if (!sitePrompts) {
        chrome.storage.sync.set({ sitePrompts: BUILTIN_SITE_PROMPTS.map(p => ({ ...p })) });
      }
    });
  } else if (details.reason === 'update') {
    // Migration: convert old sitePrompts with selector fields to new format (prompt only)
    chrome.storage.sync.get('sitePrompts', ({ sitePrompts = [] }) => {
      let changed = false;
      const migrated = sitePrompts.map(sp => {
        const cleaned = { domain: sp.domain, prompt: sp.prompt || '', builtin: !!sp.builtin };
        // Check if old format had selector fields
        if (sp.removeSelectors !== undefined || sp.preferSelector !== undefined) {
          changed = true;
        }
        return cleaned;
      });
      // Add any new built-in prompts that don't already exist
      const existingDomains = new Set(migrated.map(sp => sp.domain));
      for (const bp of BUILTIN_SITE_PROMPTS) {
        if (!existingDomains.has(bp.domain)) {
          migrated.push({ ...bp });
          changed = true;
        }
      }
      if (changed) chrome.storage.sync.set({ sitePrompts: migrated });
    });
  }
});

// --- Sidebar connection (persistent) ---
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'sidebar') {
    sidebarPort = port;
    port.onDisconnect.addListener(() => { sidebarPort = null; });
    port.onMessage.addListener(msg => {
      if (msg.action === 'sidebarReady') {
        autoSummarizeCurrentTab();
      }
    });
  }
});

// --- Message router ---
chrome.runtime.onMessage.addListener((req, _sender, respond) => {
  const handlers = {
    summarize: () => handleSummarize(respond, false),
    forceSummarize: () => handleSummarize(respond, true),
    getHistory: () => getHistory().then(h => respond({ success: true, history: h })).catch(e => respond({ success: false, error: e.message })),
    clearHistory: () => clearHistory().then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    exportHistory: () => exportHistory().then(d => respond({ success: true, data: d })).catch(e => respond({ success: false, error: e.message })),
    deleteHistoryItem: () => deleteHistoryItem(req.id).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    getQueueStatus: () => respond({ success: true, processing: currentProcessingItem ? { url: currentProcessingItem.url, title: currentProcessingItem.title } : null, waitingCount: summarizeQueue.length, queueItems: summarizeQueue.map(q => ({ url: q.url, title: q.title })) }),
    checkSkipStatus: () => checkSkipStatus(req.url).then(r => respond({ success: true, ...r })).catch(e => respond({ success: false, error: e.message })),
    addToSkipList: () => addToSkipList(req.pattern).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    removeFromSkipList: () => removeFromSkipList(req.pattern).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    getSkipList: () => getSkipList().then(l => respond({ success: true, skipList: l })).catch(e => respond({ success: false, error: e.message })),
    saveSkipList: () => saveSkipList(req.skipList).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    getSitePrompts: () => getSitePrompts().then(l => respond({ success: true, sitePrompts: l })).catch(e => respond({ success: false, error: e.message })),
    saveSitePrompt: () => saveSitePrompt(req.domain, req.prompt, req.builtin).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    deleteSitePrompt: () => deleteSitePrompt(req.domain).then(() => respond({ success: true })).catch(e => respond({ success: false, error: e.message })),
    getSiteConfigForUrl: () => getSiteConfigForUrl(req.url).then(r => respond({ success: true, ...r })).catch(e => respond({ success: false, error: e.message })),
    exportSettings: () => exportSettings().then(d => respond({ success: true, data: d })).catch(e => respond({ success: false, error: e.message })),
    importSettings: () => importSettings(req.data).then(r => respond(r)).catch(e => respond({ success: false, error: e.message })),
  };
  if (handlers[req.action]) { handlers[req.action](); return true; }
});

// --- Skip list management ---
async function getSkipList() {
  const { skipList = [] } = await chrome.storage.sync.get('skipList');
  return skipList;
}

async function saveSkipList(skipList) {
  await chrome.storage.sync.set({ skipList: skipList || [] });
}

async function addToSkipList(pattern) {
  const skipList = await getSkipList();
  if (!skipList.includes(pattern)) {
    skipList.push(pattern);
    await chrome.storage.sync.set({ skipList });
  }
}

async function removeFromSkipList(pattern) {
  let skipList = await getSkipList();
  skipList = skipList.filter(p => p !== pattern);
  await chrome.storage.sync.set({ skipList });
}

async function checkSkipStatus(url) {
  if (!url || INTERNAL_URL_PREFIXES.test(url)) {
    return { isSystemPage: true, isLocalFile: false, isSkipped: true, matchedPattern: null, pagePattern: null, sitePattern: null };
  }

  const localFile = isLocalFileUrl(url);
  const pagePattern = extractPagePattern(url);
  const sitePattern = extractSitePattern(url);

  if (localFile) {
    return { isSystemPage: false, isLocalFile: true, isSkipped: true, matchedPattern: null, pagePattern, sitePattern };
  }

  const skipList = await getSkipList();
  for (const pattern of skipList) {
    if (urlMatchesPattern(url, pattern)) {
      return { isSystemPage: false, isLocalFile: false, isSkipped: true, matchedPattern: pattern, pagePattern, sitePattern };
    }
  }
  return { isSystemPage: false, isLocalFile: false, isSkipped: false, matchedPattern: null, pagePattern, sitePattern };
}

function urlMatchesPattern(url, pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  const sitePatternMatch = trimmed.match(/^\*\.(.+?)\/\*$/);
  if (sitePatternMatch) {
    try {
      const u = new URL(url);
      const patternDomain = sitePatternMatch[1];
      return u.hostname === patternDomain || u.hostname.endsWith('.' + patternDomain);
    } catch {
      return false;
    }
  }

  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    const re = new RegExp('^' + escaped + '$', 'i');
    return re.test(url);
  } catch {
    return false;
  }
}

function extractSitePattern(url) {
  try {
    const u = new URL(url);
    const domain = extractRegistrableDomain(u.hostname);
    return `*.${domain}/*`;
  } catch {
    return url;
  }
}

function extractPagePattern(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

// --- Site-specific prompts management ---
async function getSitePrompts() {
  const { sitePrompts = [] } = await chrome.storage.sync.get('sitePrompts');
  return sitePrompts;
}

async function saveSitePrompt(domain, prompt, builtin = false) {
  const { sitePrompts = [] } = await chrome.storage.sync.get('sitePrompts');
  const idx = sitePrompts.findIndex(sp => sp.domain === domain);
  const entry = { domain, prompt, builtin: !!builtin };
  if (idx >= 0) {
    sitePrompts[idx] = entry;
  } else {
    sitePrompts.push(entry);
  }
  await chrome.storage.sync.set({ sitePrompts });
}

async function deleteSitePrompt(domain) {
  const { sitePrompts = [] } = await chrome.storage.sync.get('sitePrompts');
  await chrome.storage.sync.set({ sitePrompts: sitePrompts.filter(sp => sp.domain !== domain) });
}

async function getSiteConfigForUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname;
    const { sitePrompts = [] } = await chrome.storage.sync.get('sitePrompts');
    for (const sp of sitePrompts) {
      if (hostname === sp.domain || hostname.endsWith('.' + sp.domain)) {
        return { prompt: sp.prompt || '' };
      }
    }
  } catch {}
  return { prompt: '' };
}

// --- Send full queue status to sidebar ---
function sendQueueStatus() {
  notifySidebar('queueStatus', {
    processing: currentProcessingItem ? { url: currentProcessingItem.url, title: currentProcessingItem.title } : null,
    waitingCount: summarizeQueue.length,
    queueItems: summarizeQueue.map(q => ({ url: q.url, title: q.title }))
  });
}

// --- Tab change: only queue if sidebar is open ---
chrome.tabs.onActivated.addListener(activeInfo => {
  if (sidebarPort) autoSummarizeTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (sidebarPort && changeInfo.status === 'complete' && tab.active) {
    autoSummarizeTab(tabId);
  }
});

// --- Auto-summarize when sidebar opens ---
async function autoSummarizeCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) autoSummarizeTab(tab.id);
  } catch {}
}

// --- Helper: inject Turndown + extraction function into page context ---
// This two-step approach is necessary because:
// 1. Service Workers lack DOMParser, so Turndown can't parse HTML strings there
// 2. By injecting turndown.js into the page context first, TurndownService
//    becomes available in the extension's isolated world
// 3. Then we inject our extraction function, which passes a DOM node (not a
//    string) to Turndown — this bypasses DOMParser entirely (Turndown just
//    does cloneNode on DOM nodes)
async function extractPageMarkdown(tabId) {
  // Step 1: Inject Turndown library into the page's isolated world
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['turndown.js']
    });
  } catch {}

  // Step 2: Inject extraction function that uses TurndownService
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      function: extractPageAsMarkdown
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function autoSummarizeTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;

    if (INTERNAL_URL_PREFIXES.test(tab.url)) return;

    if (isLocalFileUrl(tab.url)) {
      notifySidebar('pageSkipped', { url: tab.url, title: tab.title, isLocalFile: true, isSystemPage: false, matchedPattern: null, pagePattern: extractPagePattern(tab.url), sitePattern: extractSitePattern(tab.url) });
      return;
    }

    notifySidebar('tabEvaluating', { url: tab.url, title: tab.title });

    const skipStatus = await checkSkipStatus(tab.url);
    if (skipStatus.isSkipped) {
      notifySidebar('pageSkipped', { url: tab.url, title: tab.title, matchedPattern: skipStatus.matchedPattern, isSystemPage: skipStatus.isSystemPage, isLocalFile: false, pagePattern: skipStatus.pagePattern, sitePattern: skipStatus.sitePattern });
      return;
    }

    const cached = await getCached(tab.url);
    if (cached) {
      const history = await getHistory();
      if (!history.some(h => h.url === tab.url)) {
        await historySave(cached.summary, tab.url, cached.title || tab.title, 'cached');
      }
      notifySidebar('summaryReady', { summary: cached.summary, url: tab.url, title: cached.title || tab.title, fromCache: true });
      return;
    }

    if (currentProcessingItem?.url === tab.url) {
      notifySidebar('processingStarted', { url: tab.url, title: currentProcessingItem.title });
      sendQueueStatus();
      return;
    }
    if (summarizeQueue.some(q => q.url === tab.url)) {
      notifySidebar('joinedQueue', { url: tab.url, title: tab.title });
      sendQueueStatus();
      return;
    }

    // Extract page content as Markdown using Turndown in page context
    let extractedData = await extractPageMarkdown(tab.id);

    // Fallback: simple text extraction from fetch (no Turndown, no DOMParser needed
    // in Service Worker — we use the old selector-based approach as last resort)
    if (!extractedData?.text?.trim()) {
      try {
        const resp = await fetch(tab.url);
        const html = await resp.text();
        extractedData = extractPageTextFromString(html, tab.title);
      } catch {}
    }

    if (!extractedData?.text?.trim()) {
      notifySidebar('queueError', { url: tab.url, title: tab.title, error: '无法从页面提取有效文本' });
      return;
    }

    const item = {
      tabId: tab.id,
      url: tab.url,
      title: extractedData.title || tab.title || '',
      extractedText: extractedData.text,
    };
    summarizeQueue.push(item);

    notifySidebar('joinedQueue', { url: tab.url, title: item.title });
    sendQueueStatus();

    processQueue();
  } catch {}
}

// --- Process queue sequentially ---
async function processQueue() {
  if (isProcessing || summarizeQueue.length === 0) return;
  isProcessing = true;

  while (summarizeQueue.length > 0) {
    currentProcessingItem = summarizeQueue.shift();
    notifySidebar('processingStarted', { url: currentProcessingItem.url, title: currentProcessingItem.title });
    sendQueueStatus();

    try {
      await processQueueItem(currentProcessingItem);
    } catch (e) {
      notifySidebar('queueError', { url: currentProcessingItem.url, title: currentProcessingItem.title, error: e.message });
    }

    currentProcessingItem = null;
    sendQueueStatus();
  }

  isProcessing = false;
}

async function processQueueItem(item) {
  const cfg = await chrome.storage.sync.get(['apiKey', 'model', 'systemPrompt']);
  if (!cfg.apiKey || !cfg.model) {
    notifySidebar('configMissing', { url: item.url, title: item.title });
    return;
  }

  const cached = await getCached(item.url);
  if (cached) {
    notifySidebar('summaryReady', { summary: cached.summary, url: item.url, title: cached.title || item.title, fromCache: true });
    return;
  }

  let text = item.extractedText;
  let title = item.title;

  // Fallback: try to extract again if pre-extracted text is empty
  if (!text?.trim()) {
    let data = null;

    // Try page injection first (Turndown in page context)
    try {
      const tab = await chrome.tabs.get(item.tabId).catch(() => null);
      if (tab && !tab.discarded) {
        data = await extractPageMarkdown(item.tabId);
      }
    } catch {}

    // Fallback: fetch + simple text extraction
    if (!data?.text?.trim()) {
      try {
        const resp = await fetch(item.url);
        const html = await resp.text();
        data = extractPageTextFromString(html, item.title);
      } catch {}
    }

    if (!data?.text?.trim()) {
      notifySidebar('queueError', { url: item.url, title: item.title, error: '无法从页面提取有效文本' });
      return;
    }
    text = data.text;
    title = data.title || item.title;
  }

  // Build system prompt with site-specific supplement
  let systemPrompt = cfg.systemPrompt?.trim() || DEFAULT_PROMPT;
  const siteConfig = await getSiteConfigForUrl(item.url);
  if (siteConfig.prompt) {
    systemPrompt += '\n\n' + siteConfig.prompt;
  }

  // Call API
  let summary;
  try {
    summary = await callAPI(text, title, item.url, cfg.model, cfg.apiKey, systemPrompt);
  } catch (e) {
    notifySidebar('queueError', { url: item.url, title: item.title, error: 'API 调用失败: ' + e.message });
    return;
  }

  if (!summary?.trim()) {
    notifySidebar('queueError', { url: item.url, title: item.title, error: 'AI 返回空内容' });
    return;
  }

  const final = summary.trim();
  await Promise.all([cacheSave(item.url, final, title), historySave(final, item.url, title, cfg.model)]);
  notifySidebar('summaryReady', { summary: final, url: item.url, title: title, fromCache: false });
}

// --- Notify sidebar ---
function notifySidebar(type, data) {
  if (sidebarPort) {
    try { sidebarPort.postMessage({ type, ...data }); } catch {}
  }
}

// --- Core: Manual summarize (triggered from sidebar retry/restore) ---
async function handleSummarize(respond, force = false) {
  try {
    const cfg = await chrome.storage.sync.get(['apiKey', 'model', 'systemPrompt']);
    if (!cfg.apiKey || !cfg.model) { respond({ success: false, error: '请先在设置中配置 API Key 和模型。' }); return; }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { respond({ success: false, error: '无法获取当前标签页。' }); return; }
    const url = tab.url, title = tab.title || '';

    if (INTERNAL_URL_PREFIXES.test(url)) { respond({ success: false, error: '无法在浏览器内部页面上使用摘要功能。' }); return; }

    if (!force) {
      const skipStatus = await checkSkipStatus(url);
      if (skipStatus.isSkipped) { respond({ success: false, error: '当前页面在跳过名单中，请先放行后再生成摘要。' }); return; }
    }

    const cached = await getCached(url);
    if (cached) { respond({ success: true, summary: cached.summary, url, title: cached.title || title, fromCache: true }); return; }

    // Extract page content as Markdown using Turndown in page context
    let data = null;
    try {
      data = await extractPageMarkdown(tab.id);
    } catch (e) {
      const m = e.message || '';
      const msg = m.includes('Cannot access') || m.includes('permissions')
        ? '没有页面访问权限，请开启「允许访问所有网站」权限后刷新。'
        : m.includes('No tab') ? '标签页已关闭，请重新打开。'
        : '无法访问页面: ' + m;
      respond({ success: false, error: msg }); return;
    }

    if (!data?.text?.trim()) { respond({ success: false, error: '无法从页面提取有效文本，请确认页面已加载。' }); return; }

    // Build system prompt with site-specific supplement
    let systemPrompt = cfg.systemPrompt?.trim() || DEFAULT_PROMPT;
    const siteConfig = await getSiteConfigForUrl(url);
    if (siteConfig.prompt) {
      systemPrompt += '\n\n' + siteConfig.prompt;
    }

    let summary;
    try {
      summary = await callAPI(data.text, data.title || title, url, cfg.model, cfg.apiKey, systemPrompt);
    } catch (e) {
      respond({ success: false, error: 'API 调用失败: ' + e.message }); return;
    }

    if (!summary?.trim()) { respond({ success: false, error: 'AI 返回空内容，请重试或切换模型。' }); return; }

    const final = summary.trim();
    await Promise.all([cacheSave(url, final, data.title || title), historySave(final, url, data.title || title, cfg.model)]);
    respond({ success: true, summary: final, url, title: data.title || title });

  } catch (e) {
    respond({ success: false, error: '生成摘要出错: ' + e.message });
  }
}

// --- Page extraction function (injected into page context) ---
// This runs in the page's isolated world where TurndownService is available
// (injected via files: ['turndown.js'] in the previous executeScript call).
// Key: we pass a DOM node to Turndown (not an HTML string), so Turndown
// uses cloneNode() internally and never needs DOMParser.
function extractPageAsMarkdown() {
  try {
    // Check if TurndownService was loaded by the previous inject step
    if (typeof TurndownService === 'undefined') {
      // Fallback: simple text extraction without Turndown
      return extractPageSimple();
    }

    const title = document.title || '';
    const clone = document.documentElement.cloneNode(true);

    // Remove invisible / non-content elements before Markdown conversion
    clone.querySelectorAll(
      'script,style,noscript,iframe,object,embed,svg,canvas,template,slot,dialog,' +
      '[hidden],[aria-hidden="true"],' +
      '[style*="display:none"],[style*="display: none"]'
    ).forEach(el => {
      try { el.remove(); } catch {}
    });

    // Create Turndown instance with appropriate config
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
      hr: '---'
    });

    // Remove noise elements that Turndown should skip
    td.remove([
      'nav', 'footer', 'header', 'aside',
      '[role="navigation"]', '[role="banner"]', '[role="complementary"]', '[role="contentinfo"]',
      '[role="search"]', '[role="toolbar"]', '[role="menubar"]',
      '.advertisement', '.ads', '.ad-container', '.ad-wrapper',
      '.social-share', '.share-buttons', '.sharing',
      '.comment', '.comments', '#comments',
      '.popup', '.modal', '.overlay',
      '.newsletter', '.subscription', '.paywall',
      '.related-posts', '.related-articles', '.recommended',
      '.sidebar', '#sidebar'
    ]);

    // Pass the DOM node (not a string!) to Turndown.
    // This is crucial: when Turndown receives a DOM node, it does
    // root = input.cloneNode(true) — no DOMParser needed!
    let markdown = td.turndown(clone);

    // Clean up excessive blank lines
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // Remove trailing whitespace on each line
    markdown = markdown.split('\n').map(line => line.trimEnd()).join('\n');

    if (markdown.length < 50) return { title, text: '' };

    // Truncate to reasonable size for AI context
    if (markdown.length > 20000) {
      markdown = markdown.substring(0, 20000);
    }

    return { title, text: markdown };
  } catch {
    // If Turndown fails, fall back to simple extraction
    return extractPageSimple();
  }
}

// Simple fallback extraction (no Turndown dependency)
function extractPageSimple() {
  try {
    const title = document.title || '';
    const clone = document.documentElement.cloneNode(true);

    clone.querySelectorAll(
      'script,style,noscript,nav,footer,header,aside,' +
      '[role="navigation"],[role="banner"],[role="complementary"],[role="contentinfo"],' +
      '.advertisement,.ads,.sidebar,.comment,.social-share,.popup,.modal'
    ).forEach(el => {
      try { el.remove(); } catch {}
    });

    let main = clone.querySelector('main') || clone.querySelector('article') ||
               clone.querySelector('[role="main"]') ||
               clone.querySelector('.content,#content,.post-content,.entry-content,.article-content,.article-body') ||
               clone.body;
    if (!main) return { title, text: '' };

    let text = (main.textContent || '').replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    if (text.length < 50) return { title, text: '' };
    if (text.length > 15000) text = text.substring(0, 15000);
    return { title, text };
  } catch {
    return { title: '', text: '' };
  }
}

// --- Fallback: Extract text from HTML string (fetch fallback when tab is closed) ---
// This runs in the Service Worker context. Chrome extension Service Workers
// DO have DOMParser available (unlike web workers), so this works.
function extractPageTextFromString(html, fallbackTitle) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent || fallbackTitle || '';

    doc.querySelectorAll('script,style,noscript,nav,footer,header,aside,[role="navigation"],[role="banner"],[role="complementary"],[role="contentinfo"],.advertisement,.ads,.sidebar,.comment,.social-share,.popup,.modal').forEach(el => el.remove());

    let main = doc.querySelector('main') || doc.querySelector('article') || doc.querySelector('[role="main"]') || doc.querySelector('.content,#content,.post-content,.entry-content,.article-content,.article-body,.news-content,.detail-content') || doc.body;
    if (!main) return { title, text: '' };

    let text = (main.textContent || '').replace(/[\t ]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    if (text.length < 50) return { title, text: '' };
    if (text.length > 15000) text = text.substring(0, 15000);
    return { title, text };
  } catch {
    return { title: fallbackTitle || '', text: '' };
  }
}

// --- LLM API call ---
async function callAPI(text, title, _url, model, apiKey, systemPrompt) {
  const userMsg = (title ? `【标题】${title}\n\n` : '') + `【正文】\n${text}`;

  let endpoint, headers, body;
  const isZhipu = model.startsWith('zhipu');

  if (model === 'gemini') {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = { contents: [{ parts: [{ text: systemPrompt + '\n\n' + userMsg }] }] };
  } else {
    endpoint = model === 'deepseek'
      ? 'https://api.deepseek.com/chat/completions'
      : 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    const modelId = model === 'deepseek' ? 'deepseek-chat' : model === 'zhipu-thinking' ? 'glm-4.7-flash' : 'glm-4-flash';
    body = {
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      max_tokens: model === 'zhipu-thinking' ? 2048 : 512,
      temperature: 0.7
    };
  }

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!res.ok) {
    let msg = `HTTP ${res.status}: ${res.statusText}`;
    try { const e = await res.json(); if (e.error?.message) msg = e.error.message; } catch {}
    if (isZhipu && res.status === 401) msg = 'API Key 认证失败，请检查智谱 Key。';
    throw new Error(msg);
  }

  const data = await res.json();

  if (model === 'gemini') {
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  const choice = data.choices?.[0];
  if (!choice) return '';
  if (choice.message?.content?.trim()) return choice.message.content.trim();
  if (choice.message?.reasoning_content && choice.finish_reason === 'length') {
    throw new Error('推理模型思考耗尽 token 限制，建议切换到 GLM-4-Flash。');
  }
  return choice.delta?.content || choice.text || '';
}

// --- URL Cache ---
async function getCached(url) {
  const { urlCache = {} } = await chrome.storage.local.get('urlCache');
  const entry = urlCache[url];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > 30 * 60 * 1000) { delete urlCache[url]; await chrome.storage.local.set({ urlCache }); return null; }
  return entry;
}

async function cacheSave(url, summary, title) {
  const { urlCache = {} } = await chrome.storage.local.get('urlCache');
  urlCache[url] = { summary, title, timestamp: Date.now() };
  const keys = Object.keys(urlCache);
  if (keys.length > 50) { keys.sort((a, b) => urlCache[a].timestamp - urlCache[b].timestamp); for (let i = 0; i < keys.length - 50; i++) delete urlCache[keys[i]]; }
  await chrome.storage.local.set({ urlCache });
}

// --- History ---
async function getHistory() { return (await chrome.storage.local.get('summaryHistory')).summaryHistory || []; }

async function historySave(summary, url, title, model) {
  const { summaryHistory = [] } = await chrome.storage.local.get('summaryHistory');
  summaryHistory.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), summary, url, title, model, timestamp: Date.now() });
  if (summaryHistory.length > 200) summaryHistory.length = 200;
  await chrome.storage.local.set({ summaryHistory });
}

async function clearHistory() { await chrome.storage.local.set({ summaryHistory: [], urlCache: {} }); }

async function deleteHistoryItem(id) {
  const { summaryHistory = [] } = await chrome.storage.local.get('summaryHistory');
  await chrome.storage.local.set({ summaryHistory: summaryHistory.filter(i => i.id !== id) });
}

async function exportHistory() {
  const history = await getHistory();
  if (!history.length) return '';
  let out = '140字摘要 - 历史记录导出\n导出时间: ' + new Date().toLocaleString('zh-CN') + '\n共 ' + history.length + ' 条记录\n' + '='.repeat(60) + '\n\n';
  for (const item of history) {
    out += `【${new Date(item.timestamp).toLocaleString('zh-CN')}】\n标题: ${item.title || '无标题'}\n链接: ${item.url}\n模型: ${item.model || '未知'}\n摘要: ${item.summary}\n${'-'.repeat(60)}\n\n`;
  }
  return out;
}

// --- Settings export/import ---
async function exportSettings() {
  const syncData = await chrome.storage.sync.get(null);
  const localData = await chrome.storage.local.get(['summaryHistory']);
  return JSON.stringify({
    _meta: { version: '1.8', exportedAt: new Date().toISOString(), app: '140word-chrome' },
    sync: syncData,
    history: localData.summaryHistory || []
  }, null, 2);
}

async function importSettings(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    if (!data._meta || data._meta.app !== '140word-chrome') {
      return { success: false, error: '无效的设置文件格式' };
    }
    if (data.sync && typeof data.sync === 'object') {
      // Migrate old sitePrompts format if present
      if (Array.isArray(data.sync.sitePrompts)) {
        data.sync.sitePrompts = data.sync.sitePrompts.map(sp => ({
          domain: sp.domain,
          prompt: sp.prompt || '',
          builtin: !!sp.builtin
        }));
      }
      await chrome.storage.sync.set(data.sync);
    }
    if (Array.isArray(data.history)) {
      await chrome.storage.local.set({ summaryHistory: data.history });
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: '解析 JSON 失败: ' + e.message };
  }
}
