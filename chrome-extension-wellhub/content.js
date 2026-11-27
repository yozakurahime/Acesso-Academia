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
      // O painel TotalPass nao possui botao manual de atualizar; recarrega suavemente no intervalo configurado (min 15s), mesmo em segundo plano
      const tpIntervalMs = Math.max(15000, intervalMs);
      if (performance.now() > tpIntervalMs) {
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
    if (!cfg.autoConfirm) return false;
    const now = Date.now();
    if (now - lastConfirmClickAt < 2500) return true;

    const dialogBtns = [...document.querySelectorAll('[role="dialog"] button')].filter((btn) => {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return /^(confirmar|aceitar|validar|sim|ok|confirm|accept)$/.test(txt);
    });

    const confirmBtns = dialogBtns.length
      ? dialogBtns
      : [...document.querySelectorAll('button[data-testid="buttonValidate"], button')].filter((btn) => {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.closest('#oxigenio-wellhub-badge')) return false;
          if (btn.dataset.testid === 'buttonValidate') return true;
          const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          return /^(confirmar|aceitar|validar|validar check-?in|confirm|accept)$/.test(txt);
        });

    if (confirmBtns.length > 0) {
      const btn = confirmBtns[0];
      lastConfirmClickAt = now;
      console.log(`[Oxigênio Bot] Clicando em "${(btn.textContent || '').trim()}"`, btn.dataset?.testid || '');
      try { btn.focus(); } catch {}
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      btn.click();
      updateBadge(`Oxigênio Bot (${providerLabel}): Validando check-in...`);
      return true;
    }
    return false;
  }

  function extractTotalpassCheckins() {
    const nowDate = new Date();
    const todayBr = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(nowDate);
    const todayShort = `${todayBr.slice(0, 6)}${todayBr.slice(8)}`;
    const isTodayText = (txt) => {
      const low = String(txt || '').toLowerCase();
      if (!low) return true;
      if (low.includes(todayBr) || low.includes(todayShort) || low.includes('hoje')) return true;
      return !/\d{2}\/\d{2}\/\d{2,4}/.test(low);
    };
    const items = [];
    const seen = new Set();

    // 1) Linhas estruturadas da tabela MUI (Historico de visitas / Validar Check-in)
    const tableRows = [...document.querySelectorAll('tbody[data-testid="tableBody"] tr.MuiTableRow-root, table tbody tr')];
    for (const row of tableRows) {
      const dateText = (row.querySelector('[data-testid="dateTimeBodyCell"]')?.innerText || row.innerText || '').trim();
      if (!isTodayText(dateText)) continue;

      const statusText = (row.querySelector('[data-testid="statusChip"] .MuiChip-label')?.textContent || row.innerText || '').trim().toLowerCase();
      if (statusText && statusText.includes('expirado')) continue;

      const nameCell = row.querySelector('[data-testid="nameDocumentBodyCell"]') || row.querySelector('td');
      if (!nameCell) continue;
      const ps = [...nameCell.querySelectorAll('p')];
      const name = (ps[0]?.textContent || nameCell.innerText.split('\n')[0] || '').trim();
      const cpfRaw = (ps[1]?.textContent || row.innerText.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/)?.[0] || '').replace(/\D/g, '');
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
    const nameEls = [...document.querySelectorAll('[data-testid="validateTab"] [data-testid="nameItem"], #tabpanel-0 [data-testid="nameItem"]')];
    for (const nameEl of nameEls) {
      const card = nameEl.closest('.css-fwvxvs, [role="row"], li, div[style]') || nameEl.parentElement?.parentElement?.parentElement;
      const candidateName = (nameEl.textContent || '').trim();
      if (!candidateName) continue;
      const cardText = (card?.innerText || '').trim();
      if (!isTodayText(cardText)) continue;
      // Se ainda tem o botao Validar habilitado e autoConfirm esta ativo, deixa validar primeiro
      if (cfg.autoConfirm && card?.querySelector('button[data-testid="buttonValidate"]:not(:disabled)')) {
        continue;
      }
      const cpfMatch = cardText.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{11}\b/);
      const cpfDigits = cpfMatch ? cpfMatch[0].replace(/\D/g, '') : '';
      const key = (cpfDigits || candidateName).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push({
        name: candidateName,
        cpf: cpfDigits,
        time_text: cardText.match(/\d{1,2}[h:]\d{2}/)?.[0] || '',
      });
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
    const validatingNow = tryAutoConfirmPending();

    const confirmed = extractConfirmedCheckins();
    const pendingToSend = confirmed.filter((item) => {
      const k = (item.cpf || item.name || '').toLowerCase();
      return k && !sentNamesToday.has(k);
    });
    if (!pendingToSend.length) {
      if (!validatingNow) {
        updateBadge(`Oxigênio Bot (${providerLabel}): Vigiando (${confirmed.length} na tela)`);
      }
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
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'OXIGENIO_TICK_SCAN') scanAndSync();
    });
    setInterval(scanAndSync, 3000);
    setTimeout(scanAndSync, 2000);
  }

  init();
})();
