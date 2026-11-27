(() => {
  const ALERT_ID = 'oxigenio-partner-tabs-alert';
  let styleAdded = false;

  function ensureStyles() {
    if (styleAdded || !document.head) return;
    styleAdded = true;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes oxigenioPulseAlert {
        0%, 100% { box-shadow: 0 6px 24px rgba(220, 38, 38, 0.45); }
        50% { box-shadow: 0 6px 30px rgba(234, 179, 8, 0.75); }
      }
      #${ALERT_ID} {
        position: fixed;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        background: #b91c1c;
        color: #fff;
        padding: 10px 16px;
        border-radius: 10px;
        border: 2px solid #fde047;
        font: 600 13px/1.35 system-ui, -apple-system, sans-serif;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        max-width: 92vw;
        animation: oxigenioPulseAlert 1.6s infinite;
      }
      #${ALERT_ID} button {
        background: #fde047;
        color: #111827;
        border: 0;
        border-radius: 6px;
        padding: 6px 11px;
        font: 700 12px/1 system-ui, -apple-system, sans-serif;
        cursor: pointer;
      }
      #${ALERT_ID} button:hover {
        background: #fef08a;
      }
    `;
    document.head.appendChild(style);
  }

  function renderAlert(status) {
    const existing = document.getElementById(ALERT_ID);
    if (!status?.enabled || (status.wellhubOpen && status.totalpassOpen)) {
      if (existing) existing.remove();
      return;
    }

    ensureStyles();
    const missingNames = [];
    if (!status.wellhubOpen) missingNames.push('Wellhub');
    if (!status.totalpassOpen) missingNames.push('TotalPass');

    const box = existing || document.createElement('div');
    box.id = ALERT_ID;
    box.innerHTML = '';

    const text = document.createElement('span');
    text.textContent = `⚠️ ATENÇÃO: Aba fechada (${missingNames.join(' e ')})! Abra para liberar a catraca automático:`;
    box.appendChild(text);

    if (!status.wellhubOpen) {
      const btnW = document.createElement('button');
      btnW.type = 'button';
      btnW.textContent = 'Abrir Wellhub';
      btnW.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_PARTNER_TAB', provider: 'wellhub' }));
      box.appendChild(btnW);
    }

    if (!status.totalpassOpen) {
      const btnT = document.createElement('button');
      btnT.type = 'button';
      btnT.textContent = 'Abrir TotalPass';
      btnT.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_PARTNER_TAB', provider: 'totalpass' }));
      box.appendChild(btnT);
    }

    if (!existing && document.body) {
      document.body.appendChild(box);
    }
  }

  function check() {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: 'CHECK_PARTNER_TABS' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      renderAlert(res);
    });
  }

  setInterval(check, 5000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
  setTimeout(check, 1200);
})();
