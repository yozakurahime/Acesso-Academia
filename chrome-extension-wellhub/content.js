(() => {
  const DEFAULTS = {
    enabled: true,
    autoConfirm: true,
    refreshSeconds: 8,
  };

  const isTotalpass = location.hostname.includes('totalpass.com');
  const provider = isTotalpass ? 'totalpass' : 'wellhub';
  const providerLabel = isTotalpass ? 'TotalPass' : 'Wellhub';

  let cfg = { ...DEFAULTS };
  let sentNamesToday = new Set();
  let lastRefreshAt = 0;
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
      'max-width:310px',
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

  function findSectionCardByTitle(titles, excludeTitles) {
    const targets = titles.map((t) => t.toLowerCase());
    const excludes = excludeTitles.map((t) => t.toLowerCase());
    const candidates = [...document.querySelectorAll('h1,h2,h3,h4,h5,p,span,strong,div')];
    for (const el of candidates) {
      if (el.closest('#oxigenio-wellhub-badge')) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!targets.some((t) => txt.includes(t)) || txt.length > 70) continue;
      let card = el.parentElement;
      for (let i = 0; i < 8 && card && card !== document.body; i += 1) {
        const cardText = (card.textContent || '').toLowerCase();
        if (excludes.some((ex) => cardText.includes(ex))) break;
        const rect = card.getBoundingClientRect();
        if (rect.width > 220 && rect.height > 120) return card;
        card = card.parentElement;
      }
    }
    return null;
  }

  function findPendingCard() {
    return findSectionCardByTitle(
      ['Check-ins para confirmar', 'Check-ins para validar'],
      ['Check-ins confirmados', 'Check-ins validados'],
    );
  }

  function findConfirmedCard() {
    return findSectionCardByTitle(
      ['Check-ins confirmados', 'Check-ins validados'],
      ['Check-ins para confirmar', 'Check-ins para validar'],
    );
  }

  function clickRefreshButtons() {
    const now = Date.now();
    const intervalMs = Math.max(4, Number(cfg.refreshSeconds) || 8) * 1000;
    if (now - lastRefreshAt < intervalMs) return;
    lastRefreshAt = now;

    if (isTotalpass) {
      // O painel TotalPass nao possui botao manual de atualizar; recarrega suavemente no intervalo configurado (min 15s)
      const tpIntervalMs = Math.max(15000, intervalMs);
      if (performance.now() > tpIntervalMs && !document.hidden) {
        location.reload();
      }
      return;
    }

    [findPendingCard(), findConfirmedCard()].forEach((card) => {
      if (!card) return;
      const clickables = [...card.querySelectorAll('button, [role="button"], svg')];
      const refreshTarget = clickables.find((el) => {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (txt === 'atualizar' || txt === 'refresh') return true;
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
        if (label.includes('atualiz') || label.includes('refresh') || label.includes('reload')) return true;
        if (txt) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 12 && rect.width <= 44 && rect.height >= 12 && rect.height <= 44;
      });
      if (refreshTarget) {
        const btn = refreshTarget.closest('button, [role="button"]') || refreshTarget;
        if (!btn.disabled) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }
    });
  }

  function tryAutoConfirmPending() {
    if (!cfg.autoConfirm) return;
    const now = Date.now();
    if (now - lastConfirmClickAt < 1800) return;

    const confirmBtns = [...document.querySelectorAll('button')].filter((btn) => {
      if (btn.disabled || btn.closest('#oxigenio-wellhub-badge')) return false;
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return /^(confirmar|aceitar|validar|validar check-?in|confirm|accept)$/.test(txt);
    });

    if (confirmBtns.length > 0) {
      lastConfirmClickAt = now;
      confirmBtns[0].click();
      updateBadge(`Oxigênio Bot (${providerLabel}): Validando check-in...`);
    }
  }

  function extractTotalpassCheckins() {
    const todayBr = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const items = [];
    const seen = new Set();

    // 1) Linhas estruturadas da tabela MUI (Historico de visitas / Validar Check-in)
    const tableRows = [...document.querySelectorAll('tbody[data-testid="tableBody"] tr.MuiTableRow-root')];
    for (const row of tableRows) {
      const dateText = (row.querySelector('[data-testid="dateTimeBodyCell"]')?.innerText || '').trim();
      if (dateText && !dateText.includes(todayBr)) continue;

      const statusText = (row.querySelector('[data-testid="statusChip"] .MuiChip-label')?.textContent || '').trim().toLowerCase();
      if (statusText && statusText.includes('expirado')) continue;

      const nameCell = row.querySelector('[data-testid="nameDocumentBodyCell"]');
      if (!nameCell) continue;
      const ps = [...nameCell.querySelectorAll('p')];
      const name = (ps[0]?.textContent || '').trim();
      const cpfRaw = (ps[1]?.textContent || '').replace(/\D/g, '');
      const key = (cpfRaw || name).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        name,
        cpf: cpfRaw,
        time_text: dateText.replace(/\s+/g, ' '),
      });
    }

    // 2) Cards/itens dentro da aba "Validar Check-in" (div[data-testid="validateTab"])
    const validateContainer = document.querySelector('[data-testid="validateTab"], #tabpanel-0');
    if (validateContainer && !validateContainer.querySelector('[data-testid="emptyWrapper"]')) {
      const ignored = /^(atenção:|saiba mais|validar|confirmar|validar check-?in)$/i;
      const blocks = [...validateContainer.querySelectorAll('tr, [role="row"], li, [role="listitem"], div')].filter((el) => {
        if (el.closest('#oxigenio-wellhub-badge') || el.closest('[data-testid="checkInsValidateWarnWrapper"]')) return false;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 260) return false;
        return (/\b\d{11}\b/.test(text) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(text) || /\d{1,2}[h:]\d{2}/.test(text))
          && el.querySelectorAll('div, td, p, span').length <= 12;
      });
      for (const block of blocks) {
        const text = (block.innerText || '').trim();
        const cpfMatch = text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/);
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !ignored.test(l) && !/^(atenção:|todos os check-ins)/i.test(l));
        const candidateName = lines.find((l) => l.length >= 4 && !/\d/.test(l)) || '';
        const cpfDigits = cpfMatch ? cpfMatch[0].replace(/\D/g, '') : '';
        const key = (cpfDigits || candidateName).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({
          name: candidateName,
          cpf: cpfDigits,
          time_text: text.match(/\d{1,2}[h:]\d{2}/)?.[0] || '',
        });
      }
    }

    return items;
  }

  function extractConfirmedCheckins() {
    if (isTotalpass) return extractTotalpassCheckins();

    const confirmedCard = findConfirmedCard();
    if (!confirmedCard) return [];

    const lines = (confirmedCard.innerText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const timeRegex = /^(?:\d{1,2}\s+de\s+[a-zç.]+\s*,?\s*\d{1,2}:\d{2}|\d{1,2}:\d{2}|validado\s+[aà]s\s+\d{1,2}[h:]\d{2})$/i;
    const headerIgnore = /^(check-ins confirmados|check-ins validados|ver check-ins de hoje|atualizar|nenhum check-in.*|atualize para novos check-ins|\d+)$/i;
    const items = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i += 1) {
      if (!timeRegex.test(lines[i])) continue;
      const prev1 = lines[i - 1] || '';
      const prev2 = lines[i - 2] || '';
      const candidateName = prev2 && !headerIgnore.test(prev2) && !timeRegex.test(prev2) ? prev2 : prev1;
      const modality = candidateName === prev2 ? prev1 : '';
      if (!candidateName || candidateName.length < 3 || headerIgnore.test(candidateName) || /\d/.test(candidateName)) {
        continue;
      }
      const key = candidateName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        name: candidateName,
        modality,
        time_text: lines[i],
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
      updateBadge(`Oxigênio Bot (${providerLabel}): Pausado`);
      return;
    }

    clickRefreshButtons();
    tryAutoConfirmPending();

    const confirmed = extractConfirmedCheckins();
    const pendingToSend = confirmed.filter((item) => {
      const k = (item.cpf || item.name || '').toLowerCase();
      return k && !sentNamesToday.has(k);
    });
    if (!pendingToSend.length) {
      updateBadge(`Oxigênio Bot (${providerLabel}): Vigiando (${confirmed.length} na tela)`);
      return;
    }

    chrome.runtime.sendMessage({ type: 'WELLHUB_SYNC_CHECKINS', provider, items: pendingToSend }, (res) => {
      if (chrome.runtime.lastError) {
        updateBadge(`Oxigênio Bot (${providerLabel}): ${chrome.runtime.lastError.message}`, true);
        return;
      }
      if (!res || res.error) {
        updateBadge(`Oxigênio Bot (${providerLabel}): ${res?.error || 'Falha ao sincronizar'}`, true);
        return;
      }
      pendingToSend.forEach((item) => {
        const k = (item.cpf || item.name || '').toLowerCase();
        if (k) sentNamesToday.add(k);
      });
      updateBadge(`Oxigênio Bot (${providerLabel}): ${res.matched?.length || 0} liberado(s) · ${res.unmatched?.length || 0} não encontrado(s)`);
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
        if (!onlyBadge) scheduleScan(900);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(scanAndSync, 3000);
    setTimeout(scanAndSync, 2000);
  }

  init();
})();
