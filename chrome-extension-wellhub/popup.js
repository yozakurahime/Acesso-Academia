const DEFAULTS = {
  enabled: true,
  autoConfirm: true,
  refreshSeconds: 8,
  apiUrl: 'https://sistema.academiaoxigenio.com',
  username: '',
  password: '',
  lastSyncAt: '',
  lastError: '',
  lastMatched: [],
  lastUnmatched: [],
};

async function load() {
  const data = await chrome.storage.local.get(DEFAULTS);
  document.getElementById('enabled').checked = Boolean(data.enabled);
  document.getElementById('autoConfirm').checked = Boolean(data.autoConfirm);
  document.getElementById('apiUrl').value = data.apiUrl || DEFAULTS.apiUrl;
  document.getElementById('username').value = data.username || '';
  document.getElementById('password').value = data.password || '';
  document.getElementById('refreshSeconds').value = data.refreshSeconds || 8;

  const box = document.getElementById('statusBox');
  const lines = [];
  if (data.lastSyncAt) lines.push(`Última sincronização: <strong>${data.lastSyncAt}</strong>`);
  if (data.lastError) lines.push(`<div class="err">${data.lastError}</div>`);
  if (data.lastMatched?.length) {
    lines.push(`<div>Liberados (${data.lastMatched.length}):<ul>${data.lastMatched.map((m) => `<li>${m.name}</li>`).join('')}</ul></div>`);
  }
  if (data.lastUnmatched?.length) {
    lines.push(`<div>Não encontrados no cadastro (${data.lastUnmatched.length}):<ul>${data.lastUnmatched.map((u) => `<li>${u.name}</li>`).join('')}</ul></div>`);
  }
  box.innerHTML = lines.length ? lines.join('') : 'Abra a aba do Wellhub e mantenha na tela de check-ins.';
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({
    enabled: document.getElementById('enabled').checked,
    autoConfirm: document.getElementById('autoConfirm').checked,
    apiUrl: document.getElementById('apiUrl').value.trim() || DEFAULTS.apiUrl,
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
    refreshSeconds: Math.max(4, Number(document.getElementById('refreshSeconds').value) || 8),
  });
  const btn = document.getElementById('saveBtn');
  btn.textContent = 'Salvo!';
  setTimeout(() => { btn.textContent = 'Salvar configurações'; }, 1200);
});

load();
