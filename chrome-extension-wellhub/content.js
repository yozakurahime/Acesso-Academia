(() => {
  const DEFAULTS = {
    enabled: true,
    autoConfirm: true,
    refreshSeconds: 10,
  };

  let cfg = { ...DEFAULTS };
  let sentNamesToday = new Set();
  let lastRefreshAt = Date.now();
  let lastConfirmClickAt = 0;
  let badgeEl = null;
  let lastBadgeText = '';
  let scanTimer = null;

  function ensureBadge() {
    if (badgeEl && document.body?.contains(badgeEl)) return badgeEl;
    if (!document.body) return null;
    badgeEl = document.createElement('div');
    badgeEl.id = 'oxigenio-wellhub-badge';
    badgeEl.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:999999',
      'background:#111827',
      'color:#f9fafb',
      'padding:10px 14px',
      'border-radius:10px',
      'font:600 12px/1.4 system-ui,-apple-system,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.25)',
      'border:1px solid rgba(255,255,255,.15)',
      'max-width:290px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(badgeEl);
    return badgeEl;
  }

  function updateBadge(text, isError = false) {
    const el = ensureBadge();
    if (!el) return;
    const border = isError ? '#ef4444' : '#10b981';
    if (el.style.borderColor !== border) el.style.borderColor = border;
    if (lastBadgeText !== text) {
      lastBadgeText = text;
      el.textContent = text;
    }
  }

  function findSectionCardByTitle(titleSubstring) {
    const target = titleSubstring.toLowerCase();
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,p,span,strong')];
    for (const el of headings) {
      if (el.closest('#oxigenio-wellhub-badge') || el.children.length > 0) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt.includes(target)) continue;
      let card = el.parentElement;
      for (let i = 0; i < 6 && card; i += 1) {
        const rect = card.getBoundingClientRect();
        if (rect.width > 240 && rect.height > 120) return card;
        card = card.parentElement;
      }
    }
    return null;
  }

  function clickRefreshButtons() {
    const now = Date.now();
    const intervalMs = Math.max(5, Number(cfg.refreshSeconds) || 10) * 1000;
    if (now - lastRefreshAt < intervalMs) return;
    lastRefreshAt = now;

    ['Check-ins para confirmar', 'Check-ins confirmados'].forEach((title) => {
      const card = findSectionCardByTitle(title);
      if (!card) return;
      const buttons = [...card.querySelectorAll('button, [role="button"]')];
      const refreshBtn = buttons.find((btn) => {
        const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`.toLowerCase();
        if (label.includes('atualiz') || label.includes('refresh') || label.includes('reload')) return true;
        return false;
      });
      if (refreshBtn && !refreshBtn.disabled) {
        refreshBtn.click();
      }
    });
  }

  function tryAutoConfirmPending() {
    if (!cfg.autoConfirm) return;
    const now = Date.now();
    if (now - lastConfirmClickAt < 2000) return;

    const pendingCard = findSectionCardByTitle('Check-ins para confirmar');
    if (!pendingCard) return;

    const confirmBtns = [...pendingCard.querySelectorAll('button')].filter((btn) => {
      if (btn.disabled) return false;
      const txt = (btn.textContent || '').trim().toLowerCase();
      return /^(confirmar|aceitar|validar|confirm|accept)$/.test(txt);
    });

    if (confirmBtns.length > 0) {
      lastConfirmClickAt = now;
      confirmBtns[0].click();
      updateBadge('Oxigênio Bot: Confirmando check-in no Wellhub...');
    }
  }

  function extractConfirmedCheckins() {
    const confirmedCard = findSectionCardByTitle('Check-ins confirmados');
    if (!confirmedCard) return [];

    const ignoredLine = /^(check-ins confirmados|ver check-ins de hoje|nenhum check-in|\d+|\d+\s+de\s+[a-z]+\.?,\s*\d{1,2}:\d{2})$/i;
    const items = [];
    const seen = new Set();

    const rows = [...confirmedCard.querySelectorAll('li, [role="listitem"], div')].filter((el) => {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 180) return false;
      return /\d{1,2}:\d{2}/.test(text) && el.querySelectorAll('div, p, span').length <= 8;
    });

    for (const row of rows) {
      const lines = (row.innerText || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !ignoredLine.test(l));
      if (!lines.length) continue;

      const candidateName = lines[0];
      if (!candidateName || candidateName.length < 4 || /\d/.test(candidateName)) continue;
      if (candidateName.includes('Check-ins')) continue;

      const key = candidateName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const timeLine = (row.innerText || '').match(/\d{1,2}\s+de\s+[^\n]+|\d{1,2}:\d{2}/i)?.[0] || '';
      items.push({
        name: candidateName,
        modality: lines[1] || '',
        time_text: timeLine,
      });
    }

    return items;
  }

  function scheduleScan(delayMs = 1000) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndSync();
    }, delayMs);
  }

  function scanAndSync() {
    if (!document.body) return;
    if (!cfg.enabled) {
      updateBadge('Oxigênio Bot: Pausado');
      return;
    }

    clickRefreshButtons();
    tryAutoConfirmPending();

    const confirmed = extractConfirmedCheckins();
    const pendingToSend = confirmed.filter((item) => !sentNamesToday.has(item.name.toLowerCase()));
    if (!pendingToSend.length) {
      updateBadge(`Oxigênio Bot: Vigiando (${confirmed.length} confirmado(s) na tela)`);
      return;
    }

    chrome.runtime.sendMessage({ type: 'WELLHUB_SYNC_CHECKINS', items: pendingToSend }, (res) => {
      if (chrome.runtime.lastError) {
        updateBadge(`Oxigênio Bot: ${chrome.runtime.lastError.message}`, true);
        return;
      }
      if (!res || res.error) {
        updateBadge(`Oxigênio Bot: ${res?.error || 'Falha ao sincronizar'}`, true);
        return;
      }
      pendingToSend.forEach((item) => sentNamesToday.add(item.name.toLowerCase()));
      updateBadge(`Oxigênio Bot: ${res.matched?.length || 0} liberado(s) · ${res.unmatched?.length || 0} não encontrado(s)`);
    });
  }

  async function init() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    cfg = { ...DEFAULTS, ...stored };

    chrome.storage.onChanged.addListener((changes) => {
      for (const [k, v] of Object.entries(changes)) {
        if (k in cfg) cfg[k] = v.newValue;
      }
      if (changes.enabled?.newValue === true) sentNamesToday.clear();
    });

    if (document.body) {
      const observer = new MutationObserver((mutations) => {
        const onlyBadge = mutations.every((m) => m.target?.id === 'oxigenio-wellhub-badge' || m.target?.closest?.('#oxigenio-wellhub-badge'));
        if (!onlyBadge) scheduleScan(1200);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(scanAndSync, 4000);
    setTimeout(scanAndSync, 3000);
  }

  init();
})();
