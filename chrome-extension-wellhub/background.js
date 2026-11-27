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

async function postSync(baseUrl, items, cfg, allowRelogin = true, provider = 'wellhub') {
  const cleanUrl = String(baseUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  const resp = await fetch(`${cleanUrl}/api/partners/wellhub/extension-sync`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, items }),
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
    return postSync(cleanUrl, items, cfg, false, provider);
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Erro HTTP ${resp.status} ao sincronizar.`);
  }

  return resp.json();
}

const WELLHUB_URL = 'https://partners.gympass.com/validation/academia-oxigenio--3';
const TOTALPASS_URL = 'https://booking.totalpass.com/br/check-ins';

async function checkRequiredTabs() {
  const cfg = await getConfig();
  const tabs = await chrome.tabs.query({});
  const wellhubOpen = tabs.some((t) => /partners\.(gympass|wellhub)\.com\/(new\/)?validation\//i.test(t.url || ''));
  const totalpassOpen = tabs.some((t) => /booking\.totalpass\.com\/br\/check-ins/i.test(t.url || ''));
  const missing = cfg.enabled && (!wellhubOpen || !totalpassOpen);
  await chrome.action.setBadgeText({ text: missing ? '!' : '' }).catch(() => {});
  if (missing) {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
  }
  return { enabled: cfg.enabled, wellhubOpen, totalpassOpen };
}

chrome.tabs?.onCreated?.addListener(() => checkRequiredTabs().catch(() => {}));
chrome.tabs?.onRemoved?.addListener(() => checkRequiredTabs().catch(() => {}));
chrome.tabs?.onUpdated?.addListener((_tabId, info) => {
  if (info.url || info.status === 'complete') checkRequiredTabs().catch(() => {});
});
checkRequiredTabs().catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CHECK_PARTNER_TABS') {
    checkRequiredTabs()
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ enabled: true, wellhubOpen: true, totalpassOpen: true }));
    return true;
  }
  if (message?.type === 'OPEN_PARTNER_TAB') {
    const url = message.provider === 'totalpass' ? TOTALPASS_URL : WELLHUB_URL;
    chrome.tabs.create({ url }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type !== 'WELLHUB_SYNC_CHECKINS') return false;

  (async () => {
    const cfg = await getConfig();
    if (!cfg.enabled) {
      sendResponse({ ok: false, skipped: true });
      return;
    }
    const items = Array.isArray(message.items) ? message.items : [];
    const provider = message.provider === 'totalpass' ? 'totalpass' : 'wellhub';
    if (!items.length) {
      sendResponse({ ok: true, syncedCount: 0, matched: [], unmatched: [] });
      return;
    }

    const result = await postSync(cfg.apiUrl, items, cfg, true, provider);
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
