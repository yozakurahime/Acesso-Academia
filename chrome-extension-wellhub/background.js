const DEFAULT_CONFIG = {
  enabled: true,
  autoConfirm: true,
  refreshSeconds: 8,
  apiUrl: 'https://sistema.academiaoxigenio.com',
  username: '',
  password: '',
};

async function getConfig() {
  const saved = await chrome.storage.local.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...saved };
}

async function postSync(baseUrl, items, cfg, allowRelogin = true) {
  const cleanUrl = String(baseUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  const resp = await fetch(`${cleanUrl}/api/partners/wellhub/extension-sync`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });

  if (resp.status === 401 && allowRelogin && cfg.username && cfg.password) {
    const loginResp = await fetch(`${cleanUrl}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: cfg.username,
        password: cfg.password,
        rememberSession: true,
      }),
    });
    if (!loginResp.ok) {
      throw new Error('Falha ao autenticar no sistema Oxigênio (verifique usuário/senha).');
    }
    return postSync(cleanUrl, items, cfg, false);
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Erro HTTP ${resp.status} ao sincronizar.`);
  }

  return resp.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'WELLHUB_SYNC_CHECKINS') return false;

  (async () => {
    const cfg = await getConfig();
    if (!cfg.enabled) {
      sendResponse({ ok: false, skipped: true });
      return;
    }
    const items = Array.isArray(message.items) ? message.items : [];
    if (!items.length) {
      sendResponse({ ok: true, syncedCount: 0, matched: [], unmatched: [] });
      return;
    }

    const result = await postSync(cfg.apiUrl, items, cfg);
    await chrome.storage.local.set({
      lastSyncAt: new Date().toLocaleTimeString('pt-BR'),
      lastError: '',
      lastMatched: (result.matched || []).slice(0, 15),
      lastUnmatched: (result.unmatched || []).slice(0, 15),
    });
    sendResponse(result);
  })().catch(async (err) => {
    await chrome.storage.local.set({
      lastSyncAt: new Date().toLocaleTimeString('pt-BR'),
      lastError: err?.message || 'Erro desconhecido ao sincronizar.',
    });
    sendResponse({ ok: false, error: err?.message || 'Erro ao sincronizar.' });
  });

  return true;
});
