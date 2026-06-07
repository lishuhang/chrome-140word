// ===== 140字摘要 v1.8 — Sidebar Logic =====
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  // Queue status elements
  const queueProcessingTitle = $('queue-processing-title');
  const queueWaitingCount = $('queue-waiting-count');

  // Skip toggle elements
  const skipToggle = $('skip-toggle');
  const skipPageBtn = $('skip-page-btn');
  const skipSiteBtn = $('skip-site-btn');

  // History elements
  const historyList = $('history-list');
  const historyCount = $('history-count');
  const includeUrlCb = $('include-url-checkbox');
  const copyAllBtn = $('copy-all-btn');
  const exportBtn = $('export-btn');
  const clearBtn = $('clear-btn');

  // Settings elements
  const form = $('settings-form');
  const modelSelect = $('model-select');
  const apiKeyInput = $('api-key-input');
  const togglePwd = $('toggle-pwd');
  const saveBtn = form.querySelector('[type="submit"]');
  const testBtn = $('test-btn');
  const statusMsg = $('status-msg');
  const promptInput = $('prompt-input');
  const savePromptBtn = $('save-prompt-btn');
  const resetPromptBtn = $('reset-prompt-btn');
  const skipListInput = $('skip-list-input');
  const saveSkipListBtn = $('save-skip-list-btn');
  const exportSettingsBtn = $('export-settings-btn');
  const importSettingsBtn = $('import-settings-btn');
  const importSettingsFile = $('import-settings-file');
  const importStatusMsg = $('import-status-msg');

  // Site prompt elements
  const sitePromptsList = $('site-prompts-list');
  const sitePromptDomainInput = $('site-prompt-domain-input');
  const sitePromptTextInput = $('site-prompt-text-input');
  const saveSitePromptBtn = $('save-site-prompt-btn');
  const deleteSitePromptBtn = $('delete-site-prompt-btn');
  const cancelSitePromptBtn = $('cancel-site-prompt-btn');

  const DEFAULT_PROMPT = `简化下列文章表述为200字以内的类似techmeme的一句话总结，不分段，无样式，一整段话；在一条微博的长度内尽可能容纳所有有效信息，以倒金字塔形式，将最重要的信息最先说出；必须保留原文中的关键数字（金额、比例、数量、日期等），数字是最重要的信息之一；不论提供给你任何语言，输出语言均为中文。输入内容为网页完整Markdown，你应聚焦于正文主体，忽略导航菜单、页头页脚、广告、社交分享、侧边栏、站内推广等非正文内容；除非品牌名是报道事件中的当事人，否则摘要中不得出现网站品牌名或宣传用语。`;
  const modelLabel = { 'zhipu': 'GLM-4-Flash', 'zhipu-thinking': 'GLM-4.7-Flash', 'gemini': 'Gemini', 'deepseek': 'DeepSeek', 'cached': '缓存' };

  // Internal browser pages that can never be summarized
  const INTERNAL_URL_PREFIXES = /^(chrome|chrome-extension|edge|about|devtools|chrome-search|blob|data|javascript|view-source):/i;
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

  // State
  let currentTabUrl = '';
  let currentTabTitle = '';
  let isCurrentSkipped = false;
  let isLocalFile = false;           // Whether current tab is a local file:// page
  let matchedSkipPattern = null;     // the pattern that caused the skip
  let pagePattern = null;            // extractPagePattern(currentTabUrl)
  let sitePattern = null;            // extractSitePattern(currentTabUrl)
  let generating = false;
  let pwdVisible = false;
  let editingSitePromptDomain = null; // track which domain is being edited

  // Progress state: Map<url, { url, title, status }>
  let progressEntries = new Map();

  // Queue state (mirrors background)
  let queueState = { processing: null, waitingCount: 0, queueItems: [] };

  // --- Port connection to background ---
  let port = null;
  function connectPort() {
    port = chrome.runtime.connect({ name: 'sidebar' });
    port.onDisconnect.addListener(() => { port = null; });
    port.onMessage.addListener(handleBackgroundMessage);
    port.postMessage({ action: 'sidebarReady' });
  }

  function handleBackgroundMessage(msg) {
    switch (msg.type) {
      case 'tabEvaluating':
        progressEntries.set(msg.url, { url: msg.url, title: msg.title, status: 'evaluating' });
        loadHistory();
        break;

      case 'joinedQueue':
        progressEntries.set(msg.url, { url: msg.url, title: msg.title, status: 'joinedQueue' });
        loadHistory();
        break;

      case 'processingStarted':
        progressEntries.set(msg.url, { url: msg.url, title: msg.title, status: 'processing' });
        loadHistory();
        break;

      case 'queueStatus':
        queueState.processing = msg.processing;
        queueState.waitingCount = msg.waitingCount;
        queueState.queueItems = msg.queueItems || [];
        renderQueueStatus();
        if (reconcileProgressFromQueueStatus()) {
          loadHistory();
        }
        break;

      case 'summaryReady':
        progressEntries.delete(msg.url);
        loadHistory();
        break;

      case 'queueError':
        progressEntries.set(msg.url, { url: msg.url, title: msg.title, status: 'error', error: msg.error || '摘要生成失败' });
        loadHistory();
        break;

      case 'configMissing':
        if (msg.url) {
          progressEntries.set(msg.url, { url: msg.url, title: msg.title || '', status: 'error', error: '请先在设置中配置 API Key 和模型。' });
        }
        loadHistory();
        break;

      case 'pageSkipped':
        const existingEntry = progressEntries.get(msg.url);
        if (existingEntry && existingEntry.status === 'evaluating') {
          progressEntries.delete(msg.url);
        }
        currentTabUrl = msg.url;
        currentTabTitle = msg.title || '';
        isCurrentSkipped = !msg.isSystemPage;
        isLocalFile = msg.isLocalFile || false;
        matchedSkipPattern = msg.matchedPattern;
        pagePattern = msg.pagePattern;
        sitePattern = msg.sitePattern;
        updateSkipToggle();
        loadHistory();
        break;
    }
  }

  // --- Reconcile progress entries with actual queue state ---
  function reconcileProgressFromQueueStatus() {
    const { processing, queueItems } = queueState;
    let changed = false;

    if (processing && !progressEntries.has(processing.url)) {
      progressEntries.set(processing.url, { url: processing.url, title: processing.title, status: 'processing' });
      changed = true;
    }

    for (const item of (queueItems || [])) {
      if (!progressEntries.has(item.url)) {
        progressEntries.set(item.url, { url: item.url, title: item.title, status: 'joinedQueue' });
        changed = true;
      }
    }

    const activeUrls = new Set([
      ...(processing ? [processing.url] : []),
      ...(queueItems || []).map(q => q.url)
    ]);

    for (const [url, entry] of progressEntries) {
      if (!activeUrls.has(url) && entry.status !== 'error') {
        progressEntries.delete(url);
        changed = true;
      }
    }

    return changed;
  }

  // --- Queue status rendering (always visible) ---
  function renderQueueStatus() {
    const { processing, waitingCount } = queueState;
    if (processing) {
      queueProcessingTitle.textContent = processing.title || processing.url;
      queueProcessingTitle.classList.add('processing-active');
    } else {
      queueProcessingTitle.textContent = '无';
      queueProcessingTitle.classList.remove('processing-active');
    }
    queueWaitingCount.textContent = waitingCount + ' 条';
  }

  // --- Skip/Allow toggle (always visible, uses disabled state) ---
  function updateSkipToggle() {
    if (!currentTabUrl || INTERNAL_URL_PREFIXES.test(currentTabUrl)) {
      skipPageBtn.innerHTML = '跳过本页';
      skipSiteBtn.innerHTML = '跳过本站';
      skipPageBtn.disabled = true;
      skipSiteBtn.disabled = true;
      skipPageBtn.classList.remove('restore');
      skipSiteBtn.classList.remove('restore');
      return;
    }

    if (isLocalFile) {
      skipPageBtn.innerHTML = '<svg class="ico" style="width:12px;height:12px"><use href="#i-allow"/></svg> 恢复本页';
      skipSiteBtn.innerHTML = '跳过本站';
      skipPageBtn.disabled = false;
      skipSiteBtn.disabled = true;
      skipPageBtn.classList.add('restore');
      skipSiteBtn.classList.remove('restore');
      return;
    }

    skipPageBtn.disabled = false;
    skipSiteBtn.disabled = false;

    if (isCurrentSkipped) {
      skipPageBtn.innerHTML = '<svg class="ico" style="width:12px;height:12px"><use href="#i-allow"/></svg> 恢复本页';
      skipSiteBtn.innerHTML = '<svg class="ico" style="width:12px;height:12px"><use href="#i-allow"/></svg> 恢复本站';
      skipPageBtn.classList.add('restore');
      skipSiteBtn.classList.add('restore');
    } else {
      skipPageBtn.innerHTML = '<svg class="ico" style="width:12px;height:12px"><use href="#i-skip"/></svg> 跳过本页';
      skipSiteBtn.innerHTML = '<svg class="ico" style="width:12px;height:12px"><use href="#i-skip"/></svg> 跳过本站';
      skipPageBtn.classList.remove('restore');
      skipSiteBtn.classList.remove('restore');
    }
  }

  async function refreshSkipStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) {
        isCurrentSkipped = false;
        isLocalFile = false;
        updateSkipToggle();
        return;
      }
      currentTabUrl = tab.url;
      currentTabTitle = tab.title || '';
      pagePattern = extractPagePattern(tab.url);
      sitePattern = extractSitePattern(tab.url);

      if (isLocalFileUrl(tab.url)) {
        isLocalFile = true;
        isCurrentSkipped = false;
        matchedSkipPattern = null;
        updateSkipToggle();
        return;
      }

      isLocalFile = false;
      const res = await sendMsg({ action: 'checkSkipStatus', url: tab.url });
      if (res?.success) {
        isCurrentSkipped = res.isSkipped && !res.isSystemPage;
        isLocalFile = res.isLocalFile || false;
        matchedSkipPattern = res.matchedPattern;
        pagePattern = res.pagePattern;
        sitePattern = res.sitePattern;
        updateSkipToggle();
      }
    } catch {}
  }

  function extractSitePattern(url) {
    try {
      const u = new URL(url);
      const domain = extractRegistrableDomain(u.hostname);
      return `*.${domain}/*`;
    } catch { return url; }
  }
  function extractPagePattern(url) {
    try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; }
  }

  // --- Update current tab info ---
  async function updateCurrentTabInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const urlChanged = tab.url !== currentTabUrl;
        currentTabUrl = tab.url || '';
        currentTabTitle = tab.title || '';
        if (urlChanged) {
          isCurrentSkipped = false;
          isLocalFile = false;
          matchedSkipPattern = null;
          await refreshSkipStatus();
          renderQueueStatus();
          loadHistory();
        }
      }
    } catch {}
  }

  // --- Init ---
  (async () => {
    const s = await chrome.storage.sync.get(['includeUrl']);
    if (s.includeUrl !== undefined) includeUrlCb.checked = s.includeUrl;

    await updateCurrentTabInfo();

    tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    includeUrlCb.addEventListener('change', () => chrome.storage.sync.set({ includeUrl: includeUrlCb.checked }));

    // Skip/Allow toggle — 跳过本页
    skipPageBtn.addEventListener('click', async () => {
      if (!currentTabUrl || skipPageBtn.disabled) return;

      if (isLocalFile) {
        doManualSummarize(true);
        return;
      }

      if (isCurrentSkipped) {
        const patternToRemove = matchedSkipPattern || pagePattern;
        await sendMsg({ action: 'removeFromSkipList', pattern: patternToRemove });
        isCurrentSkipped = false;
        matchedSkipPattern = null;
        updateSkipToggle();
        doManualSummarize(false);
      } else {
        await sendMsg({ action: 'addToSkipList', pattern: pagePattern });
        isCurrentSkipped = true;
        matchedSkipPattern = pagePattern;
        updateSkipToggle();
        progressEntries.delete(currentTabUrl);
        loadHistory();
      }
    });

    // Skip/Allow toggle — 跳过本站
    skipSiteBtn.addEventListener('click', async () => {
      if (!currentTabUrl || skipSiteBtn.disabled) return;

      if (isCurrentSkipped) {
        // Restore: remove the site pattern (or matched pattern if it's site-level)
        const patternToRemove = sitePattern;
        await sendMsg({ action: 'removeFromSkipList', pattern: patternToRemove });
        // Re-check if page is still skipped by other patterns
        const recheck = await sendMsg({ action: 'checkSkipStatus', url: currentTabUrl });
        isCurrentSkipped = recheck?.success ? recheck.isSkipped && !recheck.isSystemPage : false;
        matchedSkipPattern = isCurrentSkipped ? recheck.matchedPattern : null;
        updateSkipToggle();
        if (!isCurrentSkipped) doManualSummarize(false);
      } else {
        await sendMsg({ action: 'addToSkipList', pattern: sitePattern });
        isCurrentSkipped = true;
        matchedSkipPattern = sitePattern;
        updateSkipToggle();
        progressEntries.delete(currentTabUrl);
        loadHistory();
      }
    });

    // History actions
    copyAllBtn.addEventListener('click', doCopyAll);
    exportBtn.addEventListener('click', doExport);
    clearBtn.addEventListener('click', doClear);

    // Settings
    form.addEventListener('submit', handleSave);
    testBtn.addEventListener('click', handleTest);
    togglePwd.addEventListener('click', togglePassword);
    modelSelect.addEventListener('change', updateBtnState);
    apiKeyInput.addEventListener('input', updateBtnState);
    savePromptBtn.addEventListener('click', savePrompt);
    resetPromptBtn.addEventListener('click', resetPrompt);
    saveSkipListBtn.addEventListener('click', saveSkipListFromInput);
    exportSettingsBtn.addEventListener('click', doExportSettings);
    importSettingsBtn.addEventListener('click', () => importSettingsFile.click());
    importSettingsFile.addEventListener('change', doImportSettings);

    // Site prompts
    saveSitePromptBtn.addEventListener('click', handleSaveSitePrompt);
    deleteSitePromptBtn.addEventListener('click', handleDeleteSitePrompt);
    cancelSitePromptBtn.addEventListener('click', handleCancelSitePrompt);

    await loadSettings();
    updateBtnState();
    loadHistory();
    await loadSkipListToInput();
    await loadSitePromptsList();

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        if (changes.skipList) {
          loadSkipListToInput();
          refreshSkipStatus();
        }
        if (changes.sitePrompts) {
          loadSitePromptsList();
        }
      }
    });

    // Listen for tab changes to update current tab tracking
    chrome.tabs.onActivated.addListener(async () => {
      await updateCurrentTabInfo();
    });
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.active) {
        await updateCurrentTabInfo();
      }
    });

    // Connect to background and trigger auto-summarize
    connectPort();
  })();

  function switchTab(name) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p => {
      const match = p.id === `panel-${name}`;
      p.classList.toggle('active', match);
      p.classList.toggle('hidden', !match);
    });
    if (name === 'summary') loadHistory();
  }

  // --- Manual summarize (for retry / restore / local file one-time) ---
  function doManualSummarize(force = false) {
    if (generating) return;
    generating = true;
    progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'processing' });
    loadHistory();

    chrome.storage.sync.get(['apiKey', 'model'], cfg => {
      if (!cfg.apiKey || !cfg.model) {
        progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'error', error: '请先在设置中配置 API Key 和模型。' });
        generating = false;
        loadHistory();
        return;
      }
      const timer = setTimeout(() => {
        progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'error', error: '请求超时，请重试。' });
        generating = false;
        loadHistory();
      }, 60000);

      chrome.runtime.sendMessage({ action: force ? 'forceSummarize' : 'summarize' }, res => {
        clearTimeout(timer);
        generating = false;
        if (chrome.runtime.lastError) {
          progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'error', error: '通信失败: ' + chrome.runtime.lastError.message });
          loadHistory(); return;
        }
        if (!res) {
          progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'error', error: '后台无响应，请重试。' });
          loadHistory(); return;
        }
        if (res.success && res.summary?.trim()) {
          progressEntries.delete(currentTabUrl);
          loadHistory();
        } else {
          progressEntries.set(currentTabUrl, { url: currentTabUrl, title: currentTabTitle, status: 'error', error: res?.error || '未知错误' });
          loadHistory();
        }
      });
    });
  }

  // --- History ---
  async function loadHistory() {
    try {
      const res = await sendMsg({ action: 'getHistory' });
      if (res?.success && res.history) renderHistory(res.history);
      else historyList.innerHTML = '<div class="empty-state">加载失败</div>';
    } catch { historyList.innerHTML = '<div class="empty-state">加载失败</div>'; }
  }

  function renderHistory(list) {
    historyCount.textContent = list.length + ' 条';
    let html = '';

    // Render all progress entries (persisted across tab switches)
    if (progressEntries.size > 0) {
      const sorted = [...progressEntries.values()].sort((a, b) => {
        const order = { processing: 0, evaluating: 1, joinedQueue: 2, error: 3 };
        return (order[a.status] ?? 9) - (order[b.status] ?? 9);
      });

      for (const p of sorted) {
        const isCurrentTab = (p.url === currentTabUrl);
        let progressContent = '';
        if (p.status === 'evaluating') {
          progressContent = '<span class="inline-spinner"></span> 正在加入队列……';
        } else if (p.status === 'joinedQueue') {
          progressContent = '已加入队列，等待生成';
        } else if (p.status === 'processing') {
          progressContent = '<span class="inline-spinner"></span> 正在生成……';
        } else if (p.status === 'error') {
          progressContent = `<span class="progress-error-text">${esc(p.error)}</span>`;
          if (isCurrentTab) {
            progressContent += ` <button class="retry-inline-btn">重试</button>`;
          }
        }
        html += `<div class="history-item progress-item${p.status === 'error' ? ' progress-error' : ''}" data-url="${esc(p.url || '')}">
          <div class="history-item-header">
            <div class="history-item-title-wrap">
              <span class="history-item-title">${esc(p.title || '当前页面')}</span>
            </div>
          </div>
          <div class="history-item-summary-wrap no-hover">
            <span class="history-item-summary progress-text">${progressContent}</span>
          </div>
        </div>`;
      }
    }

    if (!list.length && progressEntries.size === 0) {
      historyList.innerHTML = '<div class="empty-state">暂无历史记录<br>生成摘要后会自动保存</div>';
      return;
    }

    // Render real history items
    html += list.map(item => {
      const t = new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<div class="history-item" data-id="${item.id}" data-url="${esc(item.url || '')}">
        <div class="history-item-header">
          <div class="history-item-title-wrap" data-action="open-url" data-url="${esc(item.url || '')}">
            <span class="history-item-title">${esc(item.title || '无标题')}</span>
            <span class="history-item-overlay">点击阅读原文</span>
          </div>
          <button class="history-item-delete" data-id="${item.id}" title="删除">&times;</button>
        </div>
        <div class="history-item-summary-wrap" data-action="copy-summary" data-summary="${esc(item.summary)}" data-url="${esc(item.url || '')}">
          <span class="history-item-summary">${esc(item.summary)}</span>
          <span class="history-item-overlay copy-overlay">一键复制本条摘要</span>
        </div>
        <div class="history-item-meta"><span>${t}</span><span class="history-item-model">${modelLabel[item.model] || item.model}</span></div>
      </div>`;
    }).join('');

    historyList.innerHTML = html;

    // Bind events for progress item retry button
    const retryBtn = historyList.querySelector('.retry-inline-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', e => {
        e.stopPropagation();
        const force = isLocalFile;
        doManualSummarize(force);
      });
    }

    // Bind events for history items
    historyList.querySelectorAll('.history-item-title-wrap[data-action="open-url"]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const url = el.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });

    historyList.querySelectorAll('.history-item-summary-wrap[data-action="copy-summary"]').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        let text = el.dataset.summary;
        if (includeUrlCb.checked && el.dataset.url) text += '\n\n原文链接: ' + el.dataset.url;
        text += '\n\n';
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制摘要');
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('已复制摘要'); }
          catch { toast('复制失败'); }
          document.body.removeChild(ta);
        }
      });
    });

    historyList.querySelectorAll('.history-item-delete').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await sendMsg({ action: 'deleteHistoryItem', id: btn.dataset.id });
        loadHistory();
        toast('已删除');
      });
    });
  }

  // --- Copy all ---
  async function doCopyAll() {
    const res = await sendMsg({ action: 'getHistory' });
    if (!res?.success || !res.history?.length) { toast('没有可复制的内容'); return; }
    const includeUrl = includeUrlCb.checked;
    const parts = res.history.map(item => {
      let text = `【${item.title || '无标题'}】\n${item.summary}`;
      if (includeUrl && item.url) text += '\n原文链接: ' + item.url;
      return text;
    });
    const allText = parts.join('\n\n') + '\n\n';
    try {
      await navigator.clipboard.writeText(allText);
      toast('已复制全部摘要');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = allText; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('已复制全部摘要'); }
      catch { toast('复制失败'); }
      document.body.removeChild(ta);
    }
  }

  async function doExport() {
    const res = await sendMsg({ action: 'exportHistory' });
    if (res?.success && res.data) {
      const blob = new Blob([res.data], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const now = new Date();
      const ts = now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
      a.download = `140word-export-${ts}.txt`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('导出成功');
    } else toast(res?.success ? '没有可导出的记录' : '导出失败');
  }

  function doClear() {
    showConfirm('确定要清空所有历史记录吗？此操作不可撤销。', async () => {
      await sendMsg({ action: 'clearHistory' });
      loadHistory();
      toast('历史记录已清空');
    });
  }

  // --- Settings ---
  async function loadSettings() {
    const s = await chrome.storage.sync.get(['model', 'apiKey', 'systemPrompt']);
    if (s.model) modelSelect.value = s.model;
    if (s.apiKey) apiKeyInput.value = s.apiKey;
    promptInput.value = s.systemPrompt || '';
    promptInput.placeholder = DEFAULT_PROMPT;
    updateBtnState();
  }

  async function handleSave(e) {
    e.preventDefault();
    const model = modelSelect.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!model) { showStatus('请选择 AI 模型', 'error'); modelSelect.focus(); return; }
    if (!apiKey) { showStatus('请输入 API Key', 'error'); apiKeyInput.focus(); return; }
    saveBtn.disabled = true;
    try {
      await chrome.storage.sync.set({ model, apiKey });
      showStatus('设置保存成功！', 'success');
    } catch (err) {
      showStatus('保存失败: ' + err.message, 'error');
    }
    saveBtn.disabled = false;
  }

  async function savePrompt() {
    const prompt = promptInput.value.trim();
    await chrome.storage.sync.set({ systemPrompt: prompt || '' });
    showStatus('Prompt 保存成功！' + (prompt ? '' : '（已清空，将使用默认值）'), 'success');
  }

  async function resetPrompt() {
    promptInput.value = DEFAULT_PROMPT;
    await chrome.storage.sync.set({ systemPrompt: '' });
    showStatus('已恢复为默认 Prompt', 'success');
  }

  async function handleTest() {
    const model = modelSelect.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!model || !apiKey) { showStatus('请先选择模型并输入 API Key', 'error'); return; }
    testBtn.disabled = true;
    showStatus('正在测试连接...', 'info');
    try {
      const res = await testApi(model, apiKey);
      showStatus(res.success ? '连接测试成功！API 配置正确。' : '测试失败: ' + res.error, res.success ? 'success' : 'error');
    } catch (err) {
      showStatus('测试失败: ' + err.message, 'error');
    }
    testBtn.disabled = false;
  }

  async function testApi(model, apiKey) {
    const msg = '测试连接，请回复OK';
    let endpoint, body, headers;
    if (model === 'gemini') {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
      headers = { 'Content-Type': 'application/json' };
      body = { contents: [{ parts: [{ text: msg }] }] };
    } else {
      const modelMap = { zhipu: 'glm-4-flash', 'zhipu-thinking': 'glm-4.7-flash', deepseek: 'deepseek-chat' };
      endpoint = model === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
      body = { model: modelMap[model], messages: [{ role: 'user', content: msg }], max_tokens: model === 'zhipu-thinking' ? 128 : 10 };
    }
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        let msg = `HTTP ${res.status}: ${err.error?.message || res.statusText}`;
        if (model.startsWith('zhipu') && res.status === 401) msg = 'API Key 认证失败，请检查智谱 Key。';
        return { success: false, error: msg };
      }
      const data = await res.json();
      const ok = model === 'gemini' ? data.candidates?.length : data.choices?.length;
      return ok ? { success: true } : { success: false, error: 'API 响应格式异常' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function togglePassword() {
    pwdVisible = !pwdVisible;
    apiKeyInput.type = pwdVisible ? 'text' : 'password';
    togglePwd.querySelector('use').setAttribute('href', pwdVisible ? '#i-eye-off' : '#i-eye');
  }

  function updateBtnState() {
    testBtn.disabled = !modelSelect.value.trim() || !apiKeyInput.value.trim();
  }

  function showStatus(msg, type = 'info') {
    statusMsg.textContent = msg;
    statusMsg.className = `status-msg ${type}`;
    statusMsg.classList.remove('hidden');
    if (type === 'success') setTimeout(() => statusMsg.classList.add('hidden'), 3000);
  }

  // --- Skip list management ---
  async function loadSkipListToInput() {
    const res = await sendMsg({ action: 'getSkipList' });
    if (res?.success) {
      skipListInput.value = (res.skipList || []).join('\n');
    }
  }

  async function saveSkipListFromInput() {
    const lines = skipListInput.value.split('\n').map(l => l.trim()).filter(l => l);
    await sendMsg({ action: 'saveSkipList', skipList: lines });
    showStatus('跳过名单已保存！', 'success');
    refreshSkipStatus();
  }

  // --- Site prompts management ---
  async function loadSitePromptsList() {
    const res = await sendMsg({ action: 'getSitePrompts' });
    if (!res?.success) {
      sitePromptsList.innerHTML = '<div class="site-prompt-empty">加载失败</div>';
      return;
    }
    const prompts = res.sitePrompts || [];
    if (!prompts.length) {
      sitePromptsList.innerHTML = '<div class="site-prompt-empty">暂无网站专属提示词</div>';
      return;
    }
    sitePromptsList.innerHTML = prompts.map(sp => {
      const preview = sp.prompt.length > 80 ? sp.prompt.substring(0, 80) + '…' : sp.prompt;
      const builtinBadge = sp.builtin ? '<span class="site-prompt-badge">内置</span>' : '';
      return `<div class="site-prompt-item" data-domain="${esc(sp.domain)}">
        <div class="site-prompt-item-header">
          <span class="site-prompt-item-domain">${esc(sp.domain)}${builtinBadge}</span>
          <div class="site-prompt-item-actions">
            <button class="small-btn site-prompt-edit-btn" data-domain="${esc(sp.domain)}">编辑</button>
            <button class="small-btn danger site-prompt-delete-btn" data-domain="${esc(sp.domain)}">删除</button>
          </div>
        </div>
        <div class="site-prompt-item-preview">${esc(preview)}</div>
      </div>`;
    }).join('');

    // Bind edit/delete buttons
    sitePromptsList.querySelectorAll('.site-prompt-edit-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const domain = btn.dataset.domain;
        const prompts2 = (await sendMsg({ action: 'getSitePrompts' }))?.sitePrompts || [];
        const sp = prompts2.find(p => p.domain === domain);
        if (sp) {
          editingSitePromptDomain = domain;
          sitePromptDomainInput.value = sp.domain;
          sitePromptTextInput.value = sp.prompt;
          deleteSitePromptBtn.style.display = '';
          cancelSitePromptBtn.style.display = '';
          saveSitePromptBtn.textContent = '更新';
          sitePromptDomainInput.focus();
        }
      });
    });
    sitePromptsList.querySelectorAll('.site-prompt-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const domain = btn.dataset.domain;
        await sendMsg({ action: 'deleteSitePrompt', domain });
        await loadSitePromptsList();
        if (editingSitePromptDomain === domain) {
          clearSitePromptForm();
        }
        showStatus('已删除网站提示词', 'success');
      });
    });
  }

  async function handleSaveSitePrompt() {
    const domain = sitePromptDomainInput.value.trim();
    const prompt = sitePromptTextInput.value.trim();
    if (!domain) { showStatus('请输入域名', 'error'); sitePromptDomainInput.focus(); return; }
    if (!prompt) { showStatus('请输入补充提示词', 'error'); sitePromptTextInput.focus(); return; }
    // Validate domain format
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(domain)) {
      showStatus('域名格式无效，如 businessinsider.com', 'error'); return;
    }
    // Check if it was a built-in prompt being edited
    const existingRes = await sendMsg({ action: 'getSitePrompts' });
    const existing = (existingRes?.sitePrompts || []).find(sp => sp.domain === domain);
    const isBuiltin = existing?.builtin || false;

    await sendMsg({ action: 'saveSitePrompt', domain, prompt, builtin: isBuiltin });
    await loadSitePromptsList();
    clearSitePromptForm();
    showStatus('网站提示词已保存！', 'success');
  }

  async function handleDeleteSitePrompt() {
    const domain = editingSitePromptDomain || sitePromptDomainInput.value.trim();
    if (!domain) return;
    await sendMsg({ action: 'deleteSitePrompt', domain });
    await loadSitePromptsList();
    clearSitePromptForm();
    showStatus('已删除网站提示词', 'success');
  }

  function handleCancelSitePrompt() {
    clearSitePromptForm();
  }

  function clearSitePromptForm() {
    editingSitePromptDomain = null;
    sitePromptDomainInput.value = '';
    sitePromptTextInput.value = '';
    deleteSitePromptBtn.style.display = 'none';
    cancelSitePromptBtn.style.display = 'none';
    saveSitePromptBtn.textContent = '添加';
  }

  // --- Settings export/import ---
  async function doExportSettings() {
    const res = await sendMsg({ action: 'exportSettings' });
    if (res?.success && res.data) {
      const blob = new Blob([res.data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const now = new Date();
      const ts = now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '-' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
      a.download = `140word-chrome-settings-${ts}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast('设置导出成功');
    } else {
      toast('导出失败');
    }
  }

  async function doImportSettings(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await sendMsg({ action: 'importSettings', data: text });
      if (res?.success) {
        showImportStatus('设置导入成功！', 'success');
        await loadSettings();
        await loadSkipListToInput();
        await loadSitePromptsList();
        loadHistory();
        refreshSkipStatus();
      } else {
        showImportStatus('导入失败: ' + (res?.error || '未知错误'), 'error');
      }
    } catch (err) {
      showImportStatus('读取文件失败: ' + err.message, 'error');
    }
    importSettingsFile.value = '';
  }

  function showImportStatus(msg, type = 'info') {
    importStatusMsg.textContent = msg;
    importStatusMsg.className = `status-msg ${type}`;
    importStatusMsg.classList.remove('hidden');
    if (type === 'success') setTimeout(() => importStatusMsg.classList.add('hidden'), 3000);
  }

  // --- UI helpers ---
  function toast(msg) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
  }

  function showConfirm(msg, onOk) {
    const ov = document.createElement('div');
    ov.className = 'confirm-overlay';
    ov.innerHTML = `<div class="confirm-dialog"><p>${esc(msg)}</p><div class="confirm-dialog-btns"><button class="btn-cancel">取消</button><button class="btn-confirm-danger">确定清空</button></div></div>`;
    ov.querySelector('.btn-cancel').onclick = () => ov.remove();
    ov.querySelector('.btn-confirm-danger').onclick = () => { ov.remove(); onOk(); };
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  function sendMsg(data) { return new Promise(r => chrome.runtime.sendMessage(data, r)); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
});
