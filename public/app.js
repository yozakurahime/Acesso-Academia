const state = {
  plans: [],
  allMembers: [],
  teamMembers: [],
  memberSearchIndex: [],
  filteredMembers: [],
  memberFilter: 'all',
  memberLimit: 50,
  modalities: [],
  instructors: [],
  classes: [],
  staff: [],
  paymentMethods: [],
  products: [],
  logs: [],
  logsLimit: 50,
  gymName: 'Academia Oxigênio',
  gymPhone: '',
  cashSession: null,
  selectedProfileId: null,
  selectedProfileName: null,
  selectedProfileMember: null,
  selectedFaceMemberId: null,
  selectedFaceBase64: null,
  webcamStream: null,
  logsTimer: null,
  activeTab: 'dashboard',
  authRole: 'admin',
};

const ROLE_RESTRICTED_ADMIN_SELECTORS = [
  '.tab[data-tab="reports"]',
  '#tab-reports',
  '#settings-rbac',
  '#settings-audit',
  '#settings-backup',
  '#settings-gateways',
  '#btnCheckExpired',
];

const INSTRUCTOR_HIDDEN_TABS = ['billing', 'cash', 'products', 'reports'];

function isTabAllowedForRole(tabName, role = state.authRole) {
  const effectiveRole = role || 'admin';
  if (effectiveRole === 'admin') return true;
  if (tabName === 'reports') return false;
  if (effectiveRole === 'instructor' && INSTRUCTOR_HIDDEN_TABS.includes(tabName)) return false;
  return true;
}

function applyRoleUi(role) {
  const effectiveRole = role || 'admin';
  state.authRole = effectiveRole;
  const isAdmin = effectiveRole === 'admin';
  const isInstructor = effectiveRole === 'instructor';

  for (const selector of ROLE_RESTRICTED_ADMIN_SELECTORS) {
    document.querySelectorAll(selector).forEach((el) => el.classList.toggle('hidden', !isAdmin));
  }
  for (const tab of INSTRUCTOR_HIDDEN_TABS) {
    document.querySelectorAll(`.tab[data-tab="${tab}"]`).forEach((el) => el.classList.toggle('hidden', isInstructor));
  }
  if (!isTabAllowedForRole(state.activeTab, effectiveRole)) {
    switchTab('dashboard');
  }
}

const moneyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtMoney = (cents) => moneyFormat.format((Number(cents) || 0) / 100);

const toCents = (reais) => Math.round(Number(reais || 0) * 100);
const accessRoles = { student: 'Aluno', user: 'Usuário da equipe', instructor: 'Professor', staff: 'Funcionário' };
for (const id of ['stRole', 'profAccessRole', 'promoteStudentRole']) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.innerHTML = Object.entries(accessRoles)
    .filter(([value]) => (id !== 'stRole' && id !== 'promoteStudentRole') || value !== 'student')
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  if (id === 'promoteStudentRole') el.value = 'staff';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHttpUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url), window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function sanitizeQrImageSrc(val) {
  const raw = String(val || '').trim();
  if (!raw) return '';
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(raw)) return raw;
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) return `data:image/png;base64,${raw}`;
  return '';
}

function fmtDate(iso) {
  if (!iso) return '-';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : fmtDate(iso);
}

function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${isError ? 'err' : 'ok'}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = '';
    el.className = 'toast';
  }, 4500);
}

let turnstileEventSource = null;

function handleTurnstileReleaseEvent(ev) {
  if (!ev) return;

  const name = ev.memberName || 'Liberação manual';
  const timeText = ev.occurredAt
    ? new Date(ev.occurredAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const liveSub = document.getElementById('sidebarLiveSubtitle');
  if (liveSub) {
    const shortName = String(name).trim().split(/\s+/).slice(0, 2).join(' ');
    liveSub.textContent = `Último: ${shortName} · ${timeText.slice(0, 5)}`;
  }
  api('/api/occupancy').then((occ) => updateSidebarLiveOccupancy(occ)).catch(() => {});
}

function stopTurnstileEventsStream() {
  if (turnstileEventSource) {
    turnstileEventSource.close();
    turnstileEventSource = null;
  }
}

function startTurnstileEventsStream() {
  if (window.oxigenioDemo || typeof window.EventSource !== 'function' || turnstileEventSource) return;
  const es = new EventSource('/api/turnstile/events');
  es.addEventListener('release', (msg) => {
    try {
      const data = JSON.parse(msg.data);
      handleTurnstileReleaseEvent(data);
    } catch {
      // Ignora payload malformado.
    }
  });
  turnstileEventSource = es;
}

function cpfDigits(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11);
}

function formatCpfMask(value) {
  const d = cpfDigits(value);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function isValidCpf(value) {
  const d = cpfDigits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(d[i]) * (len + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function setCpfFieldState(inputEl, feedbackEl, status, message = '') {
  if (!inputEl || !feedbackEl) return;
  inputEl.classList.remove('is-cpf-valid', 'is-cpf-error');
  feedbackEl.classList.remove('is-valid', 'is-error');
  feedbackEl.textContent = message;
  if (status === 'valid') {
    inputEl.classList.add('is-cpf-valid');
    feedbackEl.classList.add('is-valid');
  } else if (status === 'error') {
    inputEl.classList.add('is-cpf-error');
    feedbackEl.classList.add('is-error');
  }
}

async function validateCpfField(inputId, feedbackId, { excludeId = 0, remoteCheck = false, showEmptyError = false } = {}) {
  const inputEl = document.getElementById(inputId);
  const feedbackEl = document.getElementById(feedbackId);
  if (!inputEl) return { valid: false, message: 'Campo CPF não encontrado.' };
  const digits = cpfDigits(inputEl.value);
  inputEl.value = formatCpfMask(digits);

  if (!digits) {
    const msg = showEmptyError ? 'CPF é obrigatório.' : '';
    setCpfFieldState(inputEl, feedbackEl, showEmptyError ? 'error' : 'neutral', msg);
    return { valid: false, message: 'CPF é obrigatório.' };
  }
  if (digits.length < 11) {
    const msg = remoteCheck ? 'CPF inválido (informe os 11 dígitos).' : 'Digite os 11 dígitos do CPF.';
    setCpfFieldState(inputEl, feedbackEl, remoteCheck ? 'error' : 'neutral', msg);
    return { valid: false, message: 'CPF inválido (informe os 11 dígitos).' };
  }
  if (!isValidCpf(digits)) {
    setCpfFieldState(inputEl, feedbackEl, 'error', 'CPF inválido.');
    return { valid: false, message: 'CPF inválido. Confira os dígitos informados.' };
  }

  const localDup = (state.allMembers || []).find(
    (m) => Number(m.id) !== Number(excludeId) && cpfDigits(m.document) === digits,
  );
  if (localDup) {
    const msg = `CPF já cadastrado para ${localDup.name} (ID #${localDup.id}).`;
    setCpfFieldState(inputEl, feedbackEl, 'error', msg);
    return { valid: false, message: msg };
  }

  if (remoteCheck) {
    try {
      const check = await api(`/api/members/check-cpf?cpf=${encodeURIComponent(digits)}&excludeId=${Number(excludeId) || 0}`);
      if (!check.valid) {
        setCpfFieldState(inputEl, feedbackEl, 'error', check.message || 'CPF inválido.');
        return { valid: false, message: check.message || 'CPF inválido.' };
      }
    } catch (err) {
      setCpfFieldState(inputEl, feedbackEl, 'error', err.message);
      return { valid: false, message: err.message };
    }
  }

  setCpfFieldState(inputEl, feedbackEl, 'valid', 'CPF válido.');
  return { valid: true, message: 'CPF válido.' };
}

function attachCpfValidation(inputId, feedbackId, getExcludeId = () => 0) {
  const inputEl = document.getElementById(inputId);
  if (!inputEl) return;
  inputEl.addEventListener('input', () => {
    validateCpfField(inputId, feedbackId, { excludeId: getExcludeId(), remoteCheck: false, showEmptyError: false });
  });
  inputEl.addEventListener('blur', () => {
    if (!inputEl.value.trim()) {
      setCpfFieldState(inputEl, document.getElementById(feedbackId), 'neutral', '');
      return;
    }
    validateCpfField(inputId, feedbackId, { excludeId: getExcludeId(), remoteCheck: true, showEmptyError: false });
  });
}

async function withLoading(triggerEl, fn) {
  const btn = triggerEl?.matches?.('button, input[type="submit"]')
    ? triggerEl
    : triggerEl?.querySelector?.('button[type="submit"]');
  if (btn?.disabled) return;
  const label = btn?.querySelector('[data-button-label]') || btn;
  const originalText = label?.textContent;
  if (btn) {
    btn.disabled = true;
    label.textContent = 'Aguarde…';
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      label.textContent = originalText;
    }
  }
}

async function api(url, options = {}) {
  if (window.oxigenioDemo) return window.oxigenioDemo.request(url, options);
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const message = res.status === 404
      ? 'Esta função não está disponível no servidor atual. Reinicie o sistema pelo iniciar.bat e recarregue a página.'
      : `O servidor retornou uma resposta inesperada (HTTP ${res.status}). Confira se o sistema local está aberto e tente novamente.`;
    throw new Error(message);
  }
  const data = await res.json().catch(() => {
    throw new Error('O servidor retornou dados inválidos. Recarregue a página e tente novamente.');
  });
  if (res.status === 401 && data?.code === 'AUTH_REQUIRED') {
    clearSessionState();
    showLoginOverlay();
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erro na requisicao'), { code: data.code });
  return data;
}

// Carrega os dados de cada área na primeira visita e permite repetir falhas.
const tabRequests = new Map();
const sharedLoads = new Map();

function loadOnce(loader) {
  if (!sharedLoads.has(loader)) {
    sharedLoads.set(loader, loader().catch((err) => {
      sharedLoads.delete(loader);
      throw err;
    }));
  }
  return sharedLoads.get(loader);
}

const tabLoaders = {
  dashboard: () => Promise.all([loadDashboard(), loadOnce(loadSettings), loadOnce(loadDevices), loadCurrentCash()]),
  members: () => Promise.all([loadOnce(loadMembers), loadOnce(loadPlans), loadOnce(loadGymStructure)]),
  billing: () => Promise.all([
    loadOnce(loadMembers), loadOnce(loadPlans), loadOnce(loadSettings),
    loadOnce(loadPaymentMethods).then(loadCurrentCash),
    loadOpenDebts(),
  ]),
  cash: () => Promise.all([
    loadOnce(loadSettings), loadOnce(loadStaff), loadCurrentCash(), loadCashHistory(),
  ]).then(() => {
    const supplementary = [loadPayments, loadReceipts, loadGatewayCharges, loadPointOrders, loadMpSubscriptions];
    Promise.allSettled(supplementary.map((load) => load())).then((results) => {
      if (results.some((result) => result.status === 'rejected')) showToast('Alguns históricos do caixa não carregaram.', true);
    });
  }),
  products: () => Promise.all([
    loadOnce(loadMembers), loadOnce(loadSettings), loadOnce(loadPaymentMethods).then(() => Promise.all([loadProducts(), loadCurrentCash()])),
  ]),
  classes: () => loadOnce(loadGymStructure),
  workouts: () => Promise.all([loadWorkoutTemplates(), loadExerciseCatalog()]),
  staff: () => Promise.all([loadOnce(loadStaff), loadOnce(loadMembers), loadOnce(loadGymStructure)]),
  chat: loadChats,
  logs: loadLogs,
  reports: () => Promise.all([loadOnce(loadMembers), loadReports()]),
  settings: () => Promise.all([
    loadOnce(loadSettings), loadOnce(loadDevices), loadOnce(loadPaymentMethods), loadOnce(loadGymStructure), loadOnce(loadPlans),
    loadWhatsappStatus(), loadRbacUsers().catch(() => {}), loadAuditLogs().catch(() => {}), loadBackups().catch(() => {}),
  ]),
};

function loadTab(tabName) {
  if (tabRequests.has(tabName)) return tabRequests.get(tabName);
  const panel = document.getElementById(`tab-${tabName}`);
  let status = panel.querySelector('.tab-load-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'tab-load-status';
    status.setAttribute('role', 'status');
    panel.querySelector('.page-title').after(status);
  }
  const forms = tabName === 'dashboard' ? [] : [...panel.querySelectorAll('form')];
  forms.forEach((form) => { form.inert = true; });
  status.textContent = 'Carregando…';
  const request = tabLoaders[tabName]().then(() => {
    status.textContent = '';
    forms.forEach((form) => { form.inert = false; });
    return true;
  }).catch((err) => {
    console.error(`[tab:${tabName}]`, err);
    tabRequests.delete(tabName);
    status.textContent = `Não foi possível carregar esta área${err?.message ? `: ${err.message}` : '.'}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-secondary btn-sm';
    retry.textContent = 'Tentar novamente';
    retry.addEventListener('click', () => loadTab(tabName));
    status.append(retry);
    return false;
  });
  tabRequests.set(tabName, request);
  return request;
}

const VOLATILE_TABS = new Set(['dashboard', 'billing', 'cash', 'logs', 'reports', 'settings']);

function switchTab(tabName, { updateHash = true } = {}) {
  let target = Object.hasOwn(tabLoaders, tabName) ? tabName : 'dashboard';
  if (!isTabAllowedForRole(target)) target = 'dashboard';
  if (state.activeTab !== target) stopPaymentAutoPoll();
  state.activeTab = target;
  if (VOLATILE_TABS.has(target)) tabRequests.delete(target);
  if (updateHash && window.location.hash !== `#/${target}`) {
    history.pushState(null, '', `#/${target}`);
  }
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tab === target;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
  const tabButton = document.querySelector(`.tab[data-tab="${target}"]`);
  document.getElementById('workspaceLocation').textContent = tabButton?.textContent.trim() || 'Recepção';
  if (window.matchMedia('(max-width: 850px)').matches && workspaceMenuToggle.getAttribute('aria-expanded') === 'true') {
    if (document.getElementById('workspaceMenu').contains(document.activeElement)) {
      document.getElementById('workspaceContent').focus({ preventScroll: true });
    }
    setWorkspaceMenu(false);
  }
  window.scrollTo(0, 0);
  return loadTab(target);
}

function getTabFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  return Object.hasOwn(tabLoaders, raw) ? raw : 'dashboard';
}

window.addEventListener('hashchange', () => {
  const nextTab = getTabFromHash();
  if (nextTab !== state.activeTab) {
    switchTab(nextTab, { updateHash: false });
  }
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-switch-tab]');
  if (!btn) return;
  const tab = btn.dataset.switchTab;
  if (tab) switchTab(tab);
});

const workspaceMenuToggle = document.getElementById('workspaceMenuToggle');
function setWorkspaceMenu(open) {
  workspaceMenuToggle.setAttribute('aria-expanded', String(open));
  document.getElementById('workspaceMenu').classList.toggle('menu-expanded', open);
}
workspaceMenuToggle.addEventListener('click', () => {
  const open = workspaceMenuToggle.getAttribute('aria-expanded') !== 'true';
  setWorkspaceMenu(open);
  if (open) document.querySelector('#workspaceMenu .tab[aria-current="page"]')?.focus();
});
document.getElementById('workspaceMenu').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || workspaceMenuToggle.getAttribute('aria-expanded') !== 'true') return;
  setWorkspaceMenu(false);
  workspaceMenuToggle.focus();
});

const commandDialog = document.getElementById('workspaceCommands');
const commandField = document.getElementById('workspaceCommandInput');
const commandResults = document.getElementById('workspaceCommandResults');
function findCommandMembers(query, limit = 8) {
  const q = normalizeSearch(query);
  if (!q) return [];
  const digits = numericSearch(q);
  const idQuery = q.replace(/^#/, '');
  const matches = [];
  const seen = new Set();

  const scoreEntry = (member, normName, doc, phone, docDigits, phoneDigits) => {
    if (seen.has(member.id)) return -1;
    if (idQuery && /^\d+$/.test(idQuery) && String(member.id) === idQuery) return 100;
    if (normName.startsWith(q)) return 90;
    if (normName.includes(q)) return 70;
    if (digits && (docDigits.includes(digits) || phoneDigits.includes(digits))) return 60;
    if (doc.includes(q) || phone.includes(q)) return 50;
    return -1;
  };

  for (const entry of state.memberSearchIndex) {
    const score = scoreEntry(entry.member, entry.name, entry.document, entry.phone, entry.documentDigits, entry.phoneDigits);
    if (score >= 0) {
      seen.add(entry.member.id);
      matches.push({ member: entry.member, score });
    }
  }
  for (const member of state.teamMembers || []) {
    const doc = normalizeSearch(member.document);
    const phone = normalizeSearch(member.phone);
    const score = scoreEntry(member, normalizeSearch(member.name), doc, phone, numericSearch(doc), numericSearch(phone));
    if (score >= 0) {
      seen.add(member.id);
      matches.push({ member, score });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.member.name.localeCompare(b.member.name));
  return matches.slice(0, limit).map((item) => item.member);
}

function renderWorkspaceCommands() {
  const query = commandField.value.trim();
  const actions = [];

  if (query) {
    const statusLabels = { active: 'Ativo', blocked: 'Bloqueado', pending: 'Pendente' };
    for (const member of findCommandMembers(query, 8)) {
      const roleLabel = member.access_role && member.access_role !== 'student'
        ? (accessRoles[member.access_role] || 'Equipe')
        : (statusLabels[member.access_status || member.status] || 'Aluno');
      const detail = [roleLabel, member.document || member.phone].filter(Boolean).join(' · ');
      actions.push({
        label: `${member.name} (#${member.id})`,
        meta: detail,
        run: () => openProfile(member.id),
      });
    }
  }

  const pages = Array.from(document.querySelectorAll('#workspaceMenu .tab')).filter(
    (button) => !button.classList.contains('hidden') && normalizeSearch(button.textContent).includes(normalizeSearch(query)),
  );
  for (const page of pages) {
    actions.push({
      label: page.textContent.trim(),
      meta: 'Página',
      run: () => switchTab(page.dataset.tab),
    });
  }

  if (query) {
    actions.push({
      label: `Ver todos na lista de alunos: “${query}”`,
      meta: 'Filtro',
      run: () => {
        document.getElementById('quickSearch').value = query;
        document.getElementById('quickSearchForm').requestSubmit();
      },
    });
  }

  commandResults.replaceChildren(...actions.map(({ label, meta, run }) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.style.display = 'flex';
    button.style.justifyContent = 'space-between';
    button.style.alignItems = 'center';
    button.style.gap = '12px';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = label;
    button.append(titleSpan);

    if (meta) {
      const metaSpan = document.createElement('span');
      metaSpan.className = 'muted';
      metaSpan.style.fontSize = '12px';
      metaSpan.style.flexShrink = '0';
      metaSpan.textContent = meta;
      button.append(metaSpan);
    }

    button.addEventListener('click', () => {
      commandDialog.close();
      run();
    });
    row.append(button);
    return row;
  }));
}
function openWorkspaceCommands() {
  if (commandDialog.open || document.querySelector('dialog[open], .login-overlay:not(.hidden), .modal:not(.hidden)')) return;
  commandField.value = '';
  renderWorkspaceCommands();
  commandDialog.showModal();
  if (!state.memberSearchIndex.length && typeof loadMembers === 'function') {
    loadOnce(loadMembers)
      .then(() => {
        if (commandDialog.open) renderWorkspaceCommands();
      })
      .catch(() => {});
  }
}
document.getElementById('workspaceCommandOpen').addEventListener('click', openWorkspaceCommands);
commandField.addEventListener('input', renderWorkspaceCommands);
document.getElementById('workspaceCommandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  commandResults.querySelector('button')?.click();
});
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
  if (commandDialog.open) {
    event.preventDefault();
    commandDialog.close();
  } else {
    openWorkspaceCommands();
    if (commandDialog.open) event.preventDefault();
  }
});

function setMemberFormOpen(open) {
  const panel = document.getElementById('newMemberPanel');
  panel.classList.toggle('hidden', !open);
  const button = document.getElementById('btnNewMember');
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Fechar cadastro' : 'Novo aluno';
  if (open) {
    resetMemberWizard();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

document.getElementById('btnNewMember').addEventListener('click', async (event) => {
  const open = event.currentTarget.getAttribute('aria-expanded') === 'false';
  setMemberFormOpen(open);
  if (open && await loadTab('members') && state.activeTab === 'members') document.getElementById('mName').focus();
});

document.querySelectorAll('[data-go]').forEach((button) => {
  button.addEventListener('click', async () => {
    const { go, focus, expand } = button.dataset;
    if (expand) document.getElementById(expand).open = true;
    if (focus === 'mName') setMemberFormOpen(true);
    if (await switchTab(go) && state.activeTab === go && focus) document.getElementById(focus).focus();
  });
});

document.getElementById('quickSearchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const rawQuery = document.getElementById('quickSearch').value.trim();
  const search = document.getElementById('memberSearch');
  state.memberFilter = 'all';
  state.memberLimit = 50;
  search.value = rawQuery;
  setMemberFormOpen(false);
  await switchTab('members');
  if (sharedLoads.has(loadMembers)) {
    await sharedLoads.get(loadMembers).catch(() => {});
  } else if (!state.memberSearchIndex.length) {
    await loadMembers().catch(() => {});
  }
  updateMemberFilterChips();
  renderMembersTable();

  const q = normalizeSearch(rawQuery);
  const digits = numericSearch(q);
  if (q) {
    const exactMatches = state.memberSearchIndex.filter(
      (entry) => (digits && entry.documentDigits === digits) || entry.name === q,
    );
    if (exactMatches.length === 1) {
      openProfile(exactMatches[0].member.id);
      return;
    }
  }
  search.focus();
});

// --- Dashboard ---
function updateSidebarLiveOccupancy(occupancy, lastLog = null) {
  const titleEl = document.getElementById('sidebarLiveTitle');
  if (titleEl && occupancy) {
    titleEl.textContent = occupancy.maxCapacity > 0
      ? `Na academia: ${occupancy.count} / ${occupancy.maxCapacity}`
      : `Na academia: ${occupancy.count} aluno(s)`;
  }
  const subEl = document.getElementById('sidebarLiveSubtitle');
  if (subEl && lastLog) {
    const shortName = String(lastLog.member_name || 'Recepção').trim().split(/\s+/).slice(0, 2).join(' ');
    const timePart = String(lastLog.occurred_at || '').match(/(\d{2}:\d{2})/)?.[1] || '';
    subEl.textContent = timePart ? `Último: ${shortName} · ${timePart}` : `Último: ${shortName}`;
  }
}

document.getElementById('sidebarLiveWidget')?.addEventListener('click', () => {
  switchTab('logs');
});

async function loadDashboard() {
  const [data, occupancy] = await Promise.all([
    api('/api/dashboard'),
    api('/api/occupancy').catch(() => null),
  ]);
  updateSidebarLiveOccupancy(occupancy, data.recentLogs?.[0] || null);
  const occEl = document.getElementById('statOccupancy');
  if (occEl) {
    occEl.textContent = occupancy
      ? (occupancy.maxCapacity > 0 ? `${occupancy.count} / ${occupancy.maxCapacity}` : `${occupancy.count} aluno(s)`)
      : '—';
  }
  document.getElementById('statActive').textContent = data.activeMembers;
  document.getElementById('statBlocked').textContent = data.blockedMembers + data.pendingMembers;
  document.getElementById('statToday').textContent = fmtMoney(data.revenueTodayCents + (data.salesTodayCents ?? 0));
  document.getElementById('statMonth').textContent = fmtMoney(data.revenueMonthCents + (data.salesMonthCents ?? 0));
  for (const [id, value] of Object.entries({
    statExpired: data.expiredEnrollments,
    statOverdue: data.overdueCharges,
    statLowStock: data.lowStock,
    statTeam: data.teamMembers,
    statClasses: data.classes,
    statAccess: data.allowedToday == null ? null : `${data.allowedToday} autorizados · ${data.deniedToday} negados`,
    statFitnessNear: data.fitness?.nearGoal.map(({ name }) => name).join(', ') || '—',
    statFitnessReturn: data.fitness?.returning.map(({ name }) => name).join(', ') || '—',
  })) {
    document.getElementById(id).textContent = value ?? '—';
  }

  const tbody = document.getElementById('dashLogsBody');
  tbody.innerHTML = data.recentLogs.length
    ? data.recentLogs
        .map(
          (l) => {
            const event = Number(l.event_code);
            const tone = [7, 11, 12].includes(event) ? 'badge-active' : [3, 6].includes(event) ? 'badge-blocked' : 'badge-neutral';
            return `<tr><td><strong>${escapeHtml(l.member_name || '—')}</strong></td><td><span class="badge ${tone}">${escapeHtml(l.event_label)}</span></td><td>${escapeHtml(fmtDateTime(l.occurred_at))}</td></tr>`;
          },
        )
        .join('')
    : '<tr><td colspan="3" class="empty-cell">Nenhuma passagem registrada.</td></tr>';
}

document.getElementById('btnRefreshDashboard').addEventListener('click', (event) => withLoading(event.currentTarget, async () => {
  try {
    await Promise.all([loadDashboard(), loadCurrentCash()]);
    showToast('Resumo atualizado.');
  } catch (err) {
    showToast(err.message, true);
  }
}));

// --- Planos & Formas de Pagamento ---
async function loadPlans() {
  state.plans = await api('/api/plans');
  const options = state.plans
    .map(
      (p) =>
        `<option value="${p.id}">${escapeHtml(p.name)} (${fmtMoney(p.price_cents)} / ${p.duration_days}d)</option>`,
    )
    .join('');
  document.getElementById('mPlan').innerHTML = `<option value="">Sem plano</option>${options}`;
  const profPlanEl = document.getElementById('profPlan');
  if (profPlanEl) profPlanEl.innerHTML = `<option value="">Sem plano</option>${options}`;
  document.getElementById('plansList').innerHTML = state.plans.map((p) => {
    const extras = [
      p.allowed_start_time && p.allowed_end_time ? `${p.allowed_start_time}–${p.allowed_end_time}` : '',
      p.weekly_limit ? `${p.weekly_limit}x/sem` : '',
    ].filter(Boolean).join(' · ');
    return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
      <span>${escapeHtml(p.name)} · ${p.duration_days} dias · ${fmtMoney(p.price_cents)}${extras ? ` <span class="muted">(${escapeHtml(extras)})</span>` : ''}</span>
      <span style="display:inline-flex;gap:6px;">
        <button type="button" class="btn btn-secondary btn-sm" data-edit-plan="${p.id}">Editar</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-plan="${p.id}">Excluir</button>
      </span>
    </li>`;
  }).join('');
  const currentPlanValue = document.getElementById('pPlan').value;
  document.getElementById('pPlan').innerHTML = `<option value="">Selecione um plano...</option>${options}`;
  const activeMemberId = Number(document.getElementById('pMember')?.value);
  const activeMember = activeMemberId ? state.allMembers.find((entry) => entry.id === activeMemberId) : null;
  if (activeMember) {
    selectMemberPlan(activeMember);
  } else {
    if (currentPlanValue) document.getElementById('pPlan').value = currentPlanValue;
    updatePaymentAmountFromPlan();
  }
  renderMemberPlanPicker();
  renderBillingPlanPicker();
}

function updatePaymentAmountFromPlan() {
  const planId = Number(document.getElementById('pPlan').value);
  const plan = state.plans.find((p) => p.id === planId);
  document.getElementById('pAmount').value = plan ? (plan.price_cents / 100).toFixed(2) : '';
  renderBillingSummary();
}

function resolveMemberPlanId(member) {
  if (!member) return '';
  if (member.plan_id && state.plans.some((p) => Number(p.id) === Number(member.plan_id))) {
    return String(member.plan_id);
  }
  if (member.plan_name) {
    const normalized = String(member.plan_name).trim().toLowerCase();
    const byName = state.plans.find((p) => String(p.name || '').trim().toLowerCase() === normalized);
    if (byName) return String(byName.id);
  }
  return '';
}

function selectMemberPlan(member) {
  const select = document.getElementById('pPlan');
  const optionsPanel = document.getElementById('paymentOptions');
  select.value = resolveMemberPlanId(member);
  if (optionsPanel) {
    optionsPanel.open = true;
    optionsPanel.hidden = false;
  }
  updatePaymentAmountFromPlan();
}

document.getElementById('pPlan').addEventListener('change', updatePaymentAmountFromPlan);

function methodName(code) {
  const found = state.paymentMethods.find((pm) => pm.code === code);
  return found ? found.name : String(code || '-').toUpperCase();
}

function billingMethodCardMeta(pm) {
  const code = String(pm?.code || '').trim().toLowerCase();
  const name = String(pm?.name || '').trim().toLowerCase();
  if (code === 'pix' || name === 'pix') {
    return { icon: '💠', title: 'Pix', hint: 'Transferência / QR Code' };
  }
  if (code === 'cash' || code === 'dinheiro' || name === 'dinheiro' || name === 'cash') {
    return { icon: '💵', title: 'Dinheiro', hint: 'Pagamento em espécie no caixa' };
  }
  if (code === 'credit' || code === 'credito' || name.includes('crédito') || name.includes('credito')) {
    return { icon: '💳', title: 'Cartão de Crédito', hint: 'Passar cartão no crédito' };
  }
  if (code === 'debit' || code === 'debito' || name.includes('débito') || name.includes('debito')) {
    return { icon: '🏧', title: 'Cartão de Débito', hint: 'Passar cartão à vista na maquininha' };
  }
  return { icon: '🧾', title: pm?.name || code.toUpperCase() || 'Outro', hint: 'Forma cadastrada' };
}

function syncBillingMethodCardsActive() {
  const cardsContainer = document.getElementById('pMethodCards');
  const methodSelect = document.getElementById('pMethod');
  if (!cardsContainer || !methodSelect) return;
  const activeCode = methodSelect.value;
  cardsContainer.querySelectorAll('.billing-method-card').forEach((card) => {
    const isActive = card.dataset.methodCode === activeCode;
    card.classList.toggle('active', isActive);
    card.setAttribute('aria-checked', String(isActive));
  });
}

function renderBillingMethodCards() {
  const cardsContainer = document.getElementById('pMethodCards');
  const methodSelect = document.getElementById('pMethod');
  if (!cardsContainer) return;
  const activeMethods = (state.paymentMethods || []).filter((pm) => pm.active);
  const items = activeMethods.length
    ? activeMethods
    : methodSelect
      ? [...methodSelect.options].map((opt) => ({ code: opt.value, name: opt.textContent, active: true }))
      : [];
  const currentCode = methodSelect?.value || items[0]?.code || '';
  cardsContainer.innerHTML = items
    .map((pm) => {
      const meta = billingMethodCardMeta(pm);
      const isActive = pm.code === currentCode;
      return `<button type="button" class="billing-method-card${isActive ? ' active' : ''}" data-method-code="${escapeHtml(pm.code)}" role="radio" aria-checked="${isActive ? 'true' : 'false'}">
        <span class="billing-method-icon" aria-hidden="true">${meta.icon}</span>
        <span class="billing-method-body">
          <span class="billing-method-name">${escapeHtml(meta.title)}</span>
          <span class="billing-method-hint">${escapeHtml(meta.hint)}</span>
        </span>
      </button>`;
    })
    .join('');
}

async function loadPaymentMethods() {
  state.paymentMethods = await api('/api/payment-methods');
  const activeOpts = state.paymentMethods
    .filter((pm) => pm.active)
    .map((pm) => `<option value="${escapeHtml(pm.code)}">${escapeHtml(pm.name)}</option>`)
    .join('');

  document.getElementById('pMethod').innerHTML = activeOpts;
  document.getElementById('saleMethod').innerHTML = activeOpts;
  const debtMethodEl = document.getElementById('debtPayMethod');
  if (debtMethodEl) debtMethodEl.innerHTML = activeOpts;

  renderBillingMethodCards();
  renderBillingSummary();

  document.getElementById('pmBody').innerHTML = state.paymentMethods
    .map(
      (pm) => `
      <tr>
        <td>${escapeHtml(pm.name)}</td>
        <td><code>${escapeHtml(pm.code)}</code></td>
        <td><span class="badge ${pm.active ? 'badge-active' : 'badge-blocked'}">${pm.active ? 'Ativo' : 'Inativo'}</span></td>
        <td><button type="button" class="btn btn-secondary btn-sm" data-toggle-pm="${pm.id}">${pm.active ? 'Desativar' : 'Ativar'}</button></td>
      </tr>`,
    )
    .join('');
}

document.getElementById('pMethodCards')?.addEventListener('click', (e) => {
  const card = e.target.closest('.billing-method-card[data-method-code]');
  if (!card) return;
  const code = card.dataset.methodCode;
  const methodSelect = document.getElementById('pMethod');
  if (methodSelect) {
    methodSelect.value = code;
  }
  syncBillingMethodCardsActive();
  renderBillingSummary();
});

document.getElementById('pMethod')?.addEventListener('change', () => {
  syncBillingMethodCardsActive();
  renderBillingSummary();
});

document.getElementById('pmBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-toggle-pm]');
  if (!btn) return;
  try {
    await api(`/api/payment-methods/${btn.dataset.togglePm}/toggle`, { method: 'PATCH' });
    await loadPaymentMethods();
    showToast('Forma de pagamento atualizada.');
  } catch (err) {
    showToast(err.message, true);
  }
});

// --- Modalidades, Professores & Turmas ---
async function loadGymStructure() {
  const [modalities, instructors, classes] = await Promise.all([
    api('/api/modalities'),
    api('/api/instructors'),
    api('/api/classes'),
  ]);
  state.modalities = modalities;
  state.instructors = instructors;
  state.classes = classes;
  renderTeamDirectory();

  const profileModality = document.getElementById('profModality');
  const selectedModality = profileModality.value;
  const modOpts = modalities.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  const memberModality = document.getElementById('mModality');
  const selectedMemberModality = memberModality.value;
  memberModality.innerHTML = `<option value="">Sem matrícula</option>${modOpts}`;
  memberModality.value = selectedMemberModality;
  profileModality.innerHTML = `<option value="">Nenhuma</option>${modOpts}`;
  profileModality.value = selectedModality;
  document.getElementById('clsModality').innerHTML = `<option value="">Modalidade...</option>${modOpts}`;

  const instOpts = instructors.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
  document.getElementById('clsInstructor').innerHTML = `<option value="">Professor...</option>${instOpts}`;

  document.getElementById('instructorsBody').innerHTML = instructors.length
    ? instructors.map((i) => `<tr><td>#${i.id}</td><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.specialty || '—')}</td><td>${escapeHtml(i.phone || '—')}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty-cell">Nenhum professor cadastrado.</td></tr>';

  document.getElementById('modalitiesList').innerHTML = modalities.length
    ? modalities
        .map(
          (m) => `<li class="enrollment-row">
            <div>
              <strong>${escapeHtml(m.name)}</strong>
              ${m.description ? `<div class="muted">${escapeHtml(m.description)}</div>` : ''}
            </div>
            <div class="inline-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-edit-modality="${m.id}" aria-label="Editar modalidade ${escapeHtml(m.name)}">Editar</button>
              <button type="button" class="btn btn-danger btn-sm" data-delete-modality="${m.id}" aria-label="Apagar modalidade ${escapeHtml(m.name)}">Apagar</button>
            </div>
          </li>`,
        )
        .join('')
    : '<li class="muted">Nenhuma modalidade cadastrada.</li>';
  for (const [modality, select] of [['mModality', 'mClass'], ['profModality', 'profClassSelect']]) {
    renderClassOptions(modality, select, document.getElementById(select).value);
  }

  document.getElementById('classesBody').innerHTML = classes.length
    ? classes
        .map(
          (c) => `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(c.modality_name || '-')}</td>
          <td>${escapeHtml(c.instructor_name || '-')}</td>
          <td>${escapeHtml(c.schedule)}</td>
          <td>${c.enrolled_count} / ${c.capacity}</td>
        </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">Nenhuma turma cadastrada.</td></tr>';

  renderMemberModalityPills();
  renderMemberPlanPicker();
  renderBillingModalityPills();
  renderBillingPlanPicker();
  renderComboModalityChips();

  const cbClassSel = document.getElementById('cbClassSelect');
  if (cbClassSel) {
    const prevVal = cbClassSel.value;
    cbClassSel.innerHTML = classes.length
      ? classes.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.schedule)})</option>`).join('')
      : '<option value="">Nenhuma turma</option>';
    if (prevVal && classes.some((c) => String(c.id) === String(prevVal))) {
      cbClassSel.value = prevVal;
    }
    const cbDateEl = document.getElementById('cbDate');
    if (cbDateEl && !cbDateEl.value) {
      cbDateEl.value = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    }
    if (typeof loadClassBookings === 'function') loadClassBookings().catch(() => {});
  }
}

function renderClassOptions(modalityField, classField, selected = '') {
  const modality = Number(document.getElementById(modalityField).value);
  const select = document.getElementById(classField);
  const classes = state.classes.filter((cls) => cls.modality_id === modality);
  const placeholder = !modality ? 'Escolha a modalidade' : classes.length ? 'Sem turma' : 'Nenhuma turma cadastrada';
  select.innerHTML = `<option value="">${placeholder}</option>` + classes.map((cls) => {
    const full = cls.enrolled_count >= cls.capacity && String(cls.id) !== String(selected);
    return `<option value="${cls.id}" ${full ? 'disabled' : ''}>${escapeHtml(cls.name)} · ${escapeHtml(cls.schedule)}${full ? ' (lotada)' : ''}</option>`;
  }).join('');
  select.disabled = classes.length === 0;
  select.value = selected;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

document.getElementById('mModality').addEventListener('change', (e) => {
  renderClassOptions('mModality', 'mClass');
  const mod = state.modalities.find((m) => String(m.id) === String(e.target.value));
  state.memberPickerModality = mod ? mod.name : '';
  renderMemberModalityPills();
  renderMemberPlanPicker();
  updateMemberWizardSummaries();
});
document.getElementById('mPlan').addEventListener('change', () => renderMemberPlanPicker());
document.getElementById('profModality').addEventListener('change', () => renderClassOptions('profModality', 'profClassSelect'));

function modalityIcon(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('muscula')) return '💪';
  if (n.includes('jiu')) return '🥋';
  if (n.includes('muay')) return '🥊';
  if (n.includes('hidro') || n.includes('nata')) return '🏊';
  if (n.includes('pilates')) return '🧘';
  if (n.includes('funcional')) return '🏋️';
  if (n.includes('fit') || n.includes('dan')) return '💃';
  return '⭐';
}

function periodLabelFromPlan(plan) {
  const m = String(plan.name || '').match(/\(([^)]+)\)\s*$/);
  if (m) return m[1];
  const d = Number(plan.duration_days);
  if (d <= 1) return 'Diária';
  if (d >= 360) return 'Anual';
  if (d >= 85) return 'Trimestral';
  if (d >= 55) return 'Bimestral';
  return 'Mensal';
}

function parsePlanGroup(plan) {
  const raw = String(plan.name || '').trim();
  const baseName = raw.replace(/\s*\((Mensal|Bimestral|Trimestral|Anual|Semestral|Diária)\)\s*$/i, '').trim() || raw;
  const periodLabel = periodLabelFromPlan(plan);
  const modNames = baseName
    .split('+')
    .map((part) => part.replace(/\s+Completo$/i, '').trim())
    .filter(Boolean);
  return { baseName, periodLabel, modNames };
}

function renderMemberModalityPills() {
  const container = document.getElementById('memberModalityPills');
  if (!container) return;
  const activeMod = state.memberPickerModality || '';
  container.innerHTML = state.modalities
    .map((m) => {
      const isActive = activeMod.toLowerCase() === m.name.toLowerCase();
      return `
        <button type="button" class="modality-pill ${isActive ? 'active' : ''}" data-mod-id="${m.id}" data-mod-name="${escapeHtml(m.name)}">
          <span class="modality-pill-icon" aria-hidden="true">${modalityIcon(m.name)}</span>
          <span>${escapeHtml(m.name)}</span>
        </button>`;
    })
    .join('');
}

function renderMemberPlanPicker() {
  const container = document.getElementById('memberPlanCards');
  if (!container) return;
  const selectedPlanId = Number(document.getElementById('mPlan').value) || 0;
  const filterMod = (state.memberPickerModality || '').toLowerCase();

  const groups = new Map();
  for (const plan of state.plans) {
    const info = parsePlanGroup(plan);
    if (filterMod && !info.modNames.some((n) => n.toLowerCase().includes(filterMod) || filterMod.includes(n.toLowerCase()))) {
      continue;
    }
    if (!groups.has(info.baseName)) {
      groups.set(info.baseName, { baseName: info.baseName, modNames: info.modNames, variants: [] });
    }
    groups.get(info.baseName).variants.push({ ...plan, periodLabel: info.periodLabel });
  }

  const customCard = `
    <button type="button" class="plan-card plan-card--custom" data-custom-plan="1">
      <div class="plan-card-head">
        <div class="plan-card-title">Plano personalizado</div>
        <span class="plan-card-period-pill">Novo plano ou combo</span>
      </div>
      <div class="plan-card-body">
        <p class="muted" style="margin:0;font-size:12px;">Criar um novo plano ou combo (ex: Jiu-Jitsu + Musculação) nas configurações.</p>
      </div>
    </button>`;

  const cardsHtml = [...groups.values()]
    .map((g) => {
      const variants = [...g.variants].sort((a, b) => a.duration_days - b.duration_days);
      const activeVariant = variants.find((v) => v.id === selectedPlanId) || variants[0];
      const isSelected = variants.some((v) => v.id === selectedPlanId);
      const periodsList = [...new Set(variants.map((v) => v.periodLabel))].join(', ');
      const minPrice = Math.min(...variants.map((v) => v.price_cents));

      const modBadges = g.modNames
        .map((mn) => `<span class="plan-card-mod-badge">${modalityIcon(mn)} ${escapeHtml(mn)}</span>`)
        .join('');

      const periodButtons =
        variants.length > 1
          ? `<div class="plan-card-periods">${variants
              .map(
                (v) =>
                  `<button type="button" class="plan-period-btn ${v.id === activeVariant.id && isSelected ? 'active' : ''}" data-plan-id="${v.id}">${escapeHtml(v.periodLabel)} · ${fmtMoney(v.price_cents)}</button>`,
              )
              .join('')}</div>`
          : '';

      return `
        <div class="plan-card ${isSelected ? 'selected' : ''}">
          <button type="button" class="plan-card-head" data-plan-id="${activeVariant.id}">
            <div class="plan-card-title">${escapeHtml(g.baseName)}</div>
            <div class="plan-card-from">a partir de</div>
            <div class="plan-card-price">${fmtMoney(isSelected ? activeVariant.price_cents : minPrice)}</div>
            <span class="plan-card-period-pill">${escapeHtml(periodsList)}</span>
          </button>
          <div class="plan-card-body">
            <div>
              <div class="plan-card-section-label">Modalidades</div>
              <div class="plan-card-mods">${modBadges}</div>
            </div>
            ${periodButtons}
          </div>
        </div>`;
    })
    .join('');

  container.innerHTML = customCard + cardsHtml;
}

document.getElementById('memberModalityPills')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.modality-pill');
  if (!pill) return;
  const modId = pill.dataset.modId;
  const modName = pill.dataset.modName;
  const mModSelect = document.getElementById('mModality');
  if (state.memberPickerModality === modName) {
    state.memberPickerModality = '';
    mModSelect.value = '';
  } else {
    state.memberPickerModality = modName;
    mModSelect.value = modId;
  }
  renderClassOptions('mModality', 'mClass');
  renderMemberModalityPills();
  renderMemberPlanPicker();
  updateMemberWizardSummaries();
});

function renderBillingModalityPills() {
  const container = document.getElementById('billingModalityPills');
  if (!container) return;
  const activeMod = state.billingPickerModality || '';
  container.innerHTML = state.modalities
    .map((m) => {
      const isActive = activeMod.toLowerCase() === m.name.toLowerCase();
      return `
        <button type="button" class="modality-pill ${isActive ? 'active' : ''}" data-mod-name="${escapeHtml(m.name)}">
          <span class="modality-pill-icon" aria-hidden="true">${modalityIcon(m.name)}</span>
          <span>${escapeHtml(m.name)}</span>
        </button>`;
    })
    .join('');
}

function renderBillingPlanPicker() {
  const container = document.getElementById('billingPlanCards');
  const select = document.getElementById('pPlan');
  if (!container || !select) return;
  const locked = Boolean(select.disabled);
  const selectedPlanId = Number(select.value) || 0;
  const filterMod = (state.billingPickerModality || '').toLowerCase();

  const groups = new Map();
  for (const plan of state.plans) {
    const info = parsePlanGroup(plan);
    if (filterMod && !info.modNames.some((n) => n.toLowerCase().includes(filterMod) || filterMod.includes(n.toLowerCase()))) {
      continue;
    }
    if (!groups.has(info.baseName)) {
      groups.set(info.baseName, { baseName: info.baseName, modNames: info.modNames, variants: [] });
    }
    groups.get(info.baseName).variants.push({ ...plan, periodLabel: info.periodLabel });
  }

  container.classList.toggle('is-locked', locked);
  container.innerHTML = [...groups.values()]
    .map((g) => {
      const variants = [...g.variants].sort((a, b) => a.duration_days - b.duration_days);
      const activeVariant = variants.find((v) => v.id === selectedPlanId) || variants[0];
      const isSelected = variants.some((v) => v.id === selectedPlanId);
      const periodsList = [...new Set(variants.map((v) => v.periodLabel))].join(', ');
      const minPrice = Math.min(...variants.map((v) => v.price_cents));
      const modBadges = g.modNames
        .map((mn) => `<span class="plan-card-mod-badge">${modalityIcon(mn)} ${escapeHtml(mn)}</span>`)
        .join('');
      const periodButtons =
        variants.length > 1
          ? `<div class="plan-card-periods">${variants
              .map(
                (v) =>
                  `<button type="button" class="plan-period-btn ${v.id === activeVariant.id && isSelected ? 'active' : ''}" data-billing-plan-id="${v.id}" ${locked ? 'disabled' : ''}>${escapeHtml(v.periodLabel)} · ${fmtMoney(v.price_cents)}</button>`,
              )
              .join('')}</div>`
          : '';
      return `
        <div class="plan-card ${isSelected ? 'selected' : ''}">
          <button type="button" class="plan-card-head" data-billing-plan-id="${activeVariant.id}" ${locked ? 'disabled' : ''}>
            <div class="plan-card-title">${escapeHtml(g.baseName)}</div>
            <div class="plan-card-from">${isSelected ? escapeHtml(activeVariant.periodLabel) : 'a partir de'}</div>
            <div class="plan-card-price">${fmtMoney(isSelected ? activeVariant.price_cents : minPrice)}</div>
            <span class="plan-card-period-pill">${escapeHtml(periodsList)}</span>
          </button>
          <div class="plan-card-body">
            <div class="plan-card-mods">${modBadges}</div>
            ${periodButtons}
          </div>
        </div>`;
    })
    .join('');
}

document.getElementById('billingModalityPills')?.addEventListener('click', (e) => {
  const pill = e.target.closest('.modality-pill');
  if (!pill) return;
  const modName = pill.dataset.modName || '';
  state.billingPickerModality = state.billingPickerModality === modName ? '' : modName;
  renderBillingModalityPills();
  renderBillingPlanPicker();
});

document.getElementById('billingPlanCards')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-billing-plan-id]');
  if (!btn || btn.disabled) return;
  const select = document.getElementById('pPlan');
  if (!select || select.disabled) return;
  select.value = String(btn.dataset.billingPlanId);
  updatePaymentAmountFromPlan();
});

document.getElementById('memberPlanCards')?.addEventListener('click', (e) => {
  const customBtn = e.target.closest('button[data-custom-plan]');
  if (customBtn) {
    switchTab('settings');
    activateSettingsCategory('structure');
    document.getElementById('plName')?.focus();
    return;
  }
  const trigger = e.target.closest('.plan-period-btn[data-plan-id], .plan-card-head[data-plan-id]');
  const planId = trigger?.dataset.planId;
  if (!planId) return;
  const mPlan = document.getElementById('mPlan');
  mPlan.value = planId;

  const plan = state.plans.find((p) => String(p.id) === String(planId));
  if (plan && !document.getElementById('mModality').value) {
    const info = parsePlanGroup(plan);
    const firstMod = state.modalities.find((m) =>
      info.modNames.some((n) => m.name.toLowerCase() === n.toLowerCase()),
    );
    if (firstMod) {
      document.getElementById('mModality').value = String(firstMod.id);
      state.memberPickerModality = firstMod.name;
      renderClassOptions('mModality', 'mClass');
      renderMemberModalityPills();
    }
  }
  renderMemberPlanPicker();
  updateMemberWizardSummaries();
});

function renderComboModalityChips() {
  const container = document.getElementById('plComboModalities');
  if (!container) return;
  container.innerHTML = state.modalities
    .map((m) => `<button type="button" class="chip" data-combo-mod="${escapeHtml(m.name)}">${modalityIcon(m.name)} ${escapeHtml(m.name)}</button>`)
    .join('');
}

function updatePlanNameFromCombo() {
  const container = document.getElementById('plComboModalities');
  if (!container) return;
  const selectedMods = [...container.querySelectorAll('.chip.active')].map((el) => el.dataset.comboMod);
  if (!selectedMods.length) return;
  const periodSel = document.getElementById('plPeriod');
  const periodLabel = periodSel?.selectedOptions?.[0]?.dataset?.label || '';
  const suffix = periodLabel ? ` (${periodLabel})` : '';
  document.getElementById('plName').value = `${selectedMods.join(' + ')}${suffix}`;
}

document.getElementById('plPeriod')?.addEventListener('change', (e) => {
  const days = e.target.value;
  if (days) document.getElementById('plDays').value = days;
  updatePlanNameFromCombo();
});

document.getElementById('plComboModalities')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-combo-mod]');
  if (!chip) return;
  chip.classList.toggle('active');
  updatePlanNameFromCombo();
});

function openEnrollmentForm(enrollment) {
  const form = document.getElementById('enrollmentForm');
  form.dataset.previous = enrollment?.id || '';
  document.getElementById('profModality').value = enrollment?.id || '';
  renderClassOptions('profModality', 'profClassSelect', enrollment?.classes[0]?.id || '');
  document.getElementById('enrollmentHint').textContent = enrollment?.classes.length > 1
    ? 'Ao salvar, somente a turma escolhida ficará vinculada a esta modalidade.'
    : '';
  form.classList.remove('hidden');
  document.getElementById('profModality').focus();
}

document.getElementById('btnNewEnrollment').addEventListener('click', () => openEnrollmentForm());
document.getElementById('btnCancelEnrollment').addEventListener('click', () => {
  document.getElementById('enrollmentForm').classList.add('hidden');
  document.getElementById('btnNewEnrollment').focus();
});

// --- Alunos & Perfil ---
function memberLabel(m) {
  return `${m.name} — ${m.document || 'Cadastro'} (#${m.id})`;
}

function normalizeSearch(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function numericSearch(value) {
  return /^[\d\s()+.-]+$/.test(value) ? value.replace(/\D/g, '') : '';
}

function matchMemberSearch(entry, query, digits) {
  return entry.name.includes(query) || entry.document.includes(query) || entry.phone.includes(query) ||
    Boolean(digits && (entry.documentDigits.includes(digits) || entry.phoneDigits.includes(digits)));
}

function populateMemberDatalist(text) {
  const query = normalizeSearch(text);
  const digits = numericSearch(query);
  const suggestions = [];
  if (query.length >= 2) {
    for (const entry of state.memberSearchIndex) {
      if (!matchMemberSearch(entry, query, digits)) continue;
      suggestions.push(`<option value="${escapeHtml(memberLabel(entry.member))}"></option>`);
      if (suggestions.length === 30) break;
    }
  }
  document.getElementById('membersDatalist').innerHTML = suggestions.join('');
}

function resolveMemberFromInput(text) {
  const q = normalizeSearch(text);
  if (!q) return null;
  const id = q.match(/\(#(\d+)\)$/)?.[1];
  if (id) {
    return state.allMembers.find((m) => m.id === Number(id) && normalizeSearch(memberLabel(m)) === q) || null;
  }
  const digits = numericSearch(q);
  const matches = state.memberSearchIndex.filter((entry) =>
    entry.name === q || entry.document === q || (digits && entry.documentDigits === digits),
  );
  return matches.length === 1 ? matches[0].member : null;
}

async function jumpToPaymentForMember(member) {
  if (!member) return;
  closeProfileModal(false);
  if (!await switchTab('billing') || state.activeTab !== 'billing') return;
  selectBillingMember(member);
  document.getElementById('paymentForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const billingDateFormat = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

function memberInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'AL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function addDaysIso(isoDate, days) {
  const [y, m, d] = String(isoDate || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d + Number(days || 0));
  return billingDateFormat.format(dt);
}

function selectBillingMember(member) {
  if (member.access_role && member.access_role !== 'student') {
    showToast('A equipe tem acesso permanente sem mensalidade.');
    return;
  }
  state.billingChangePlanOpen = false;
  state.billingFinalAmountEdited = false;
  document.getElementById('pMemberSearch').value = memberLabel(member);
  document.getElementById('pMember').value = String(member.id);
  document.getElementById('whatsappCheckoutBox').classList.add('hidden');
  document.getElementById('pixChargeBox')?.classList.add('hidden');
  const optionsPanel = document.getElementById('paymentOptions');
  if (optionsPanel) {
    optionsPanel.open = true;
    optionsPanel.hidden = false;
  }
  selectMemberPlan(member);
  if (!member.plan_id && member.modality_name) {
    state.billingPickerModality = member.modality_name;
    renderBillingModalityPills();
    renderBillingPlanPicker();
  }
  const firstCard = document.querySelector('#pMethodCards .billing-method-card.active, #pMethodCards .billing-method-card');
  if (firstCard) firstCard.focus();
  else document.getElementById('pMethod').focus();
}

function renderBillingQueue(showAll = false) {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today = billingDateFormat.format(todayMidnight);
  const minDate = billingDateFormat.format(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3));
  const maxDate = billingDateFormat.format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3));

  const nearbyDue = state.allMembers
    .filter((member) => !member.access_role || member.access_role === 'student')
    .map((member) => ({
      member,
      due: member.next_charge?.due || member.valid_until,
      isPendingFirst: !member.next_charge?.due && !member.valid_until && member.status === 'pending' && Boolean(member.modality_id || member.plan_id),
    }))
    .filter(({ due, isPendingFirst }) => isPendingFirst || (due && due >= minDate && due <= maxDate))
    .sort((a, b) => {
      if (a.isPendingFirst !== b.isPendingFirst) return a.isPendingFirst ? -1 : 1;
      return String(a.due || '').localeCompare(String(b.due || '')) || a.member.id - b.member.id;
    });

  const dueTag = (due, isPendingFirst) => {
    if (isPendingFirst || !due) return '<span class="billing-due-tag upcoming">Aguardando 1º pag.</span>';
    if (due === today) return '<span class="billing-due-tag today">Vence hoje</span>';
    const [y, m, d] = due.split('-').map(Number);
    const diffDays = Math.round((new Date(y, m - 1, d) - todayMidnight) / 86400000);
    if (diffDays < 0) return `<span class="billing-due-tag overdue">Venceu há ${Math.abs(diffDays)}d</span>`;
    return `<span class="billing-due-tag upcoming">Vence em ${diffDays}d</span>`;
  };

  const BILLING_QUEUE_LIMIT = 80;
  const visible = showAll ? nearbyDue : nearbyDue.slice(0, BILLING_QUEUE_LIMIT);
  const rowsHtml = visible.map(({ member, due, isPendingFirst }) => {
    const memberPlan = state.plans.find((p) => Number(p.id) === Number(member.plan_id));
    const planLabel = member.plan_name || memberPlan?.name || member.modality_name || 'Sem plano';
    const amountLabel = member.next_charge?.amount
      ? fmtMoney(member.next_charge.amount)
      : memberPlan
        ? fmtMoney(memberPlan.price_cents)
        : '';
    const dateLabel = due ? fmtDate(due) : '1º pagamento';
    return `<button type="button" class="billing-member" data-id="${member.id}">
      <div class="billing-member-main">
        <strong>${escapeHtml(member.name)} ${dueTag(due, isPendingFirst)}</strong>
        <span class="billing-member-meta">#${member.id} · ${escapeHtml(dateLabel)} · ${escapeHtml(planLabel)}</span>
      </div>
      <div class="billing-member-cta">
        ${amountLabel ? `<strong class="billing-member-price">${escapeHtml(amountLabel)}</strong>` : ''}
        <span class="btn btn-secondary btn-sm">Carregar</span>
      </div>
    </button>`;
  }).join('');

  const showAllBtn = !showAll && nearbyDue.length > BILLING_QUEUE_LIMIT
    ? `<button type="button" class="btn btn-secondary btn-sm billing-queue-more" data-billing-show-all="1">Mostrar todos (${nearbyDue.length})</button>`
    : '';

  document.getElementById('billingQueue').innerHTML = (rowsHtml + showAllBtn)
    || '<p class="muted">Nenhuma conta com vencimento entre 3 dias antes e 3 dias depois.</p>';
}

function renderBillingSummary() {
  const member = state.allMembers.find((entry) => entry.id === Number(document.getElementById('pMember').value));
  const charge = member?.next_charge;
  const planField = document.getElementById('pPlan');
  const amountField = document.getElementById('pAmount');
  if (charge) {
    planField.value = String(member.plan_id || '');
    amountField.value = (charge.amount / 100).toFixed(2);
  } else if (amountField.disabled) {
    const selectedPlan = state.plans.find((entry) => entry.id === Number(planField.value));
    amountField.value = selectedPlan ? (selectedPlan.price_cents / 100).toFixed(2) : '';
  }
  planField.disabled = Boolean(charge);
  amountField.disabled = Boolean(charge);
  const plan = state.plans.find((entry) => entry.id === Number(planField.value));
  const amount = toCents(amountField.value);
  const summary = document.getElementById('billingSummary');
  const team = member?.access_role && member.access_role !== 'student';
  const today = billingDateFormat.format(new Date());
  const due = charge?.due || member?.valid_until;
  const expired = due && due < today;
  const baseAmount = charge?.amount ?? amount;
  const creditCents = Number(member?.credit_cents || 0);
  const creditBox = document.getElementById('pCreditBox');
  const useCreditChk = document.getElementById('pUseCredit');
  if (creditBox && useCreditChk) {
    const showCredit = Boolean(member && !team && creditCents > 0);
    creditBox.classList.toggle('hidden', !showCredit);
    if (!showCredit) useCreditChk.checked = false;
    const creditUsed = showCredit && useCreditChk.checked ? Math.min(creditCents, baseAmount) : 0;
    const netAmount = Math.max(0, baseAmount - creditUsed);
    document.getElementById('pCreditInfo').textContent = creditUsed > 0
      ? `Saldo: ${fmtMoney(creditCents)} · Abatendo ${fmtMoney(creditUsed)} → Pagar ${fmtMoney(netAmount)}`
      : `Saldo: ${fmtMoney(creditCents)}`;
  }
  const effectiveCreditUsed = member && !team && creditCents > 0 && useCreditChk?.checked ? Math.min(creditCents, baseAmount) : 0;
  const finalDisplayAmount = Math.max(0, baseAmount - effectiveCreditUsed);
  const openDebtCents = Number(member?.open_debt_cents || 0);

  if (team) {
    summary.classList.remove('is-populated');
    summary.textContent = 'Acesso permanente da equipe · sem mensalidade';
  } else if (!member) {
    summary.classList.remove('is-populated');
    summary.textContent = 'Busque e selecione um aluno para abrir o vencimento em aberto ou lançar um pagamento futuro.';
  } else {
    summary.classList.add('is-populated');
    const statusLabel = charge
      ? (expired ? 'Vencimento em aberto (vencida)' : 'Vencimento em aberto')
      : (expired ? 'Mensalidade vencida' : (due && due >= today ? 'Em dia · Pagamento futuro (adiantado)' : 'Nova cobrança'));
    const baseStartIso = due && due >= today ? due : today;
    const projectedEndIso = plan?.duration_days ? addDaysIso(baseStartIso, plan.duration_days) : '';
    const projectedSub = plan?.duration_days
      ? `Após pagar: válido por +${plan.duration_days} dias${projectedEndIso ? ` (até ${fmtDate(projectedEndIso)})` : ''}`
      : 'Selecione o plano abaixo para calcular a nova validade';
    const displayAmountLabel = effectiveCreditUsed > 0
      ? `${fmtMoney(finalDisplayAmount)} (c/ crédito)`
      : fmtMoney(baseAmount);

    summary.innerHTML = `
      <div class="billing-student-card">
        <div class="billing-student-header">
          <div class="billing-student-identity">
            <span class="billing-student-avatar" aria-hidden="true">${escapeHtml(memberInitials(member.name))}</span>
            <div class="billing-student-meta">
              <div><strong>${escapeHtml(member.name)}</strong> <span class="muted">(#${member.id})</span></div>
              ${member.document ? `<span class="billing-student-cpf">CPF ${escapeHtml(member.document)}</span>` : ''}
            </div>
          </div>
          <div class="inline-actions">
            ${member.plan_id ? `<button type="button" class="btn btn-secondary btn-sm" data-toggle-billing-plan="1">${state.billingChangePlanOpen ? 'Ocultar planos' : 'Trocar matrícula'}</button>` : ''}
            <button type="button" class="btn btn-secondary btn-sm billing-clear-member" data-clear-billing-member="1">Trocar aluno</button>
          </div>
        </div>
        <div class="billing-kpi-grid">
          <div class="billing-kpi-box is-plan">
            <span class="billing-kpi-label">PLANO CADASTRADO</span>
            <strong class="billing-kpi-value">${escapeHtml(plan?.name || member.plan_name || 'Sem plano vinculado')}</strong>
            <span class="billing-kpi-sub">${plan ? `${fmtMoney(plan.price_cents)} · Ciclo de ${plan.duration_days} dias` : 'Selecione o plano abaixo'}</span>
          </div>
          <div class="billing-kpi-box ${expired ? 'is-expired' : 'is-ok'}">
            <span class="billing-kpi-label">VALIDADE DA MATRÍCULA</span>
            <strong class="billing-kpi-value">${escapeHtml(statusLabel)}${due ? ` · ${escapeHtml(fmtDate(due))}` : ' · Sem data'}</strong>
            <span class="billing-kpi-sub">${escapeHtml(projectedSub)}</span>
          </div>
          <div class="billing-kpi-box ${openDebtCents > 0 ? 'is-warning' : ''}">
            <span class="billing-kpi-label">RESUMO FINANCEIRO DO ALUNO</span>
            <strong class="billing-kpi-value">A pagar agora: ${escapeHtml(displayAmountLabel)}</strong>
            <span class="billing-kpi-sub">${openDebtCents > 0 ? `⚠️ Saldo pendente (fiado): ${fmtMoney(openDebtCents)}` : '✓ Nenhuma pendência / fiado em aberto'}</span>
          </div>
        </div>
      </div>
    `;
  }

  const paymentOptionsEl = document.getElementById('paymentOptions');
  if (paymentOptionsEl) {
    paymentOptionsEl.hidden = false;
    paymentOptionsEl.open = true;
  }
  const splitToggle = document.getElementById('pSplitToggle');
  const splitActive = Boolean(splitToggle?.checked);
  document.getElementById('pSingleMethodWrap')?.classList.toggle('hidden', splitActive);
  document.getElementById('pSplitBox')?.classList.toggle('hidden', !splitActive);
  syncBillingMethodCardsActive();
  let splitValid = true;
  if (splitActive && typeof syncSplitSummary === 'function') {
    const remaining = syncSplitSummary(finalDisplayAmount);
    splitValid = remaining === 0;
  }

  const hasBillableMember = Boolean(member && !team);
  const showPlanStep = hasBillableMember && (!member.plan_id || Boolean(state.billingChangePlanOpen));
  document.getElementById('billingStep2')?.classList.toggle('hidden', !showPlanStep);
  document.getElementById('billingStep3')?.classList.toggle('hidden', !hasBillableMember);
  document.getElementById('billingCheckoutAsideWrap')?.classList.toggle('hidden', !hasBillableMember);

  const searchWrap = document.getElementById('billingSearchWrap');
  if (searchWrap) {
    searchWrap.classList.toggle('hidden', hasBillableMember);
  }

  const asideTotal = document.getElementById('billingAsideTotal');
  const asideFinalInput = document.getElementById('billingAsideFinalAmount');
  const asideMember = document.getElementById('billingAsideMember');
  const asidePlan = document.getElementById('billingAsidePlan');
  const asideValidity = document.getElementById('billingAsideValidity');
  const asideMethod = document.getElementById('billingAsideMethod');
  const asideExtra = document.getElementById('billingAsideExtra');
  const diffBox = document.getElementById('billingDiffBox');

  if (asideFinalInput && !state.billingFinalAmountEdited) {
    asideFinalInput.value = hasBillableMember ? (finalDisplayAmount / 100).toFixed(2) : '0.00';
  }
  const finalPaidCents = hasBillableMember && asideFinalInput
    ? toCents(asideFinalInput.value)
    : finalDisplayAmount;

  if (asideTotal) {
    asideTotal.textContent = hasBillableMember ? fmtMoney(finalPaidCents) : 'R$ 0,00';
  }
  if (diffBox) {
    const diffCents = hasBillableMember ? (finalPaidCents - finalDisplayAmount) : 0;
    if (!hasBillableMember || splitActive || diffCents === 0 || finalPaidCents <= 0) {
      diffBox.classList.add('hidden');
      diffBox.innerHTML = '';
    } else if (diffCents > 0) {
      const checked = state.billingExcessAsCredit !== false ? 'checked' : '';
      diffBox.classList.remove('hidden');
      diffBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:4px;">
          <strong>Valor maior (+${fmtMoney(diffCents)})</strong>
          <label class="checkbox-label" style="display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer;">
            <input type="checkbox" id="billingExcessAsCredit" ${checked} />
            <span>Colocar ${fmtMoney(diffCents)} como crédito do aluno</span>
          </label>
        </div>
      `;
    } else {
      const absDiff = Math.abs(diffCents);
      const lowerMode = state.billingLowerMode === 'debt' ? 'debt' : 'discount';
      diffBox.classList.remove('hidden');
      diffBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;">
          <strong>Valor menor (-${fmtMoney(absDiff)}) · Escolha como lançar:</strong>
          <div style="display:flex;gap:14px;flex-wrap:wrap;">
            <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
              <input type="radio" name="billingLowerMode" value="discount" ${lowerMode === 'discount' ? 'checked' : ''} />
              <span>Desconto</span>
            </label>
            <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
              <input type="radio" name="billingLowerMode" value="debt" ${lowerMode === 'debt' ? 'checked' : ''} />
              <span>Débito (${fmtMoney(absDiff)} pendente)</span>
            </label>
          </div>
        </div>
      `;
    }
  }
  if (asideMember) {
    asideMember.textContent = member ? `${member.name} (#${member.id})` : 'Nenhum selecionado';
  }
  if (asidePlan) {
    asidePlan.textContent = member && !team ? (plan?.name || member.plan_name || 'Selecione um plano') : '—';
  }
  if (asideValidity) {
    if (member && !team && plan?.duration_days) {
      const baseStartIso = due && due >= today ? due : today;
      const projectedEndIso = addDaysIso(baseStartIso, plan.duration_days);
      asideValidity.textContent = projectedEndIso ? `Até ${fmtDate(projectedEndIso)} (+${plan.duration_days}d)` : `+${plan.duration_days} dias`;
    } else {
      asideValidity.textContent = due ? fmtDate(due) : '—';
    }
  }
  if (asideMethod) {
    const splitActiveNow = Boolean(document.getElementById('pSplitToggle')?.checked);
    const currentMethodCode = document.getElementById('pMethod')?.value;
    asideMethod.textContent = splitActiveNow ? 'Dividido / Fiado' : (methodName(currentMethodCode) || '—');
  }
  if (asideExtra) {
    const notes = [];
    if (member && !team && openDebtCents > 0) notes.push(`Fiado em aberto: ${fmtMoney(openDebtCents)}`);
    if (member && !team && effectiveCreditUsed > 0) notes.push(`Crédito abatido: -${fmtMoney(effectiveCreditUsed)}`);
    asideExtra.classList.toggle('hidden', notes.length === 0);
    asideExtra.textContent = notes.join(' · ');
  }

  const submitBtn = document.querySelector('#paymentForm [type="submit"]');
  if (typeof renderBillingPlanPicker === 'function') renderBillingPlanPicker();
  const isDisabled = !member || team || finalPaidCents <= 0 || !splitValid;
  if (submitBtn) {
    submitBtn.disabled = isDisabled;
    if (isDisabled) {
      submitBtn.textContent = 'Confirmar Recebimento';
    } else if (splitActive) {
      submitBtn.textContent = `Confirmar Recebimento · ${fmtMoney(finalDisplayAmount)} (Dividido / Fiado)`;
    } else {
      const currentMethodCode = document.getElementById('pMethod')?.value;
      submitBtn.textContent = `Confirmar Recebimento · ${fmtMoney(finalPaidCents)} (${methodName(currentMethodCode)})`;
    }
  }
}

document.getElementById('billingSummary')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-toggle-billing-plan]')) {
    state.billingChangePlanOpen = !state.billingChangePlanOpen;
    renderBillingSummary();
    return;
  }
  const clearBtn = event.target.closest('[data-clear-billing-member]');
  if (!clearBtn) return;
  state.billingChangePlanOpen = false;
  state.billingFinalAmountEdited = false;
  document.getElementById('pMemberSearch').value = '';
  document.getElementById('pMember').value = '';
  document.getElementById('billingMemberResults')?.classList.add('hidden');
  document.getElementById('whatsappCheckoutBox')?.classList.add('hidden');
  document.getElementById('pixChargeBox')?.classList.add('hidden');
  renderBillingSummary();
  document.getElementById('pMemberSearch')?.focus();
});

document.getElementById('billingQueue').addEventListener('click', (event) => {
  if (event.target.closest('[data-billing-show-all]')) {
    renderBillingQueue(true);
    return;
  }
  const button = event.target.closest('button[data-id]');
  const member = button && state.allMembers.find((entry) => entry.id === Number(button.dataset.id));
  if (member) selectBillingMember(member);
});
document.getElementById('pAmount').addEventListener('input', () => {
  state.billingFinalAmountEdited = false;
  renderBillingSummary();
});
document.getElementById('billingAsideFinalAmount')?.addEventListener('input', () => {
  state.billingFinalAmountEdited = true;
  renderBillingSummary();
});
document.getElementById('billingDiffBox')?.addEventListener('change', (e) => {
  if (e.target.id === 'billingExcessAsCredit') {
    state.billingExcessAsCredit = e.target.checked;
  } else if (e.target.name === 'billingLowerMode') {
    state.billingLowerMode = e.target.value;
  }
});
document.getElementById('billingQuickAdjust')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-billing-discount]');
  if (!btn) return;
  const amountField = document.getElementById('pAmount');
  if (!amountField || amountField.disabled) return;
  const planId = Number(document.getElementById('pPlan')?.value);
  const plan = state.plans.find((p) => p.id === planId);
  const baseReais = plan ? plan.price_cents / 100 : Number(amountField.value || 0);
  const spec = btn.dataset.billingDiscount;
  if (spec === 'reset') {
    if (plan) amountField.value = (plan.price_cents / 100).toFixed(2);
  } else if (spec === 'flat:10') {
    const cur = Number(amountField.value || baseReais);
    amountField.value = Math.max(0.01, cur - 10).toFixed(2);
  } else if (spec === 'pct:10') {
    const cur = Number(amountField.value || baseReais);
    amountField.value = Math.max(0.01, cur * 0.9).toFixed(2);
  }
  renderBillingSummary();
});

let memberCounts = { all: 0, active: 0, blocked: 0, pending: 0, noface: 0 };

function updateMemberFilterChips() {
  const counts = memberCounts;
  const labels = {
    all: `Todos (${counts.all})`,
    active: `Ativos (${counts.active})`,
    blocked: `Bloqueados (${counts.blocked})`,
    pending: `Pendentes (${counts.pending})`,
    noface: `Sem FaceID (${counts.noface})`,
  };
  document.querySelectorAll('#memberFilterChips .chip').forEach((chip) => {
    const f = chip.dataset.filter;
    if (labels[f]) chip.textContent = labels[f];
    chip.classList.toggle('active', f === state.memberFilter);
    chip.setAttribute('aria-pressed', String(f === state.memberFilter));
  });
}

function renderMembersTable() {
  const q = normalizeSearch(document.getElementById('memberSearch').value);
  const digits = numericSearch(q);
  const todayIso = billingDateFormat.format(new Date());

  state.filteredMembers = state.memberSearchIndex.filter((entry) => {
    const m = entry.member;
    const status = m.access_status || m.status;
    if (['active', 'blocked', 'pending'].includes(state.memberFilter) && status !== state.memberFilter) return false;
    if (state.memberFilter === 'noface' && m.face_registered) return false;
    return !q || matchMemberSearch(entry, q, digits);
  }).map((entry) => entry.member);

  const visible = state.filteredMembers.slice(0, state.memberLimit);
  const statusLabels = {
    active: '<span class="badge badge-active">Ativo</span>',
    blocked: '<span class="badge badge-blocked">Bloqueado</span>',
    pending: '<span class="badge badge-pending">Pendente</span>',
  };

  document.getElementById('membersBody').innerHTML = visible.length
    ? visible
        .map((m) => {
          const partnerLabel =
            m.partner_provider === 'wellhub'
              ? `Wellhub${m.wellhub_id ? ` · ID ${m.wellhub_id}` : ''}`
              : m.partner_provider === 'totalpass'
                ? 'TotalPass · CPF'
                : '';
          const modPlan = [m.modality_name, partnerLabel || m.plan_name].filter(Boolean).join(' · ') || '-';
          const isExpired = !m.partner_provider && Boolean(m.valid_until && m.valid_until < todayIso);
          const syncWarning = m.last_sync_error
            ? `<div class="muted" style="color:var(--danger);font-size:11px;" title="${escapeHtml(m.last_sync_error)}">⚠ Erro sync catraca</div>`
            : '';
          return `
            <tr data-member-id="${m.id}">
              <td><strong>${escapeHtml(m.name)}</strong><br><span class="muted">#${m.id}${escapeHtml(m.document ? ` · ${m.document}` : m.phone ? ` · ${m.phone}` : '')}</span></td>
              <td>${escapeHtml(modPlan)}</td>
              <td class="${isExpired ? 'text-danger' : ''}">${m.partner_provider ? '<span class="muted">Convênio</span>' : escapeHtml(fmtDate(m.valid_until))}</td>
              <td>${m.face_registered ? 'Cadastrado' : '<span class="muted">Sem foto</span>'}</td>
              <td>${m.in_grace && m.access_status === 'active' ? '<span class="badge badge-pending">Em tolerância</span>' : statusLabels[m.access_status || m.status] || escapeHtml(m.status)}${syncWarning}</td>
              <td><div class="inline-actions member-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-action="profile">Perfil</button>
                <button type="button" class="btn btn-success btn-sm" data-action="pay">Receber</button>
                <button type="button" class="btn btn-primary btn-sm" data-action="face">FaceID</button>
                <button type="button" class="btn ${m.status === 'active' ? 'btn-danger' : 'btn-warning'} btn-sm" data-action="toggle" data-next-status="${m.status === 'active' ? 'blocked' : 'active'}">
                  ${m.status === 'active' ? 'Bloquear' : 'Liberar'}
                </button>
              </div></td>
            </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty-cell">Nenhum aluno encontrado para este filtro.</td></tr>';

  document.getElementById('membersCounter').textContent = `Exibindo ${visible.length} de ${state.filteredMembers.length} aluno(s)`;
  document
    .getElementById('btnLoadMoreMembers')
    .classList.toggle('hidden', visible.length >= state.filteredMembers.length);
}

function rebuildMemberSearchIndex() {
  memberCounts = { all: state.allMembers.length, active: 0, blocked: 0, pending: 0, noface: 0 };
  state.memberSearchIndex = state.allMembers.map((member) => {
    const status = member.access_status || member.status;
    if (['active', 'blocked', 'pending'].includes(status)) memberCounts[status]++;
    if (!member.face_registered) memberCounts.noface++;
    const document = normalizeSearch(member.document);
    const phone = normalizeSearch(member.phone);
    return { member, name: normalizeSearch(member.name), document, phone, documentDigits: numericSearch(document), phoneDigits: numericSearch(phone) };
  });
}

function patchMemberInState(updated) {
  if (!updated || updated.id == null) return false;
  const idx = state.allMembers.findIndex((m) => Number(m.id) === Number(updated.id));
  if (idx === -1) return false;
  state.allMembers[idx] = { ...state.allMembers[idx], ...updated };
  if (state.selectedProfileMember && Number(state.selectedProfileMember.id) === Number(updated.id)) {
    state.selectedProfileMember = { ...state.selectedProfileMember, ...updated };
  }
  rebuildMemberSearchIndex();
  updateMemberFilterChips();
  renderMembersTable();
  renderBillingQueue();
  return true;
}

async function loadMembers() {
  const members = await api('/api/members?view=summary');
  state.allMembers = members.filter((member) => !member.access_role || member.access_role === 'student');
  state.teamMembers = members.filter((member) => member.access_role && member.access_role !== 'student');
  rebuildMemberSearchIndex();
  updateMemberFilterChips();
  renderMembersTable();
  renderBillingQueue();
  renderTeam();
}

function renderTeam() {
  document.getElementById('teamBody').innerHTML = state.teamMembers.map((member) => `
    <tr data-member-id="${member.id}">
      <td><strong>${escapeHtml(member.name)}</strong><br><span class="muted">#${member.id}</span></td>
      <td>${escapeHtml(accessRoles[member.access_role])}</td>
      <td>${escapeHtml(member.phone || '—')}</td>
      <td>${member.face_registered ? 'Cadastrado' : 'Sem foto'}${member.last_sync_error ? `<div class="text-danger" title="${escapeHtml(member.last_sync_error)}">Falha na sincronização</div>` : ''}</td>
      <td><div class="inline-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-action="profile">Perfil</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="face">Foto / FaceID</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">Nenhum integrante com cadastro de FaceID.</td></tr>';
}

document.getElementById('teamBody').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const member = state.teamMembers.find((entry) => entry.id === Number(button?.closest('tr')?.dataset.memberId));
  if (!member) return;
  if (button.dataset.action === 'profile') openProfile(member.id);
  else openFaceModal(member.id, member.name);
});

document.getElementById('membersBody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const tr = btn.closest('tr[data-member-id]');
  const id = Number(tr?.dataset.memberId);
  const member = state.allMembers.find((m) => m.id === id);
  if (!member) return;

  const action = btn.dataset.action;
  if (action === 'profile') {
    loadTab('members').then((ready) => {
      if (ready && state.activeTab === 'members') openProfile(id);
    });
  } else if (action === 'pay') jumpToPaymentForMember(member);
  else if (action === 'face') openFaceModal(id, member.name);
  else if (action === 'toggle') toggleMemberStatus(id, btn.dataset.nextStatus, member.name);
});

document.getElementById('memberFilterChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-filter]');
  if (!chip) return;
  state.memberFilter = chip.dataset.filter;
  state.memberLimit = 50;
  updateMemberFilterChips();
  renderMembersTable();
});

document.getElementById('btnLoadMoreMembers').addEventListener('click', () => {
  state.memberLimit += 50;
  renderMembersTable();
});

let memberSearchTimer = null;
document.getElementById('memberSearch').addEventListener('input', () => {
  clearTimeout(memberSearchTimer);
  memberSearchTimer = setTimeout(() => {
    state.memberLimit = 50;
    if (state.memberSearchIndex.length) {
      renderMembersTable();
      return;
    }
    loadOnce(loadMembers).then(renderMembersTable).catch(() => {});
  }, 150);
});

function renderBillingMemberSearchResults(rawQuery) {
  const list = document.getElementById('billingMemberResults');
  if (!list) return;
  const q = normalizeSearch(rawQuery);
  if (!q) {
    list.innerHTML = '';
    list.classList.add('hidden');
    return;
  }
  const digits = numericSearch(q);
  const idQuery = q.replace(/^#/, '');
  const matches = [];
  for (const entry of state.memberSearchIndex) {
    const m = entry.member;
    const hit = (idQuery && /^\d+$/.test(idQuery) && String(m.id) === idQuery) ||
      entry.name.includes(q) ||
      entry.document.includes(q) ||
      entry.phone.includes(q) ||
      (digits && (entry.documentDigits.includes(digits) || entry.phoneDigits.includes(digits)));
    if (hit) {
      matches.push(m);
      if (matches.length >= 10) break;
    }
  }
  if (!matches.length) {
    list.innerHTML = '<li class="muted">Nenhum aluno encontrado.</li>';
    list.classList.remove('hidden');
    return;
  }
  const today = billingDateFormat.format(new Date());
  list.innerHTML = matches.map((m) => {
    const due = m.next_charge?.due || m.valid_until;
    const dueText = m.next_charge
      ? `Vencimento: ${fmtDate(m.next_charge.due)}`
      : (due ? (due < today ? `Vencido (${fmtDate(due)})` : `Em dia até ${fmtDate(due)}`) : 'Sem plano');
    return `
      <li style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <strong>${escapeHtml(m.name)}</strong> <span class="muted">#${m.id}</span>
          <div class="muted" style="font-size:12px;">${escapeHtml([m.document || m.phone, dueText].filter(Boolean).join(' · '))}</div>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-pick-billing-member="${m.id}">Selecionar</button>
      </li>
    `;
  }).join('');
  list.classList.remove('hidden');
}

document.getElementById('billingMemberResults')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick-billing-member]');
  if (!btn) return;
  const member = state.allMembers.find((m) => m.id === Number(btn.dataset.pickBillingMember));
  if (!member) return;
  document.getElementById('billingMemberResults')?.classList.add('hidden');
  selectBillingMember(member);
});

const saleMemberSearchEl = document.getElementById('saleMemberSearch');
if (saleMemberSearchEl) {
  saleMemberSearchEl.addEventListener('focus', () => populateMemberDatalist(saleMemberSearchEl.value));
  saleMemberSearchEl.addEventListener('input', () => populateMemberDatalist(saleMemberSearchEl.value));
}

const pMemberSearchEl = document.getElementById('pMemberSearch');
pMemberSearchEl.addEventListener('input', (e) => {
  document.getElementById('whatsappCheckoutBox').classList.add('hidden');
  document.getElementById('pMember').value = '';
  renderBillingMemberSearchResults(e.target.value);
});
pMemberSearchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  document.querySelector('#billingMemberResults [data-pick-billing-member]')?.click();
});

window.openProfile = async (id) => {
  try {
    const request = Symbol();
    state.profileRequest = request;
    const data = await api(`/api/members/${id}/profile`);
    if (state.profileRequest !== request || !['members', 'staff'].includes(state.activeTab)) return;
    state.selectedProfileId = id;
    const m = data.member;
    state.selectedProfileName = m.name;
    state.selectedProfileMember = m;
    state.selectedProfileOpenCharges = data.openCharges || [];
    document.getElementById('faceLinkDeviceId').value = m.controlid_user_id || '';
    document.getElementById('profFaceLinkStatus').textContent = m.controlid_user_id
      ? `ID vinculado no leitor: ${m.controlid_user_id}.` : 'Nenhum ID vinculado ao leitor.';
    document.getElementById('profTitle').textContent = m.name;

    const statusBadge = document.getElementById('profStatusBadge');
    const statusMap = {
      active: { text: 'Ativo', cls: 'badge badge-active' },
      blocked: { text: 'Bloqueado', cls: 'badge badge-blocked' },
      pending: { text: 'Pendente', cls: 'badge badge-pending' },
    };
    const enrollment = data.planEnrollment;
    state.selectedProfileEnrollment = enrollment;
    const role = m.access_role || 'student';
    const team = role !== 'student';
    document.getElementById('profAccessRole').value = role;
    document.getElementById('btnPromoteToStaff')?.classList.toggle('hidden', team);
    document.getElementById('profPlanSection').classList.toggle('hidden', team);
    document.getElementById('profStudentDetails').classList.toggle('hidden', team);
    document.getElementById('btnProfPay').classList.toggle('hidden', team);
    document.getElementById('btnProfToggleStatus').classList.toggle('hidden', team);
    document.getElementById('btnConvertVisitor')?.classList.toggle('hidden', team || !m.is_visitor);
    const today = billingDateFormat.format(new Date());
    const accessStatus = team ? 'active' : m.status === 'blocked' || (enrollment?.ends_on && enrollment.ends_on < today && !data.inGrace)
      ? 'blocked' : !enrollment?.plan_name || !enrollment.ends_on ? 'pending' : m.status;
    const badgeCfg = statusMap[accessStatus] || { text: accessStatus, cls: 'badge badge-pending' };
    const grace = !team && accessStatus === 'active' && data.inGrace;
    statusBadge.textContent = grace ? 'Em tolerância' : badgeCfg.text;
    statusBadge.className = grace ? 'badge badge-pending' : badgeCfg.cls;

    const planSummaryParts = [
      `ID #${m.id}`,
      team ? `${accessRoles[role]} · acesso permanente` : m.plan_name ? `Plano: ${m.plan_name}` : 'Sem plano',
      m.last_sync_error ? `Aviso catraca: ${m.last_sync_error}` : null,
    ].filter(Boolean);
    document.getElementById('profPlanSummary').textContent = planSummaryParts.join(' • ');

    const toggleBtn = document.getElementById('btnProfToggleStatus');
    toggleBtn.textContent = m.status === 'active' ? 'Bloquear' : 'Liberar';
    toggleBtn.className = `btn btn-sm ${m.status === 'active' ? 'btn-danger' : 'btn-warning'}`;

    const photoImg = document.getElementById('profPhoto');
    const photoEmpty = document.getElementById('profPhotoEmpty');
    photoImg.classList.add('hidden');
    photoEmpty.classList.remove('hidden');
    photoImg.onload = () => {
      photoImg.classList.remove('hidden');
      photoEmpty.classList.add('hidden');
    };
    photoImg.onerror = () => {
      photoImg.classList.add('hidden');
      photoEmpty.classList.remove('hidden');
    };
    photoImg.src = `/api/members/${id}/photo?t=${Date.now()}`;

    document.getElementById('profName').value = m.name || '';
    document.getElementById('profDoc').value = formatCpfMask(m.document || '');
    if (m.document) {
      validateCpfField('profDoc', 'profDocFeedback', { excludeId: id, remoteCheck: false });
    } else {
      setCpfFieldState(document.getElementById('profDoc'), document.getElementById('profDocFeedback'), 'neutral', '');
    }
    document.getElementById('profPhone').value = m.phone || '';
    document.getElementById('profEmail').value = m.email || '';
    const sideEmail = document.getElementById('profSideEmail');
    const sidePhone = document.getElementById('profSidePhone');
    const sideWa = document.getElementById('profSideWhatsapp');
    if (sideEmail) sideEmail.textContent = m.email || '—';
    if (sidePhone) sidePhone.textContent = m.phone || '—';
    if (sideWa) {
      const waDigits = String(m.phone || '').replace(/\D+/g, '');
      if (waDigits.length >= 10) {
        const normalizedWa = waDigits.startsWith('55') ? waDigits : `55${waDigits}`;
        sideWa.href = `https://wa.me/${normalizedWa}`;
        sideWa.classList.remove('hidden');
      } else {
        sideWa.removeAttribute('href');
        sideWa.classList.add('hidden');
      }
    }
    const kpiStatus = document.getElementById('profKpiStatus');
    const kpiDebt = document.getElementById('profKpiDebt');
    const kpiCredit = document.getElementById('profKpiCredit');
    if (kpiStatus) {
      const kpiText = grace ? 'Em tolerância' : badgeCfg.text;
      kpiStatus.textContent = enrollment?.ends_on && !team ? `${kpiText} · até ${fmtDate(enrollment.ends_on)}` : kpiText;
    }
    if (kpiDebt) kpiDebt.textContent = fmtMoney(Number(m.open_debt_cents || 0));
    if (kpiCredit) kpiCredit.textContent = fmtMoney(Number(m.credit_cents || 0));
    document.getElementById('profBirth').value = m.birth_date || '';
    document.getElementById('profSex').value = m.sex || '';
    document.getElementById('profEmergency').value = m.emergency_contact || '';
    document.getElementById('profAddress').value = m.address || '';
    document.getElementById('profNotes').value = m.notes || '';
    const profPartner = document.getElementById('profPartnerProvider');
    const profWellhubWrap = document.getElementById('profWellhubWrap');
    const profWellhubId = document.getElementById('profWellhubId');
    const btnPartnerCheckin = document.getElementById('btnPartnerCheckinNow');
    if (profPartner) profPartner.value = m.partner_provider || '';
    if (profWellhubId) profWellhubId.value = m.wellhub_id || '';
    if (profWellhubWrap) profWellhubWrap.classList.toggle('hidden', m.partner_provider !== 'wellhub');
    if (btnPartnerCheckin) btnPartnerCheckin.classList.toggle('hidden', !m.partner_provider);
    const profPlanEl = document.getElementById('profPlan');
    if (profPlanEl) profPlanEl.value = enrollment?.plan_id || '';
    const start = document.getElementById('profPlanStart');
    if (start) {
      start.value = enrollment?.starts_on || today;
      start.max = today;
    }
    const enrStatusEl = document.getElementById('profEnrollmentStatus');
    if (enrStatusEl) {
      enrStatusEl.textContent = enrollment?.ends_on
        ? (enrollment.plan_name
            ? `${enrollment.ends_on < today ? 'Vencida em' : 'Vence em'} ${fmtDate(enrollment.ends_on)}`
            : `Vencimento importado: ${fmtDate(enrollment.ends_on)} · Vincule um plano para ativar o acesso.`)
        : 'Sem matrícula cadastrada. Selecione o plano e a data da matrícula.';
    }
    document.getElementById('profNotes').value = m.notes || '';

    renderProfileEnrollments(data);
    renderProfileEnrollmentTable(data);

    state.selectedProfilePayments = data.payments || [];
    document.getElementById('profPaymentsList').innerHTML = data.payments.length
      ? data.payments
          .map(
            (p) =>
              `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <span>${escapeHtml(fmtDateTime(p.paid_at))} — ${fmtMoney(p.amount_cents)} (${escapeHtml(methodName(p.method))})</span>
                <button type="button" class="btn btn-secondary btn-sm" data-print-prof-payment="${p.id}">Recibo</button>
              </li>`,
          )
          .join('')
      : '<li class="muted">Nenhum pagamento registrado.</li>';

    document.getElementById('profWorkoutsSection').classList.toggle('hidden', m.access_role !== 'student');
    document.getElementById('profContractSection')?.classList.toggle('hidden', m.access_role !== 'student');
    document.getElementById('profFreezeContractSection')?.classList.toggle('hidden', m.access_role !== 'student');
    document.getElementById('profAssessmentsSection')?.classList.toggle('hidden', m.access_role !== 'student');
    document.querySelectorAll('#profileTabs .profile-tab-btn').forEach((btn) => {
      if (btn.dataset.profTab !== 'personal') btn.classList.toggle('hidden', team);
    });
    activateProfileTab(team ? 'personal' : 'finance');
    const isFrozen = Boolean(m.frozen_until && m.frozen_until >= today);
    const freezeStatus = document.getElementById('profFreezeStatus');
    if (freezeStatus) {
      if (isFrozen) {
        const untilLabel = m.frozen_until === '9999-12-31'
          ? `Trancado desde ${fmtDate(m.frozen_started_at || today)} (até destrancar)`
          : `Trancado até ${fmtDate(m.frozen_until)}`;
        freezeStatus.textContent = `${untilLabel}${m.frozen_reason ? ` (${m.frozen_reason})` : ''}`;
      } else {
        freezeStatus.textContent = 'Matrícula ativa (pode trancar 1x por mês, sem limite de dias).';
      }
    }
    document.getElementById('btnUnfreezeMember')?.classList.toggle('hidden', !isFrozen);
    const contractStatus = document.getElementById('profContractStatus');
    if (contractStatus) {
      contractStatus.textContent = m.contract_signed_at
        ? `Assinado em ${fmtDateTime(m.contract_signed_at)}${m.contract_signature ? ` por ${m.contract_signature}` : ''}`
        : 'PAR-Q / Contrato ainda não assinado.';
    }
    if (document.getElementById('contractSignature')) {
      document.getElementById('contractSignature').value = m.contract_signature || '';
    }
    document.getElementById('profFitnessGoal').value = data.weeklyGoal ?? 3;
    document.getElementById('profFitnessGoalForm').querySelector('button').disabled = false;
    document.getElementById('profCreditSection').classList.toggle('hidden', m.access_role !== 'student');
    document.getElementById('studentInviteCode').textContent = '';
    document.getElementById('btnStudentInvite').classList.toggle('hidden', m.has_portal_password);
    document.getElementById('workoutForm').classList.add('hidden');
    if (m.access_role === 'student') {
      await Promise.all([
        loadMemberWorkouts(m.id),
        loadMemberCredit(m.id),
        loadMemberAssessments(m.id),
        loadMemberOpenDebts(m.id),
        loadWorkoutTemplates().catch(() => {}),
      ]);
    } else {
      document.getElementById('profDebtsCountBadge')?.classList.add('hidden');
    }

    showModal('profileModal', 'btnCloseProfile');
  } catch (err) {
    showToast(err.message, true);
  }
};

document.getElementById('profFitnessGoalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const memberId = state.selectedProfileId;
  if (!memberId) return;
  const button = event.currentTarget.querySelector('button');
  const goal = Number(document.getElementById('profFitnessGoal').value);
  button.disabled = true;
  try {
    await api(`/api/members/${memberId}/fitness-goal`, { method: 'PUT', body: JSON.stringify({ goal }) });
    showToast('Meta semanal salva.');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    if (state.selectedProfileId === memberId) button.disabled = false;
  }
});

function renderProfileEnrollmentTable(data) {
  const tbody = document.getElementById('profEnrollmentsTableBody');
  if (!tbody) return;
  const m = data.member || {};
  const enrollment = data.planEnrollment;
  const filter = state.profileEnrollmentFilter || 'active';
  const today = billingDateFormat.format(new Date());
  const planObj = state.plans.find((p) => Number(p.id) === Number(enrollment?.plan_id || m.plan_id));
  const hasEnrollment = Boolean(enrollment?.plan_name || m.plan_name);

  let rowHtml = '';
  if (hasEnrollment) {
    const endsOn = enrollment?.ends_on || m.valid_until || '';
    const startsOn = enrollment?.starts_on || '';
    const isExpired = Boolean(endsOn && endsOn < today);
    const isCancelled = m.status === 'blocked' && isExpired;
    const showRow =
      filter === 'all' ||
      (filter === 'active' && !isExpired) ||
      (filter === 'finished' && isExpired) ||
      (filter === 'cancelled' && isCancelled);

    if (showRow) {
      const planTitle = enrollment?.plan_name || m.plan_name || planObj?.name || 'Plano vinculado';
      const modSub = parsePlanGroup({ name: planTitle, duration_days: planObj?.duration_days || 30 }).modNames.join(', ') || 'Academia';
      const period = planObj ? periodLabelFromPlan(planObj) : 'Mensal';
      const priceText = planObj ? fmtMoney(planObj.price_cents) : '—';
      const dueDay = endsOn ? Number(endsOn.slice(8, 10)) : null;
      const startText = startsOn ? fmtDate(startsOn) : (endsOn ? fmtDate(endsOn) : '—');
      const dueSub = dueDay ? `Vence dia ${dueDay}${endsOn ? ` · até ${fmtDate(endsOn)}` : ''}` : 'Sem vencimento';
      const statusMark = isExpired
        ? '<span class="prof-enr-status is-expired" title="Vencida">✕</span>'
        : '<span class="prof-enr-status is-ok" title="Ativa">✓</span>';
      rowHtml = `
        <tr>
          <td>
            <strong class="prof-enr-plan-name">${escapeHtml(planTitle)}</strong>
            <div class="muted" style="font-size:12px;">${escapeHtml(modSub)}</div>
          </td>
          <td>
            <strong>${escapeHtml(startText)}</strong>
            <div class="muted" style="font-size:12px;">${escapeHtml(dueSub)}</div>
          </td>
          <td><strong>${escapeHtml(period)}</strong></td>
          <td style="text-align:right;white-space:nowrap;">
            <strong style="color:var(--cyan);margin-right:8px;">${escapeHtml(priceText)}</strong>
            ${statusMark}
            <button type="button" class="btn btn-secondary btn-sm" style="margin-left:6px;padding:4px 8px;" data-edit-plan-enrollment="1" title="Alterar plano ou vigência">🔍</button>
          </td>
        </tr>`;
    }
  }

  tbody.innerHTML = rowHtml || '<tr><td colspan="4" class="empty-cell">Nenhuma matrícula encontrada neste filtro.</td></tr>';

  const freqBadge = document.getElementById('profAccessFrequencyBadge');
  if (freqBadge) {
    const parts = [];
    if (planObj?.weekly_limit) parts.push(`${planObj.weekly_limit}x/semana`);
    if (planObj?.allowed_start_time && planObj?.allowed_end_time) parts.push(`${planObj.allowed_start_time}–${planObj.allowed_end_time}`);
    freqBadge.textContent = parts.length ? `📅 Frequência · ${parts.join(' · ')}` : '📅 Frequência · Livre (Seg–Sáb)';
  }
}

document.getElementById('profEnrFilters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-enr-filter]');
  if (!btn) return;
  state.profileEnrollmentFilter = btn.dataset.enrFilter;
  document.querySelectorAll('#profEnrFilters .prof-enr-filter').forEach((b) => b.classList.toggle('active', b === btn));
  if (state.selectedProfileId) {
    renderProfileEnrollmentTable({
      member: state.selectedProfileMember,
      planEnrollment: state.selectedProfileEnrollment,
    });
  }
});

document.getElementById('btnTogglePlanEnrollmentForm')?.addEventListener('click', () => {
  openNewEnrollmentModal();
});

document.getElementById('profEnrollmentsTableBody')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-edit-plan-enrollment]')) {
    openNewEnrollmentModal();
  }
});

function renderNewEnrModalityPills() {
  const container = document.getElementById('newEnrModalityPills');
  if (!container) return;
  const activeMod = state.newEnrModality || '';
  const allBtn = `
    <button type="button" class="modality-pill ${!activeMod ? 'active' : ''}" data-new-enr-mod="">
      <span class="modality-pill-icon" aria-hidden="true">⭐</span>
      <span>Todas</span>
    </button>`;
  const modBtns = state.modalities
    .map((m) => {
      const isActive = activeMod.toLowerCase() === m.name.toLowerCase();
      return `
        <button type="button" class="modality-pill ${isActive ? 'active' : ''}" data-new-enr-mod="${escapeHtml(m.name)}">
          <span class="modality-pill-icon" aria-hidden="true">${modalityIcon(m.name)}</span>
          <span>${escapeHtml(m.name)}</span>
        </button>`;
    })
    .join('');
  container.innerHTML = allBtn + modBtns;
}

function renderNewEnrPlanCards() {
  const container = document.getElementById('newEnrPlanCards');
  if (!container) return;
  const filterMod = (state.newEnrModality || '').toLowerCase();
  const currentPlanId = Number(state.selectedProfileEnrollment?.plan_id || state.selectedProfileMember?.plan_id || 0);

  const groups = new Map();
  for (const plan of state.plans) {
    const info = parsePlanGroup(plan);
    if (filterMod && !info.modNames.some((n) => n.toLowerCase().includes(filterMod) || filterMod.includes(n.toLowerCase()))) {
      continue;
    }
    if (!groups.has(info.baseName)) {
      groups.set(info.baseName, { baseName: info.baseName, modNames: info.modNames, variants: [] });
    }
    groups.get(info.baseName).variants.push({ ...plan, periodLabel: info.periodLabel });
  }

  const cardsHtml = [...groups.values()]
    .map((g) => {
      const variants = [...g.variants].sort((a, b) => a.duration_days - b.duration_days);
      const activeVariant = variants.find((v) => v.id === currentPlanId) || variants[0];
      const isSelected = Number(state.newEnrSelectedPlanId || currentPlanId) === activeVariant.id;
      const minPrice = Math.min(...variants.map((v) => v.price_cents));
      const periodsList = [...new Set(variants.map((v) => v.periodLabel))].join(', ');
      const modBadges = g.modNames
        .map((mn) => `<span class="plan-card-mod-badge">${modalityIcon(mn)} ${escapeHtml(mn)}</span>`)
        .join('');
      const variantButtons = variants
        .map(
          (v) =>
            `<button type="button" class="plan-period-btn ${v.id === activeVariant.id ? 'active' : ''}" data-new-enr-plan-id="${v.id}">${escapeHtml(v.periodLabel)} · ${fmtMoney(v.price_cents)}</button>`,
        )
        .join('');

      return `
        <div class="plan-card ${isSelected ? 'selected' : ''}" data-new-enr-card="${activeVariant.id}">
          <div class="plan-card-head">
            <div class="plan-card-title">${escapeHtml(g.baseName)}</div>
            <span class="plan-card-period-pill">${escapeHtml(periodsList)}</span>
          </div>
          <div class="plan-card-price">
            <small>a partir de</small>
            <strong>${fmtMoney(minPrice)}</strong>
          </div>
          <div class="plan-card-mods">${modBadges}</div>
          <div class="plan-card-periods" style="margin-top:10px;">${variantButtons}</div>
        </div>`;
    })
    .join('');

  container.innerHTML = cardsHtml || '<p class="muted">Nenhum plano encontrado para essa modalidade.</p>';
}

function updateNewEnrStep2(planId) {
  const plan = state.plans.find((p) => Number(p.id) === Number(planId));
  if (!plan) return;
  state.newEnrSelectedPlanId = plan.id;
  document.getElementById('newEnrollmentStep1')?.classList.add('hidden');
  document.getElementById('newEnrollmentStep2')?.classList.remove('hidden');

  const info = parsePlanGroup(plan);
  const icon = modalityIcon(info.modNames[0] || plan.name);
  const headerEl = document.getElementById('newEnrSelectedHeader');
  if (headerEl) {
    headerEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:26px;">${icon}</span>
        <div>
          <strong style="font-size:16px;">${escapeHtml(plan.name)}</strong>
          <div class="muted" style="font-size:12px;">Algumas opções seguem o padrão configurado no plano</div>
        </div>
      </div>
      <div style="text-align:right;">
        <strong style="font-size:18px;color:var(--cyan);">${fmtMoney(plan.price_cents)}</strong>
        <div class="muted" style="font-size:12px;">${plan.duration_days} dias</div>
      </div>`;
  }

  const startInput = document.getElementById('newEnrStartDate');
  const today = billingDateFormat.format(new Date());
  if (startInput) {
    startInput.max = today;
    if (!startInput.value) startInput.value = today;
  }
  updateNewEnrDuePreview();

  const rulesEl = document.getElementById('newEnrAccessPreview');
  if (rulesEl) {
    const freqText = plan.weekly_limit ? `${plan.weekly_limit}x por semana` : 'Todos os dias da semana';
    const timeText =
      plan.allowed_start_time && plan.allowed_end_time
        ? `${plan.allowed_start_time} às ${plan.allowed_end_time}`
        : 'Qualquer Horário · Padrão do Plano';
    const days = [
      { label: 'DOM', off: true, text: 'Sem expediente' },
      { label: 'SEG', off: false, text: timeText },
      { label: 'TER', off: false, text: timeText },
      { label: 'QUA', off: false, text: timeText },
      { label: 'QUI', off: false, text: timeText },
      { label: 'SEX', off: false, text: timeText },
      { label: 'SÁB', off: false, text: timeText },
    ];
    rulesEl.innerHTML = `
      <div class="new-enr-rules-meta">
        <span><strong>Frequência:</strong> ${escapeHtml(freqText)}</span>
        <span><strong>Acesso diário:</strong> Ilimitado no dia</span>
      </div>
      <div class="new-enr-days-list">
        ${days
          .map(
            (d) => `
            <div class="new-enr-day-row ${d.off ? 'is-off' : ''}">
              <strong>${d.label}</strong>
              <span class="muted">${escapeHtml(d.text)}</span>
            </div>`,
          )
          .join('')}
      </div>`;
  }
}

function updateNewEnrDuePreview() {
  const plan = state.plans.find((p) => Number(p.id) === Number(state.newEnrSelectedPlanId));
  const startVal = document.getElementById('newEnrStartDate')?.value || billingDateFormat.format(new Date());
  const dueEl = document.getElementById('newEnrDuePreview');
  if (!dueEl || !plan) return;
  const dueIso = addDaysIso(startVal, plan.duration_days);
  dueEl.textContent = dueIso ? `${fmtDate(dueIso)} (${plan.duration_days} dias)` : '—';
}

function openNewEnrollmentModal() {
  const modal = document.getElementById('newEnrollmentModal');
  if (!modal) return;
  const m = state.selectedProfileMember;
  const enrollment = state.selectedProfileEnrollment;
  const today = billingDateFormat.format(new Date());
  const hasActive = Boolean((enrollment?.plan_id || m?.plan_id) && (enrollment?.ends_on || m?.valid_until || '') >= today);

  document.getElementById('newEnrollmentActiveWarn')?.classList.toggle('hidden', !hasActive);
  document.getElementById('btnRemoveNewEnrollment')?.classList.toggle('hidden', !(enrollment?.plan_id || m?.plan_id));
  document.getElementById('newEnrollmentStep1')?.classList.remove('hidden');
  document.getElementById('newEnrollmentStep2')?.classList.add('hidden');

  const startInput = document.getElementById('newEnrStartDate');
  if (startInput) {
    startInput.value = enrollment?.starts_on || today;
    startInput.max = today;
  }

  state.newEnrModality = '';
  state.newEnrSelectedPlanId = enrollment?.plan_id || m?.plan_id || null;
  renderNewEnrModalityPills();
  renderNewEnrPlanCards();
  modal.classList.remove('hidden');
}

function closeNewEnrollmentModal() {
  document.getElementById('newEnrollmentModal')?.classList.add('hidden');
}

async function submitNewEnrollment(planId, startsOn) {
  const id = state.selectedProfileId;
  if (!id) return;
  try {
    const { charge, sync } = await api(`/api/members/${id}/plan-enrollment`, {
      method: 'PUT',
      body: JSON.stringify({
        plan_id: planId ? Number(planId) : null,
        starts_on: startsOn || null,
      }),
    });
    closeNewEnrollmentModal();
    showToast(
      sync.synced
        ? (planId
            ? (charge ? 'Matrícula salva e cobrança gerada.' : 'Matrícula salva com sucesso.')
            : 'Plano removido — aluno bloqueado para entrar.')
        : `Alteração salva. Aviso da catraca: ${sync.error}`,
      !sync.synced,
    );
    await loadMembers();
    if (state.selectedProfileId === id && !document.getElementById('profileModal').classList.contains('hidden')) {
      await openProfile(id);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('newEnrModalityPills')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-new-enr-mod]');
  if (!btn) return;
  state.newEnrModality = btn.dataset.newEnrMod || '';
  renderNewEnrModalityPills();
  renderNewEnrPlanCards();
});

document.getElementById('newEnrPlanCards')?.addEventListener('click', (e) => {
  const planBtn = e.target.closest('[data-new-enr-plan-id]');
  if (planBtn) {
    updateNewEnrStep2(Number(planBtn.dataset.newEnrPlanId));
    return;
  }
  const card = e.target.closest('[data-new-enr-card]');
  if (card) {
    updateNewEnrStep2(Number(card.dataset.newEnrCard));
  }
});

document.getElementById('newEnrStartDate')?.addEventListener('change', updateNewEnrDuePreview);
document.getElementById('btnBackNewEnrollment')?.addEventListener('click', () => {
  document.getElementById('newEnrollmentStep2')?.classList.add('hidden');
  document.getElementById('newEnrollmentStep1')?.classList.remove('hidden');
});
document.getElementById('btnCloseNewEnrollment')?.addEventListener('click', closeNewEnrollmentModal);
document.getElementById('btnCancelNewEnrollment')?.addEventListener('click', closeNewEnrollmentModal);
document.getElementById('newEnrollmentModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'newEnrollmentModal') closeNewEnrollmentModal();
});
document.getElementById('btnConfirmNewEnrollment')?.addEventListener('click', async () => {
  const startsOn = document.getElementById('newEnrStartDate')?.value || null;
  await submitNewEnrollment(state.newEnrSelectedPlanId, startsOn);
});
document.getElementById('btnRemoveNewEnrollment')?.addEventListener('click', async () => {
  if (!window.confirm('Remover o plano atual e bloquear o acesso na catraca?')) return;
  await submitNewEnrollment(null, null);
});

function renderProfileEnrollments(data) {
  state.profileEnrollments = data.modalities;
  document.getElementById('enrollmentForm').classList.add('hidden');
  const rows = data.modalities.map((entry) => `<li class="enrollment-row">
    <div><strong>${escapeHtml(entry.name)}</strong><div class="muted">${entry.classes.length
      ? entry.classes.map((cls) => escapeHtml(`${cls.name} · ${cls.schedule}`)).join('<br>') : 'Sem turma'}</div></div>
    <div class="inline-actions"><button type="button" class="btn btn-primary btn-sm" data-receive-modality="${escapeHtml(entry.name)}">Receber</button>
    <button class="btn btn-secondary btn-sm" data-edit="${entry.id}" aria-label="Editar matrícula em ${escapeHtml(entry.name)}">Editar</button>
    <button class="btn btn-secondary btn-sm" data-remove="${entry.id}" aria-label="Remover matrícula em ${escapeHtml(entry.name)}">Remover</button></div>
  </li>`);
  if (!rows.length) rows.push('<li class="muted">Sem matrícula em modalidades.</li>');
  for (const cls of data.classes.filter((entry) => !entry.modality_id)) {
    rows.push(`<li class="muted">${escapeHtml(cls.name)} · ${escapeHtml(cls.schedule)} · Turma sem modalidade</li>`);
  }
  document.getElementById('profClassesList').innerHTML = rows.join('');
}

function showModal(id, closeButtonId) {
  const modal = document.getElementById(id);
  if (modal.classList.contains('hidden')) modal.returnFocus = document.activeElement;
  modal.classList.remove('hidden');
  document.getElementById(closeButtonId).focus();
}

function hideModal(id, restoreFocus = true) {
  const modal = document.getElementById(id);
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  if (restoreFocus) modal.returnFocus?.focus();
}

function closeProfileModal(restoreFocus = true) {
  state.profileRequest = null;
  hideModal('profileModal', restoreFocus);
}

document.getElementById('btnCloseProfile').addEventListener('click', () => closeProfileModal());

document.getElementById('btnProfChangePhoto').addEventListener('click', () => {
  if (state.selectedProfileId) {
    openFaceModal(state.selectedProfileId, state.selectedProfileName || 'Aluno');
  }
});

document.getElementById('btnProfPay').addEventListener('click', () => {
  if (state.selectedProfileMember) jumpToPaymentForMember(state.selectedProfileMember);
});

document.getElementById('btnProfToggleStatus').addEventListener('click', async () => {
  const m = state.selectedProfileMember;
  if (!m) return;
  const nextStatus = m.status === 'active' ? 'blocked' : 'active';
  await toggleMemberStatus(m.id, nextStatus, m.name);
  if (!document.getElementById('profileModal').classList.contains('hidden')) {
    await openProfile(m.id);
  }
});

document.getElementById('btnConvertVisitor')?.addEventListener('click', async (e) => {
  const m = state.selectedProfileMember;
  if (!m || !m.is_visitor) return;
  const cpfInput = window.prompt(
    `Converter visitante "${m.name}" em aluno.\nInforme o CPF (11 dígitos):`,
    m.document || '',
  );
  if (cpfInput === null) return;
  const documentVal = cpfInput.trim();
  if (!documentVal) {
    showToast('Informe o CPF para converter em aluno.', true);
    return;
  }

  let planId = null;
  if ((state.plans || []).length) {
    const planOptions = state.plans.map((p) => `${p.id}: ${p.name} (${fmtMoney(p.price_cents)})`).join('\n');
    const planInput = window.prompt(`ID do plano inicial (opcional — deixe em branco para vincular depois):\n${planOptions}`, '');
    if (planInput === null) return;
    if (planInput.trim()) {
      const parsed = Number(planInput.trim());
      if (!Number.isFinite(parsed) || parsed <= 0) {
        showToast('ID de plano inválido.', true);
        return;
      }
      planId = parsed;
    }
  }

  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${m.id}/convert-visitor`, {
        method: 'POST',
        body: JSON.stringify({ document: documentVal, ...(planId ? { plan_id: planId } : {}) }),
      });
      showToast('Visitante convertido em aluno!');
      if (!patchMemberInState(res.member || { id: m.id, is_visitor: 0, document: documentVal })) {
        await loadMembers();
      }
      await openProfile(m.id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  const cpfCheck = await validateCpfField('profDoc', 'profDocFeedback', {
    excludeId: id,
    remoteCheck: true,
    showEmptyError: true,
  });
  if (!cpfCheck.valid) {
    showToast(cpfCheck.message, true);
    document.getElementById('profDoc').focus();
    return;
  }
  await withLoading(e.target, async () => {
    try {
      await api(`/api/members/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: document.getElementById('profName').value,
          document: document.getElementById('profDoc').value,
          phone: document.getElementById('profPhone').value,
          email: document.getElementById('profEmail').value,
          birth_date: document.getElementById('profBirth').value,
          sex: document.getElementById('profSex').value || null,
          emergency_contact: document.getElementById('profEmergency').value,
          address: document.getElementById('profAddress').value,
          partner_provider: document.getElementById('profPartnerProvider')?.value || null,
          wellhub_id: document.getElementById('profWellhubId')?.value.trim() || null,
          notes: document.getElementById('profNotes').value,
        }),
      });
      showToast('Perfil atualizado!');
      await loadMembers();
      if (!document.getElementById('profileModal').classList.contains('hidden') && state.selectedProfileId === id) await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('faceLinkForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const member = state.selectedProfileMember;
  const deviceId = Number(document.getElementById('faceLinkDeviceId').value);
  await withLoading(event.currentTarget, async () => {
    try {
      const reader = await api(`/api/device/users/${deviceId}/identity`);
      const previous = reader.linked.map((entry) => `${entry.name} (#${entry.id})`).join(', ');
      if (state.selectedProfileId !== member.id || document.getElementById('profileModal').classList.contains('hidden')) return;
      if (!window.confirm(`Control iD #${reader.id}: ${reader.name}.\nVínculo local atual: ${previous || 'nenhum'}.\nConfirma que a foto deste ID é de ${member.name} e deseja vinculá-la ao cadastro #${member.id}?`)) return;
      await api(`/api/members/${member.id}/face-link`, {
        method: 'PUT', body: JSON.stringify({ device_id: reader.id, expected_name: reader.name, previous_ids: reader.linked.map((entry) => entry.id) }),
      });
      showToast('Vínculo corrigido. A foto do leitor foi preservada.');
      await loadMembers();
      if (state.selectedProfileId === member.id && !document.getElementById('profileModal').classList.contains('hidden')) await openProfile(member.id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function saveMemberAccessRole(id, role, { currentRole = null, label = null, reloadProfile = false } = {}) {
  if (!id || !role) return false;
  if (role !== 'student' && role !== currentRole &&
      !window.confirm(`Confirmar acesso permanente ao FaceID${label ? ` para ${label}` : ''} como ${accessRoles[role]}?`)) {
    return false;
  }
  const { sync } = await api(`/api/members/${id}/access-role`, {
    method: 'PUT', body: JSON.stringify({ access_role: role }),
  });
  showToast(sync.synced ? 'Tipo de acesso sincronizado com o FaceID.' : `Tipo de acesso salvo. Aviso da catraca: ${sync.error}`, !sync.synced);
  await Promise.all([loadMembers(), loadDashboard()]);
  if (reloadProfile && state.selectedProfileId === id && !document.getElementById('profileModal').classList.contains('hidden')) {
    const tab = role === 'student' ? 'members' : 'staff';
    if (state.activeTab !== tab) {
      closeProfileModal(false);
      if (!await switchTab(tab)) return true;
    }
    await openProfile(id);
  }
  return true;
}

document.getElementById('accessRoleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = state.selectedProfileId;
  const role = document.getElementById('profAccessRole').value;
  await withLoading(event.currentTarget, async () => {
    try {
      await saveMemberAccessRole(id, role, {
        currentRole: state.selectedProfileMember?.access_role,
        reloadProfile: true,
      });
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnPromoteToStaff')?.addEventListener('click', async (event) => {
  const id = state.selectedProfileId;
  const currentRole = state.selectedProfileMember?.access_role || 'student';
  await withLoading(event.currentTarget, async () => {
    try {
      await saveMemberAccessRole(id, 'staff', {
        currentRole,
        label: state.selectedProfileName,
        reloadProfile: true,
      });
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function formatPromoteStudentOption(m) {
  return `#${m.id} - ${m.name}${m.document ? ` (${m.document})` : ''}`;
}

function resolvePromoteStudentInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const idMatch = text.match(/^#?(\d+)\b/);
  if (idMatch) {
    const byId = state.allMembers.find((m) => m.id === Number(idMatch[1]));
    if (byId) return byId;
  }
  const lower = text.toLowerCase();
  const digits = text.replace(/\D/g, '');
  return state.allMembers.find((m) =>
    formatPromoteStudentOption(m).toLowerCase() === lower ||
    m.name.toLowerCase() === lower ||
    (digits && String(m.document || '').replace(/\D/g, '') === digits)
  ) || null;
}

let promoteSearchTimer = null;
document.getElementById('promoteStudentQuery')?.addEventListener('input', (event) => {
  clearTimeout(promoteSearchTimer);
  const query = event.target.value.trim().toLowerCase();
  promoteSearchTimer = setTimeout(() => {
    const list = document.getElementById('promoteStudentOptions');
    if (!list) return;
    if (!query) {
      list.innerHTML = '';
      return;
    }
    const digits = query.replace(/\D/g, '');
    const matches = [];
    for (const m of state.allMembers) {
      const hitName = m.name.toLowerCase().includes(query);
      const hitId = String(m.id) === query.replace(/^#/, '');
      const hitCpf = digits && String(m.document || '').replace(/\D/g, '').includes(digits);
      if (hitName || hitId || hitCpf) {
        matches.push(m);
        if (matches.length >= 25) break;
      }
    }
    list.innerHTML = matches.map((m) => `<option value="${escapeHtml(formatPromoteStudentOption(m))}"></option>`).join('');
  }, 120);
});

document.getElementById('promoteStudentForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('promoteStudentQuery');
  const member = resolvePromoteStudentInput(input?.value);
  if (!member) {
    return showToast('Selecione um aluno válido na lista de sugestões.', true);
  }
  const role = document.getElementById('promoteStudentRole').value || 'staff';
  await withLoading(event.currentTarget, async () => {
    try {
      const ok = await saveMemberAccessRole(member.id, role, {
        currentRole: member.access_role || 'student',
        label: member.name,
      });
      if (ok && input) {
        input.value = '';
        const list = document.getElementById('promoteStudentOptions');
        if (list) list.innerHTML = '';
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('planEnrollmentForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = state.selectedProfileId;
  await withLoading(event.currentTarget, async () => {
    try {
      const rawPlanId = document.getElementById('profPlan').value;
      const { sync } = await api(`/api/members/${id}/plan-enrollment`, {
        method: 'PUT',
        body: JSON.stringify({
          plan_id: rawPlanId ? Number(rawPlanId) : null,
          starts_on: document.getElementById('profPlanStart').value || null,
        }),
      });
      showToast(sync.synced
        ? (rawPlanId ? 'Matrícula salva com sucesso.' : 'Plano removido — aluno bloqueado para entrar.')
        : `Alteração salva. Aviso da catraca: ${sync.error}`, !sync.synced);
      await loadMembers();
      if (state.selectedProfileId === id && !document.getElementById('profileModal').classList.contains('hidden')) await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('enrollmentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const modality = Number(document.getElementById('profModality').value);
  const previous = Number(form.dataset.previous);
  if (modality !== previous && state.profileEnrollments.some((entry) => entry.id === modality)) {
    showToast('Esta modalidade já está cadastrada. Use Editar na matrícula existente.', true);
    return;
  }
  const id = state.selectedProfileId;
  await withLoading(form, async () => {
    try {
      const data = await api(`/api/members/${id}/enrollment`, {
        method: 'PUT',
        body: JSON.stringify({
          modality_id: modality,
          class_id: document.getElementById('profClassSelect').value || null,
          previous_modality_id: previous || null,
        }),
      });
      showToast('Matrícula salva.');
      await refreshEnrollmentProfile(data);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function refreshEnrollmentProfile(data) {
  if (!document.getElementById('profileModal').classList.contains('hidden') && state.selectedProfileId === data.member.id) {
    state.selectedProfileMember = data.member;
    renderProfileEnrollments(data);
    renderProfileEnrollmentTable(data);
    document.getElementById('btnNewEnrollment').focus();
  }
  await Promise.all([loadMembers(), loadGymStructure()]).catch(() => {
    showToast('Matrícula gravada. Recarregue a página para atualizar a lista e a lotação.', true);
  });
}

document.getElementById('profClassesList').addEventListener('click', async (event) => {
  const receive = event.target.closest('button[data-receive-modality]');
  if (receive) {
    const member = state.selectedProfileMember || state.allMembers.find((m) => Number(m.id) === Number(state.selectedProfileId));
    const modName = receive.dataset.receiveModality || '';
    closeProfileModal(false);
    document.querySelector('.tab[data-tab="billing"]')?.click();
    await loadTab('billing');
    if (modName) {
      state.billingPickerModality = modName;
      renderBillingModalityPills();
      renderBillingPlanPicker();
    }
    if (member) selectBillingMember(member);
    return;
  }
  const edit = event.target.closest('button[data-edit]');
  if (edit) {
    openEnrollmentForm(state.profileEnrollments.find((entry) => entry.id === Number(edit.dataset.edit)));
    return;
  }
  const remove = event.target.closest('button[data-remove]');
  if (!remove || !window.confirm('Remover esta matrícula e liberar a vaga na turma?')) return;
  const id = state.selectedProfileId;
  await withLoading(remove, async () => {
    try {
      const data = await api(`/api/members/${id}/enrollment/${remove.dataset.remove}`, { method: 'DELETE' });
      showToast('Matrícula removida.');
      await refreshEnrollmentProfile(data);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Caixa & Pagamentos ---
function updateCloseCashDiff() {
  const diffEl = document.getElementById('closeCashDiff');
  const raw = document.getElementById('closeCashAmount').value;
  if (!state.cashSession || raw === '') {
    diffEl.classList.add('hidden');
    return;
  }
  const counted = toCents(raw);
  const diff = counted - state.cashSession.expected_cents;
  diffEl.classList.remove('hidden');
  if (diff === 0) {
    diffEl.textContent = 'Conferência: caixa bateu exato (R$ 0,00)';
    diffEl.className = 'summary-pill text-success';
  } else if (diff > 0) {
    diffEl.textContent = `Conferência: sobra de ${fmtMoney(diff)}`;
    diffEl.className = 'summary-pill text-success';
  } else {
    diffEl.textContent = `Conferência: quebra/falta de ${fmtMoney(Math.abs(diff))}`;
    diffEl.className = 'summary-pill text-danger';
  }
}
document.getElementById('closeCashAmount').addEventListener('input', updateCloseCashDiff);

let returnToBillingAfterOpening = false;

async function openCashFromBilling() {
  returnToBillingAfterOpening = true;
  document.getElementById('cashOpeningNotice').classList.remove('hidden');
  if (!await switchTab('cash') || state.activeTab !== 'cash') return;
  try {
    await loadCurrentCash();
    if (state.activeTab !== 'cash') return;
    if (state.cashSession) {
      await resumeBillingAfterOpening();
    } else {
      document.getElementById('cashPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('openCashStaff').focus();
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function resumeBillingAfterOpening() {
  if (!returnToBillingAfterOpening) return;
  returnToBillingAfterOpening = false;
  document.getElementById('cashOpeningNotice').classList.add('hidden');
  if (state.activeTab !== 'billing') {
    await switchTab('billing');
  }
  document.getElementById('paymentForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('pMethod').focus();
}

document.getElementById('btnOpenCashForPayment').addEventListener('click', openCashFromBilling);

async function loadCurrentCash() {
  const session = await api('/api/cash/current');
  state.cashSession = session;
  const badge = document.getElementById('cashBadge');
  const closedView = document.getElementById('cashClosedView');
  const openView = document.getElementById('cashOpenView');

  document.getElementById('cashClosedAlert').classList.toggle('hidden', Boolean(session));
  document.getElementById('saleCashAlert').classList.toggle('hidden', Boolean(session));
  const billingCashBadge = document.getElementById('billingCashStatusBadge');
  if (billingCashBadge) {
    billingCashBadge.textContent = session ? 'Caixa: Aberto' : 'Caixa: Fechado';
    billingCashBadge.className = `badge ${session ? 'badge-active' : 'badge-pending'}`;
  }

  if (!session) {
    badge.textContent = 'Fechado';
    badge.className = 'badge badge-pending';
    document.getElementById('statCash').textContent = 'Fechado';
    closedView.classList.remove('hidden');
    openView.classList.add('hidden');
  } else {
    badge.textContent = `Aberto (${session.staff_name || 'Operador'})`;
    badge.className = 'badge badge-active';
    document.getElementById('statCash').textContent = fmtMoney(session.expected_cents);
    closedView.classList.add('hidden');
    openView.classList.remove('hidden');

    document.getElementById('cashOpeningVal').textContent = fmtMoney(session.opening_cents);
    document.getElementById('cashInVal').textContent = fmtMoney(session.total_in_cents);
    document.getElementById('cashOutVal').textContent = fmtMoney(session.total_out_cents);
    document.getElementById('cashExpectedVal').textContent = fmtMoney(session.expected_cents);
    document.getElementById('cashMethodsSummary').textContent = (session.totals_by_method || [])
      .map((entry) => `${methodName(entry.method)}: ${fmtMoney(entry.amount_cents)}`).join(' · ');

    document.getElementById('cashMovementsBody').innerHTML = session.movements.length
      ? session.movements
          .map(
            (m) => `
          <tr>
            <td>${escapeHtml(fmtDateTime(m.created_at))}</td>
            <td>${escapeHtml(({ in: 'Suprimento', out: 'Sangria', payment: 'Mensalidade', sale: 'Venda' })[m.type] || m.type)}</td>
            <td>${escapeHtml(methodName(m.method))}</td>
            <td>${escapeHtml(m.description)}</td>
            <td>${fmtMoney(m.amount_cents)}</td>
          </tr>`,
          )
          .join('')
      : '<tr><td colspan="5" class="muted">Nenhuma movimentação neste turno.</td></tr>';
    updateCloseCashDiff();
  }
}

async function loadCash() {
  await Promise.all([loadCurrentCash(), loadCashHistory()]);
}

async function loadCashHistory() {
  const history = await api('/api/cash/history');
  document.getElementById('cashHistoryBody').innerHTML = history.length
    ? history
        .slice(0, 20)
        .map((h) => {
          const diff = (h.closing_cents ?? 0) - (h.expected_cents ?? 0);
          return `
            <tr>
              <td>${escapeHtml(fmtDateTime(h.opened_at))}</td>
              <td>${escapeHtml(fmtDateTime(h.closed_at))}</td>
              <td>${escapeHtml(h.staff_name || '-')}</td>
              <td>${fmtMoney(h.expected_cents)}</td>
              <td>${fmtMoney(h.closing_cents)}</td>
              <td class="${diff < 0 ? 'text-danger' : 'text-success'}">${fmtMoney(diff)}</td>
            </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="muted">Nenhum caixa encerrado ainda.</td></tr>';
}

let paymentsAbortController = null;

async function loadPayments() {
  if (paymentsAbortController) paymentsAbortController.abort();
  paymentsAbortController = new AbortController();
  const q = document.getElementById('paymentsSearch')?.value?.trim() || '';
  const url = q ? `/api/payments?limit=100&q=${encodeURIComponent(q)}` : '/api/payments?limit=100';
  let list;
  try {
    list = await api(url, { signal: paymentsAbortController.signal });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }
  state.paymentsList = list;
  document.getElementById('paymentsBody').innerHTML = list.length
    ? list
        .map(
          (p) => `
        <tr>
          <td>${escapeHtml(fmtDateTime(p.paid_at))}</td>
          <td>${escapeHtml(p.member_name)}</td>
          <td>${escapeHtml(p.plan_name || '-')}</td>
          <td>${escapeHtml(methodName(p.method))}</td>
          <td>${fmtMoney(p.amount_cents)}</td>
          <td><button type="button" class="btn btn-secondary btn-sm" data-print-payment="${p.id}">Recibo</button></td>
        </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">Nenhum pagamento registrado.</td></tr>';
  loadOpenDebts().catch(() => {});
}

// --- Produtos & Vendas ---
function updateSalePreview() {
  const prodId = Number(document.getElementById('saleProduct').value);
  const qty = Math.max(1, Number(document.getElementById('saleQty').value) || 1);
  const prod = state.products.find((p) => p.id === prodId);
  const total = prod ? prod.price_cents * qty : 0;
  document.getElementById('saleTotalPreview').textContent = `Total: ${fmtMoney(total)}`;
}
document.getElementById('saleProduct').addEventListener('change', updateSalePreview);
document.getElementById('saleQty').addEventListener('input', updateSalePreview);

async function loadProducts() {
  const [products, sales] = await Promise.all([api('/api/products'), api('/api/sales')]);
  state.products = products;

  document.getElementById('saleProduct').innerHTML = state.products.length
    ? state.products
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} — ${fmtMoney(p.price_cents)} (est: ${p.stock})</option>`)
        .join('')
    : '<option value="">Nenhum produto cadastrado</option>';
  updateSalePreview();

  document.getElementById('productsBody').innerHTML = state.products.length
    ? state.products
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.category)}</td><td>${fmtMoney(p.price_cents)}</td><td>${p.stock}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">Nenhum produto cadastrado.</td></tr>';

  state.salesList = sales;
  document.getElementById('salesHistoryBody').innerHTML = sales.length
    ? sales
        .slice(0, 20)
        .map(
          (s) => `
        <tr>
          <td>${escapeHtml(fmtDateTime(s.sold_at))}</td>
          <td>${escapeHtml(s.product_name || '-')}</td>
          <td>${s.quantity}</td>
          <td>${fmtMoney(s.total_cents)}</td>
          <td>${escapeHtml(methodName(s.method))}</td>
          <td><button type="button" class="btn btn-secondary btn-sm" data-print-sale="${s.id}">Recibo</button></td>
        </tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">Nenhuma venda registrada.</td></tr>';
}

// --- Equipe / Atendentes ---
async function loadStaff() {
  state.staff = await api('/api/staff');
  document.getElementById('openCashStaff').innerHTML = state.staff
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.role)})</option>`)
    .join('');
  renderTeamDirectory();
}

function renderTeamDirectory() {
  const entries = [
    ...state.staff.map((person) => ({ ...person, type: 'staff', label: person.role })),
    ...state.instructors.map((person) => ({ ...person, type: 'instructor', label: 'Professor' })),
  ];
  document.getElementById('staffBody').innerHTML = entries.map((person) => `<tr>
    <td>#${person.id}</td><td>${escapeHtml(person.name)}</td><td>${escapeHtml(person.label)}</td>
    <td>${escapeHtml(person.phone || '—')}</td>
    <td><button class="btn btn-secondary btn-sm" type="button" data-id="${person.id}" data-type="${person.type}">Preparar cadastro</button></td>
  </tr>`).join('') || '<tr><td colspan="5" class="empty-cell">Nenhum operador ou professor cadastrado.</td></tr>';
}

document.getElementById('staffBody').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  const source = button.dataset.type === 'staff' ? state.staff : state.instructors;
  const person = source.find((entry) => entry.id === Number(button.dataset.id));
  if (!person) return;

  const team = state.teamMembers.filter((entry) => normalizeSearch(entry.name) === normalizeSearch(person.name));
  if (team.length === 1) {
    await openProfile(team[0].id);
    return;
  }
  document.getElementById('stRole').value = button.dataset.type;
  document.getElementById('stName').value = person.name;
  document.getElementById('stPhone').value = person.phone || '';
  document.getElementById('stDoc').focus();
});

// --- Logs & Configuracoes ---
function renderLogsTable() {
  const q = (document.getElementById('logSearch').value || '').trim().toLowerCase();
  const filtered = q
    ? state.logs.filter(
        (l) =>
          (l.member_name || '').toLowerCase().includes(q) ||
          (l.event_label || '').toLowerCase().includes(q) ||
          String(l.controlid_user_id || '').includes(q),
      )
    : state.logs;

  const visible = filtered.slice(0, state.logsLimit);
  document.getElementById('logsBody').innerHTML = visible.length
    ? visible
        .map(
          (l) =>
            `<tr><td>${escapeHtml(fmtDateTime(l.occurred_at))}</td><td>${escapeHtml(l.controlid_user_id || '-')}</td><td>${escapeHtml(l.member_name || '-')}</td><td>${escapeHtml(l.event_label)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="muted">Nenhum log encontrado.</td></tr>';

  const counter = document.getElementById('logsCounter');
  if (counter) counter.textContent = `Exibindo ${visible.length} de ${filtered.length} registro(s)`;
  document.getElementById('btnLoadMoreLogs')?.classList.toggle('hidden', visible.length >= filtered.length);
}

async function loadLogs() {
  state.logs = await api('/api/logs');
  state.logsLimit = 50;
  renderLogsTable();
}

let logSearchTimer = null;
document.getElementById('logSearch').addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => {
    state.logsLimit = 50;
    renderLogsTable();
  }, 150);
});
document.getElementById('btnLoadMoreLogs')?.addEventListener('click', () => {
  state.logsLimit += 50;
  renderLogsTable();
});
document.getElementById('logsAutoRefresh').addEventListener('change', (e) => {
  clearTimeout(state.logsTimer);
  state.logsTimer = null;
  if (e.target.checked) {
    const tick = async () => {
      const timer = state.logsTimer;
      if (state.activeTab === 'logs' && !document.hidden) await loadLogs().catch(() => {});
      if (state.logsTimer === timer) state.logsTimer = setTimeout(tick, 15000);
    };
    state.logsTimer = setTimeout(tick, 15000);
  }
});

async function loadSettings() {
  const s = await api('/api/settings');
  const gymName = /^(Minha Academia|Academia Oxigenio)$/i.test(s.gym_name) ? 'Academia Oxigênio' : s.gym_name;
  state.gymName = gymName || 'Academia Oxigênio';
  state.gymPhone = s.gym_phone || '';
  document.getElementById('gymNameTitle').textContent = state.gymName;
  document.getElementById('sGymName').value = s.gym_name || '';
  document.getElementById('sGymPhone').value = s.gym_phone || '';
  document.getElementById('sTolerance').value = s.tolerance_days || '3';
  if (document.getElementById('sAntipassback')) document.getElementById('sAntipassback').value = s.antipassback_minutes || '0';
  if (document.getElementById('sMaxCapacity')) document.getElementById('sMaxCapacity').value = s.max_capacity || '0';
  if (document.getElementById('backupLastAt')) {
    document.getElementById('backupLastAt').textContent = s.backup_last_at ? `Último backup: ${fmtDateTime(s.backup_last_at)}` : 'Nenhum backup gerado ainda.';
    const gdriveEnabledEl = document.getElementById('gdriveEnabled');
    if (gdriveEnabledEl) {
      gdriveEnabledEl.checked = s.backup_gdrive_enabled === 'true';
      document.getElementById('gdriveMode').value = s.backup_gdrive_mode === 'local' ? 'local' : 'api';
      document.getElementById('gdriveLocalDir').value = s.backup_gdrive_local_dir || '';
      document.getElementById('gdriveFolderId').value = s.backup_gdrive_folder_id || '';
      document.getElementById('gdriveClientId').value = s.backup_gdrive_client_id || '';
      document.getElementById('gdriveClientSecret').value = '';
      document.getElementById('gdriveClientSecret').placeholder = s.backup_gdrive_client_secret ? 'Configurado (preencha para alterar)' : 'Preencha para configurar';
      document.getElementById('gdriveRefreshToken').value = '';
      document.getElementById('gdriveRefreshToken').placeholder = s.backup_gdrive_refresh_token ? 'Conectado (preencha para alterar)' : 'Preenchido ao conectar ou cole aqui';
      document.getElementById('gdriveServiceAccount').value = '';
      document.getElementById('gdriveServiceAccount').placeholder = s.backup_gdrive_service_account_json ? 'Service Account configurada (cole novo JSON para alterar)' : '{"client_email":"...","private_key":"..."}';
      toggleGdriveModeFields();
      const statusEl = document.getElementById('gdriveBackupStatus');
      if (statusEl) {
        if (s.backup_gdrive_last_error) {
          statusEl.textContent = `Erro no último envio: ${s.backup_gdrive_last_error}`;
          statusEl.className = 'text-danger';
        } else if (s.backup_gdrive_last_at) {
          statusEl.textContent = `Último envio Drive: ${fmtDateTime(s.backup_gdrive_last_at)}${s.backup_gdrive_last_file ? ` (${s.backup_gdrive_last_file})` : ''}`;
          statusEl.className = 'muted';
        } else {
          statusEl.textContent = s.backup_gdrive_enabled === 'true' ? 'Ativo (aguardando próximo envio)' : 'Não configurado';
          statusEl.className = 'muted';
        }
      }
    }
  }
  document.getElementById('sIp').value = s.controlid_ip || '';
  document.getElementById('sPort').value = s.controlid_port || '80';
  document.getElementById('sUser').value = s.controlid_user || 'admin';
  document.getElementById('sPass').value = s.controlid_password || '';
  document.getElementById('sToletusIp').value = s.toletus_ip || '192.168.100.242';
  document.getElementById('sToletusPort').value = s.toletus_port || '7878';
  document.getElementById('sToletusEnabled').checked = s.toletus_enabled !== 'false';
  document.getElementById('sMockMode').checked = s.controlid_mock_mode === 'true';

  if (document.getElementById('sWellhubEnabled')) {
    document.getElementById('sWellhubEnabled').checked = s.wellhub_enabled !== 'false';
    document.getElementById('sWellhubRequireCheckin').checked = s.wellhub_require_checkin === '1';
    document.getElementById('sWellhubGymId').value = s.wellhub_gym_id || '';
    document.getElementById('sWellhubApiKey').value = s.wellhub_api_key || '';
    document.getElementById('sWellhubWebhookSecret').value = s.wellhub_webhook_secret || '';
    document.getElementById('sTotalpassEnabled').checked = s.totalpass_enabled !== 'false';
    document.getElementById('sTotalpassRequireCheckin').checked = s.totalpass_require_checkin === '1';
    document.getElementById('sTotalpassGymId').value = s.totalpass_gym_id || '';
    document.getElementById('sTotalpassApiToken').value = s.totalpass_api_token || '';
    document.getElementById('sTotalpassWebhookSecret').value = s.totalpass_webhook_secret || '';
  }

  document.getElementById('waEnabled').checked = s.whatsapp_enabled === '1';
  document.getElementById('waNotifyPayment').checked = s.whatsapp_notify_payment !== '0';
  document.getElementById('waNotifyDue').checked = s.whatsapp_notify_due !== '0';
  document.getElementById('waNotifyInactive').checked = s.whatsapp_notify_inactive !== '0';
  if (document.getElementById('waNotifyWelcome')) document.getElementById('waNotifyWelcome').checked = s.whatsapp_notify_welcome !== '0';
  if (document.getElementById('waNotifyWorkoutReview')) document.getElementById('waNotifyWorkoutReview').checked = s.whatsapp_notify_workout_review !== '0';
  if (document.getElementById('waNotifyWinback')) document.getElementById('waNotifyWinback').checked = s.whatsapp_notify_winback !== '0';
  if (document.getElementById('waNotifyClassReminder')) document.getElementById('waNotifyClassReminder').checked = s.whatsapp_notify_class_reminder !== '0';
  if (document.getElementById('waNotifyWaitlist')) document.getElementById('waNotifyWaitlist').checked = s.whatsapp_notify_waitlist !== '0';
  document.getElementById('waDueDays').value = s.whatsapp_due_days_before || '1';
  document.getElementById('waInactiveDays').value = s.whatsapp_inactive_days || '10';
  document.getElementById('waDailyLimit').value = s.whatsapp_daily_limit || '40';
  document.getElementById('waMinDelay').value = s.whatsapp_min_delay_sec || '15';
  document.getElementById('waWindowStart').value = s.whatsapp_window_start || '08:00';
  document.getElementById('waWindowEnd').value = s.whatsapp_window_end || '20:00';
  document.getElementById('waTplPayment').value = s.whatsapp_tpl_payment || '';
  document.getElementById('waTplDue').value = s.whatsapp_tpl_due || '';
  document.getElementById('waTplInactive').value = s.whatsapp_tpl_inactive || '';
  document.getElementById('waReceiptEnabled').checked = s.whatsapp_receipt_enabled !== '0';
  document.getElementById('waGeminiKey').value = s.gemini_api_key || '';
  document.getElementById('waGeminiModel').value = s.gemini_model || 'gemini-3.8-flash';
  document.getElementById('waPixName').value = s.pix_recipient_name || '';
  document.getElementById('waPixKey').value = s.pix_recipient_key || '';

  document.getElementById('gwMpToken').value = s.mp_access_token || '';
  document.getElementById('gwMpPointToken').value = s.mp_point_access_token || '';
  document.getElementById('gwMpWebhookSecret').value = s.mp_webhook_secret || '';
  document.getElementById('gwMpPointWebhookSecret').value = s.mp_point_webhook_secret || '';
  document.getElementById('gwMpPointTerminalId').value = s.mp_point_terminal_id || '';
  document.getElementById('authEnabled').checked = s.auth_enabled === '1';
  document.getElementById('authUsername').value = s.auth_username || 'admin';

  const statusText = document.getElementById('deviceStatusText');
  if (s.controlid_mock_mode === 'true') {
    statusText.textContent = 'Modo simulado';
  } else if (s.controlid_ip) {
    statusText.textContent = 'FaceID configurado';
  } else {
    statusText.textContent = 'FaceID sem configuração';
  }
}

const DIRECTION_LABELS = { entry: 'Entrada', exit: 'Saída', both: 'Ambos' };
const FREE_SIDE_LABELS = { none: 'Nenhum', entry: 'Entrada livre', exit: 'Saída livre', both: 'Ambos livres' };

function resetTurnstileForm() {
  document.getElementById('tId').value = '';
  document.getElementById('tName').value = '';
  document.getElementById('tDriver').value = 'toletus';
  document.getElementById('tIp').value = '';
  document.getElementById('tPort').value = '7878';
  document.getElementById('tReleaseSeconds').value = '5';
  document.getElementById('tDefaultDirection').value = 'entry';
  document.getElementById('tFreeSide').value = 'none';
  document.getElementById('tActive').checked = true;
  document.getElementById('btnSaveTurnstile').textContent = 'Salvar Catraca';
  document.getElementById('btnCancelTurnstileEdit').classList.add('hidden');
}

function resetReaderForm() {
  document.getElementById('rId').value = '';
  document.getElementById('rName').value = '';
  document.getElementById('rIp').value = '';
  document.getElementById('rPort').value = '80';
  document.getElementById('rUsername').value = 'admin';
  document.getElementById('rPassword').value = '';
  document.getElementById('rActionMode').value = 'sec_box';
  document.getElementById('rSecboxId').value = '65793';
  document.getElementById('rGroupId').value = '1';
  document.getElementById('rDirection').value = 'entry';
  document.getElementById('rTurnstileId').value = '';
  document.getElementById('rActive').checked = true;
  document.getElementById('btnSaveReader').textContent = 'Salvar Leitor';
  document.getElementById('btnCancelReaderEdit').classList.add('hidden');
}

function renderTurnstiles() {
  const turnstiles = state.turnstiles || [];
  const tbody = document.getElementById('turnstilesBody');
  const readerSelect = document.getElementById('rTurnstileId');
  const releaseSelect = document.getElementById('releaseTurnstileId');
  const releaseDir = document.getElementById('releaseDirection');

  if (readerSelect) {
    const prev = readerSelect.value;
    readerSelect.innerHTML = '<option value="">Sem vínculo (usar padrão)</option>' +
      turnstiles.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.driver)})</option>`).join('');
    if (prev) readerSelect.value = prev;
  }

  if (releaseSelect) {
    const activeTurnstiles = turnstiles.filter((t) => t.active);
    const prev = releaseSelect.value;
    releaseSelect.innerHTML = activeTurnstiles
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('');
    if (prev && activeTurnstiles.some((t) => String(t.id) === prev)) {
      releaseSelect.value = prev;
    } else if (activeTurnstiles[0] && releaseDir && !releaseDir.dataset.userChanged) {
      releaseDir.value = activeTurnstiles[0].default_direction || 'entry';
    }
    releaseSelect.classList.toggle('hidden', activeTurnstiles.length <= 1);
  }

  if (!tbody) return;
  if (!turnstiles.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhuma catraca cadastrada.</td></tr>';
    return;
  }
  tbody.innerHTML = turnstiles.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td>${escapeHtml(t.driver === 'toletus' ? 'Toletus' : 'Control iD')}</td>
      <td><code>${escapeHtml(t.ip || '—')}:${Number(t.port) || 0}</code></td>
      <td>${Number(t.release_seconds) || 5}s</td>
      <td>${escapeHtml(DIRECTION_LABELS[t.default_direction] || t.default_direction)}</td>
      <td>${escapeHtml(FREE_SIDE_LABELS[t.free_side] || t.free_side)}</td>
      <td><span class="badge ${t.active ? 'badge-active' : 'badge-inactive'}">${t.active ? 'Ativa' : 'Inativa'}</span></td>
      <td class="inline-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-turnstile-action="test" data-id="${t.id}">Testar</button>
        ${t.driver === 'toletus' ? `<button type="button" class="btn btn-primary btn-sm" data-turnstile-action="apply" data-id="${t.id}">Aplicar</button>` : ''}
        <button type="button" class="btn btn-secondary btn-sm" data-turnstile-action="edit" data-id="${t.id}">Editar</button>
        <button type="button" class="btn btn-danger btn-sm" data-turnstile-action="delete" data-id="${t.id}">Excluir</button>
      </td>
    </tr>
  `).join('');
}

function renderReaders() {
  const readers = state.readers || [];
  const tbody = document.getElementById('readersBody');
  if (!tbody) return;
  if (!readers.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Nenhum leitor cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = readers.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td><code>${escapeHtml(r.ip)}:${Number(r.port) || 80}</code></td>
      <td>${escapeHtml(DIRECTION_LABELS[r.direction] || r.direction)}</td>
      <td>${escapeHtml(r.turnstile_name || 'Padrão do sistema')}</td>
      <td><span class="badge ${r.active ? 'badge-active' : 'badge-inactive'}">${r.active ? 'Ativo' : 'Inativo'}</span></td>
      <td class="inline-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-reader-action="test" data-id="${r.id}">Testar</button>
        <button type="button" class="btn btn-secondary btn-sm" data-reader-action="edit" data-id="${r.id}">Editar</button>
        <button type="button" class="btn btn-danger btn-sm" data-reader-action="delete" data-id="${r.id}">Excluir</button>
      </td>
    </tr>
  `).join('');
}

async function loadDevices() {
  const [tRes, rRes] = await Promise.all([
    api('/api/devices/turnstiles'),
    api('/api/devices/readers'),
  ]);
  state.turnstiles = tRes.items || [];
  state.readers = rRes.items || [];
  renderTurnstiles();
  renderReaders();
}

// --- Cadastro em etapas (Wizard) & Submits ---
let memberWizardStep = 1;

function updateMemberWizardSummaries() {
  const name = document.getElementById('mName').value.trim();
  const modSelect = document.getElementById('mModality');
  const planSelect = document.getElementById('mPlan');
  const modName = modSelect.selectedOptions[0]?.textContent || '';
  const plan = state.plans.find((p) => String(p.id) === String(planSelect.value));

  const step2Name = document.getElementById('mStep2NameLabel');
  if (step2Name) {
    step2Name.innerHTML = `<strong>Aluno:</strong> ${escapeHtml(name || '—')}`;
  }

  const partnerProvider = document.getElementById('mPartnerProvider')?.value || '';
  const selectionText = [
    modSelect.value ? `<strong>Modalidade:</strong> ${escapeHtml(modName)}` : '<strong>Modalidade:</strong> Não selecionada',
    partnerProvider
      ? `<strong>Convênio:</strong> ${escapeHtml(partnerProvider === 'wellhub' ? 'Wellhub (Gympass)' : 'TotalPass')}`
      : plan
        ? `<strong>Plano:</strong> ${escapeHtml(plan.name)} (${fmtMoney(plan.price_cents)})`
        : '<strong>Plano:</strong> Sem plano contratado (bloqueado para entrar)',
  ].join(' · ');

  const step3Summary = document.getElementById('mStep3Summary');
  if (step3Summary) step3Summary.innerHTML = selectionText;

  const step4Summary = document.getElementById('mStep4Summary');
  if (step4Summary) {
    step4Summary.innerHTML = `<strong>Aluno:</strong> ${escapeHtml(name || '—')} · ${selectionText}`;
  }

  const classSelect = document.getElementById('mClass');
  const classHint = document.getElementById('mClassHint');
  if (classHint) {
    classHint.textContent = classSelect.disabled
      ? 'Nenhuma turma cadastrada para esta modalidade — você pode avançar para o pagamento normalmente.'
      : 'Selecione uma turma abaixo ou avance sem turma vinculada.';
  }
}

function setMemberWizardStep(step) {
  memberWizardStep = step;
  for (let i = 1; i <= 4; i += 1) {
    document.getElementById(`memberStep${i}`)?.classList.toggle('hidden', i !== step);
  }
  document.querySelectorAll('#memberWizardSteps .wizard-step').forEach((el) => {
    const s = Number(el.dataset.wizardStep);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });
  updateMemberWizardSummaries();
  if (step === 1) document.getElementById('mName')?.focus();
  if (step === 2) document.getElementById('mDoc')?.focus();
  if (step === 4) document.getElementById('mClass')?.focus();
}

function setMemberPartnerProvider(provider) {
  const clean = provider || '';
  const input = document.getElementById('mPartnerProvider');
  if (input) input.value = clean;
  document.querySelectorAll('#memberPartnerPills [data-partner]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.partner === clean);
  });
  document.getElementById('mWellhubBox')?.classList.toggle('hidden', clean !== 'wellhub');
  document.getElementById('mTotalpassNote')?.classList.toggle('hidden', clean !== 'totalpass');
  document.getElementById('memberPlanPicker')?.classList.toggle('hidden', Boolean(clean));
  const submitBtn = document.getElementById('btnMemberSubmit');
  if (submitBtn) {
    submitBtn.textContent = clean ? 'Confirmar cadastro (Convênio)' : 'Confirmar e ir para pagamento';
  }
  updateMemberWizardSummaries();
}

document.getElementById('memberPartnerPills')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-partner]');
  if (!btn) return;
  setMemberPartnerProvider(btn.dataset.partner);
});

function resetMemberWizard() {
  const form = document.getElementById('memberForm');
  form?.reset();
  state.memberPickerModality = '';
  setMemberPartnerProvider('');
  setCpfFieldState(document.getElementById('mDoc'), document.getElementById('mDocFeedback'), 'neutral', '');
  const alertEl = document.getElementById('mNameCheckAlert');
  if (alertEl) {
    alertEl.classList.add('hidden');
    alertEl.classList.remove('is-error');
    alertEl.innerHTML = '';
  }
  renderClassOptions('mModality', 'mClass');
  renderMemberModalityPills();
  renderMemberPlanPicker();
  setMemberWizardStep(1);
}

async function verifyAndAdvanceMemberName() {
  const nameInput = document.getElementById('mName');
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Informe o nome completo do aluno.', true);
    nameInput.focus();
    return;
  }
  const alertEl = document.getElementById('mNameCheckAlert');
  const btn = document.getElementById('btnMemberStep1Next');
  await withLoading(btn, async () => {
    try {
      const check = await api(`/api/members/check-name?name=${encodeURIComponent(name)}`);
      if (!check.exactMatch) {
        alertEl.classList.add('hidden');
        setMemberWizardStep(2);
        return;
      }
      alertEl.classList.remove('hidden');
      alertEl.classList.add('is-error');
      const listItems = check.matches
        .map(
          (m) =>
            `<li><strong>${escapeHtml(m.name)}</strong> (#${m.id}${m.document ? ` · CPF ${escapeHtml(m.document)}` : ''}) ` +
            `<button type="button" class="btn btn-secondary btn-sm" data-open-existing="${escapeHtml(m.name)}">Ver na lista</button></li>`,
        )
        .join('');
      alertEl.innerHTML = `<strong>Já existe um cadastro com este nome:</strong><ul>${listItems}</ul><span class="muted">Altere o nome ou abra o cadastro existente.</span>`;
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

document.getElementById('mName').addEventListener('input', () => {
  const alertEl = document.getElementById('mNameCheckAlert');
  alertEl.classList.add('hidden');
  alertEl.classList.remove('is-error');
});

document.getElementById('mName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && memberWizardStep === 1) {
    e.preventDefault();
    verifyAndAdvanceMemberName(false);
  }
});

document.getElementById('btnMemberStep1Next').addEventListener('click', () => verifyAndAdvanceMemberName(false));

document.getElementById('mNameCheckAlert').addEventListener('click', (e) => {
  const openBtn = e.target.closest('button[data-open-existing]');
  if (openBtn) {
    document.getElementById('memberSearch').value = openBtn.dataset.openExisting;
    state.memberFilter = 'all';
    state.memberLimit = 50;
    updateMemberFilterChips();
    renderMembersTable();
    setMemberFormOpen(false);
    return;
  }
  if (e.target.closest('button[data-force-name]')) {
    verifyAndAdvanceMemberName(true);
  }
});

document.getElementById('btnMemberStep2Back').addEventListener('click', () => setMemberWizardStep(1));
document.getElementById('btnMemberStep2Next').addEventListener('click', async () => {
  const cpfCheck = await validateCpfField('mDoc', 'mDocFeedback', {
    excludeId: 0,
    remoteCheck: true,
    showEmptyError: true,
  });
  if (!cpfCheck.valid) {
    showToast(cpfCheck.message, true);
    document.getElementById('mDoc').focus();
    return;
  }
  setMemberWizardStep(3);
});
document.getElementById('btnMemberStep3Back').addEventListener('click', () => setMemberWizardStep(2));
document.getElementById('btnMemberStep3Next').addEventListener('click', () => {
  const partnerProvider = document.getElementById('mPartnerProvider')?.value || '';
  const wellhubId = document.getElementById('mWellhubId')?.value.trim() || '';
  if (partnerProvider === 'wellhub' && !wellhubId) {
    showToast('Informe o ID do Wellhub (Gympass) para continuar.', true);
    document.getElementById('mWellhubId')?.focus();
    return;
  }
  renderClassOptions('mModality', 'mClass');
  setMemberWizardStep(4);
});
document.getElementById('btnMemberStep4Back').addEventListener('click', () => setMemberWizardStep(3));

document.getElementById('memberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (memberWizardStep !== 4) return;
  const partnerProvider = document.getElementById('mPartnerProvider')?.value || null;
  const wellhubId = document.getElementById('mWellhubId')?.value.trim() || null;
  await withLoading(e.target, async () => {
    try {
      const created = await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('mName').value.trim(),
          document: document.getElementById('mDoc').value,
          birth_date: document.getElementById('mBirth').value || null,
          sex: document.getElementById('mSex').value || null,
          phone: document.getElementById('mPhone').value,
          modality_id: document.getElementById('mModality').value || null,
          class_id: document.getElementById('mClass').value || null,
          plan_id: partnerProvider ? null : (document.getElementById('mPlan').value || null),
          partner_provider: partnerProvider,
          wellhub_id: partnerProvider === 'wellhub' ? wellhubId : null,
        }),
      });
      resetMemberWizard();
      setMemberFormOpen(false);
      await Promise.all([loadMembers(), loadDashboard(), loadGymStructure()]);
      if (partnerProvider) {
        showToast(`Aluno #${created.id} (${partnerProvider === 'wellhub' ? 'Wellhub' : 'TotalPass'}) cadastrado e ativo!`);
      } else if (!created.plan_id) {
        showToast(`Aluno #${created.id} cadastrado sem plano contratado (bloqueado para entrar).`);
      } else {
        showToast(`Aluno #${created.id} cadastrado! Avançando para o pagamento.`);
        await jumpToPaymentForMember(created);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('openCashForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/cash/open', {
        method: 'POST',
        body: JSON.stringify({
          staff_id: document.getElementById('openCashStaff').value || null,
          opening_cents: toCents(document.getElementById('openCashAmount').value),
          notes: document.getElementById('openCashNotes').value,
        }),
      });
      showToast('Caixa aberto!');
      await loadCash().catch(() => {
        showToast('Caixa aberto. Recarregue a página se os dados do turno não aparecerem.', true);
      });
      await resumeBillingAfterOpening();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('cashMovementForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/cash/movement', {
        method: 'POST',
        body: JSON.stringify({
          type: document.getElementById('movType').value,
          amount_cents: toCents(document.getElementById('movAmount').value),
          description: document.getElementById('movDesc').value,
        }),
      });
      e.target.reset();
      showToast('Movimentação registrada!');
      await loadCash();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('closeCashForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!window.confirm('Confirma o encerramento do turno e fechamento do caixa?')) return;
  await withLoading(e.target, async () => {
    try {
      await api('/api/cash/close', {
        method: 'POST',
        body: JSON.stringify({
          closing_cents: toCents(document.getElementById('closeCashAmount').value),
          notes: document.getElementById('closeCashNotes').value,
        }),
      });
      e.target.reset();
      document.getElementById('closeCashDiff').classList.add('hidden');
      showToast('Caixa fechado!');
      await loadCash();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('paymentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const matched = resolveMemberFromInput(document.getElementById('pMemberSearch').value);
  const memberId = Number(document.getElementById('pMember').value) || matched?.id;
  if (!memberId) {
    showToast('Selecione um aluno na lista ou informe o CPF.', true);
    document.getElementById('pMemberSearch').focus();
    return;
  }
  const selectedPlanId = Number(document.getElementById('pPlan').value);
  if (!selectedPlanId) {
    const optionsPanel = document.getElementById('paymentOptions');
    if (optionsPanel) optionsPanel.open = true;
    showToast('Selecione o plano antes de registrar o pagamento.', true);
    document.getElementById('pPlan').focus();
    return;
  }
  await withLoading(e.target, async () => {
    try {
      const member = state.allMembers.find((entry) => entry.id === memberId);
      const charge = member?.next_charge;
      const splitActive = Boolean(document.getElementById('pSplitToggle')?.checked);
      const splitData = splitActive ? readSplitState() : null;
      const debtDueDate = splitActive ? (document.getElementById('pDebtDueDate')?.value || null) : null;
      const useCredit = Boolean(document.getElementById('pUseCredit')?.checked);
      const baseExpectedCents = charge?.amount ?? toCents(document.getElementById('pAmount').value);
      const creditUsedPreview = useCredit ? Math.min(Number(member?.credit_cents || 0), baseExpectedCents) : 0;
      const netExpectedCents = Math.max(0, baseExpectedCents - creditUsedPreview);
      const finalPaidCents = toCents(document.getElementById('billingAsideFinalAmount')?.value ?? (netExpectedCents / 100));

      let amountToSend = baseExpectedCents;
      let extraPayload = {};
      if (splitActive) {
        extraPayload = {
          split_payments: splitData.splitPayments,
          debt_cents: splitData.debtCents,
          debt_due_date: debtDueDate,
        };
      } else if (finalPaidCents > netExpectedCents) {
        const excessCents = finalPaidCents - netExpectedCents;
        const asCredit = document.getElementById('billingExcessAsCredit')?.checked ?? (state.billingExcessAsCredit !== false);
        if (asCredit) {
          extraPayload = { credit_excess_cents: excessCents };
        } else {
          amountToSend = finalPaidCents + creditUsedPreview;
        }
      } else if (finalPaidCents < netExpectedCents) {
        const lowerMode = document.querySelector('input[name="billingLowerMode"]:checked')?.value || state.billingLowerMode || 'discount';
        if (lowerMode === 'debt') {
          extraPayload = { debt_cents: netExpectedCents - finalPaidCents };
        } else {
          amountToSend = finalPaidCents + creditUsedPreview;
        }
      }

      const res = await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          member_id: memberId,
          plan_id: Number(document.getElementById('pPlan').value) || null,
          amount_cents: amountToSend,
          ...(charge ? { charge_id: charge.id } : {}),
          method: document.getElementById('pMethod').value,
          use_credit: useCredit,
          ...extraPayload,
        }),
      });
      state.billingFinalAmountEdited = false;
      const debtMsg = res.debt ? ` (Saldo pendente / fiado registrado: ${fmtMoney(res.debt.amount_cents)})` : '';
      showToast(
        res.sync?.synced
          ? `Pagamento registrado.${debtMsg}`
          : `Pagamento registrado.${debtMsg} Aviso da catraca: ${res.sync?.error || ''}`,
        !res.sync?.synced,
      );
      if (splitActive) {
        document.getElementById('pSplitToggle').checked = false;
        resetSplitBox();
      }
      if (!charge) {
        document.getElementById('pMemberSearch').value = '';
        document.getElementById('pMember').value = '';
        document.getElementById('whatsappCheckoutBox').classList.add('hidden');
      }
      await Promise.all([loadPayments(), loadOpenDebts(), loadMembers(), loadDashboard(), tabRequests.has('cash') ? loadCash() : loadCurrentCash()]).catch(() => {
        showToast('Pagamento gravado. Recarregue a página para atualizar os dados.', true);
      });
      if (isAutoPrintReceiptEnabled() && res.payment) {
        openPaymentReceipt(res.payment, member);
      }
    } catch (err) {
      if (err.code === 'CASH_CLOSED') await openCashFromBilling();
      else showToast(err.message, true);
    }
  });
  renderBillingSummary();
});

function resetPlanForm() {
  const form = document.getElementById('planForm');
  form.reset();
  document.getElementById('plEditId').value = '';
  document.getElementById('btnSavePlan').textContent = 'Criar plano';
  document.getElementById('btnCancelPlanEdit').classList.add('hidden');
}

document.getElementById('btnCancelPlanEdit').addEventListener('click', resetPlanForm);

document.getElementById('plansList').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-plan]');
  if (editBtn) {
    const plan = state.plans.find((p) => Number(p.id) === Number(editBtn.dataset.editPlan));
    if (!plan) return;
    document.getElementById('plEditId').value = plan.id;
    document.getElementById('plName').value = plan.name;
    document.getElementById('plDays').value = plan.duration_days;
    document.getElementById('plPrice').value = (Number(plan.price_cents || 0) / 100).toFixed(2);
    if (document.getElementById('plStartTime')) document.getElementById('plStartTime').value = plan.allowed_start_time || '';
    if (document.getElementById('plEndTime')) document.getElementById('plEndTime').value = plan.allowed_end_time || '';
    if (document.getElementById('plWeeklyLimit')) document.getElementById('plWeeklyLimit').value = plan.weekly_limit || '';
    const periodSel = document.getElementById('plPeriod');
    const matchedOpt = [...periodSel.options].find((o) => Number(o.value) === Number(plan.duration_days));
    periodSel.value = matchedOpt ? matchedOpt.value : '';
    document.getElementById('btnSavePlan').textContent = 'Salvar alterações';
    document.getElementById('btnCancelPlanEdit').classList.remove('hidden');
    document.getElementById('plName').focus();
    return;
  }

  const delBtn = e.target.closest('[data-delete-plan]');
  if (delBtn) {
    const planId = Number(delBtn.dataset.deletePlan);
    const plan = state.plans.find((p) => Number(p.id) === planId);
    if (!confirm(`Excluir o plano "${plan?.name || planId}"?`)) return;
    try {
      await api(`/api/plans/${planId}`, { method: 'DELETE' });
      if (Number(document.getElementById('plEditId').value) === planId) resetPlanForm();
      showToast('Plano excluído!');
      await loadPlans();
    } catch (err) {
      showToast(err.message, true);
    }
  }
});

document.getElementById('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      const editId = document.getElementById('plEditId').value.trim();
      const payload = {
        name: document.getElementById('plName').value,
        duration_days: Number(document.getElementById('plDays').value),
        price_cents: toCents(document.getElementById('plPrice').value),
        allowed_start_time: document.getElementById('plStartTime')?.value || null,
        allowed_end_time: document.getElementById('plEndTime')?.value || null,
        weekly_limit: document.getElementById('plWeeklyLimit')?.value ? Number(document.getElementById('plWeeklyLimit').value) : null,
      };
      if (editId) {
        await api(`/api/plans/${editId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showToast('Plano atualizado!');
      } else {
        await api('/api/plans', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast('Plano criado!');
      }
      resetPlanForm();
      await loadPlans();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('saleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const memberText = document.getElementById('saleMemberSearch').value.trim();
  const matched = memberText ? resolveMemberFromInput(memberText) : null;
  if (memberText && !matched) {
    showToast('Selecione um aluno na lista ou deixe o campo vazio para venda avulsa.', true);
    return;
  }
  await withLoading(e.target, async () => {
    try {
      const saleRes = await api('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          product_id: Number(document.getElementById('saleProduct').value),
          member_id: matched ? matched.id : null,
          quantity: Number(document.getElementById('saleQty').value),
          method: document.getElementById('saleMethod').value,
        }),
      });
      showToast('Venda realizada!');
      document.getElementById('saleMemberSearch').value = '';
      document.getElementById('saleQty').value = '1';
      await Promise.all([loadProducts(), tabRequests.has('cash') ? loadCash() : loadCurrentCash(), loadDashboard()]).catch(() => {
        showToast('Venda gravada. Recarregue a página para atualizar os dados.', true);
      });
      if (isAutoPrintReceiptEnabled() && saleRes) {
        openSaleReceipt(saleRes, matched);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('prodName').value,
          category: document.getElementById('prodCategory').value,
          price_cents: toCents(document.getElementById('prodPrice').value),
          stock: Number(document.getElementById('prodStock').value),
        }),
      });
      e.target.reset();
      showToast('Produto cadastrado!');
      await loadProducts();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function resetModalityForm() {
  document.getElementById('modalityForm').reset();
  document.getElementById('modEditId').value = '';
  document.getElementById('modSubmitBtn').textContent = 'Adicionar';
  document.getElementById('modCancelEdit').classList.add('hidden');
}

document.getElementById('modCancelEdit').addEventListener('click', () => {
  resetModalityForm();
});

document.getElementById('modalityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('modEditId').value;
  await withLoading(e.target, async () => {
    try {
      await api(editId ? `/api/modalities/${editId}` : '/api/modalities', {
        method: editId ? 'PUT' : 'POST',
        body: JSON.stringify({
          name: document.getElementById('modName').value,
          description: document.getElementById('modDesc').value,
        }),
      });
      resetModalityForm();
      showToast(editId ? 'Modalidade atualizada!' : 'Modalidade adicionada!');
      await Promise.all([loadGymStructure(), loadPlans()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('modalitiesList').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('button[data-edit-modality]');
  if (editBtn) {
    const mod = state.modalities.find((m) => String(m.id) === String(editBtn.dataset.editModality));
    if (!mod) return;
    document.getElementById('modEditId').value = mod.id;
    document.getElementById('modName').value = mod.name;
    document.getElementById('modDesc').value = mod.description || '';
    document.getElementById('modSubmitBtn').textContent = 'Salvar';
    document.getElementById('modCancelEdit').classList.remove('hidden');
    document.getElementById('modName').focus();
    return;
  }

  const deleteBtn = e.target.closest('button[data-delete-modality]');
  if (!deleteBtn) return;
  const mod = state.modalities.find((m) => String(m.id) === String(deleteBtn.dataset.deleteModality));
  if (!mod) return;
  if (!window.confirm(`Apagar a modalidade "${mod.name}"? Turmas e alunos vinculados ficarão sem esta modalidade.`)) {
    return;
  }
  await withLoading(deleteBtn, async () => {
    try {
      await api(`/api/modalities/${mod.id}`, { method: 'DELETE' });
      if (String(document.getElementById('modEditId').value) === String(mod.id)) {
        resetModalityForm();
      }
      showToast('Modalidade apagada!');
      await Promise.all([loadGymStructure(), loadPlans(), loadMembers()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('instructorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      const instructor = await api('/api/instructors', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('instName').value,
          phone: document.getElementById('instPhone').value,
          specialty: document.getElementById('instSpec').value,
        }),
      });
      e.target.reset();
      showToast(`Professor #${instructor.id} cadastrado.`);
      await loadGymStructure();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('classForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/classes', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('clsName').value,
          modality_id: document.getElementById('clsModality').value || null,
          instructor_id: document.getElementById('clsInstructor').value || null,
          schedule: document.getElementById('clsSchedule').value,
          capacity: Number(document.getElementById('clsCap').value),
        }),
      });
      e.target.reset();
      showToast('Turma criada!');
      await loadGymStructure();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('staffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cpfCheck = await validateCpfField('stDoc', 'stDocFeedback', {
    excludeId: 0,
    remoteCheck: true,
    showEmptyError: true,
  });
  if (!cpfCheck.valid) {
    showToast(cpfCheck.message, true);
    document.getElementById('stDoc').focus();
    return;
  }
  await withLoading(e.target, async () => {
    try {
      const staff = await api('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('stName').value,
          access_role: document.getElementById('stRole').value,
          phone: document.getElementById('stPhone').value,
          document: document.getElementById('stDoc').value,
          birth_date: document.getElementById('stBirth').value || null,
          sex: document.getElementById('stSex').value || null,
        }),
      });
      e.target.reset();
      setCpfFieldState(document.getElementById('stDoc'), document.getElementById('stDocFeedback'), 'neutral', '');
      showToast(`Integrante #${staff.id} cadastrado. Adicione a foto para usar o FaceID.`);
      await Promise.all([loadMembers(), loadDashboard()]);
      if (state.activeTab === 'staff') openFaceModal(staff.id, staff.name);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

let waPollTimer = null;
let waPollResumeOnVisible = false;

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && waPollResumeOnVisible && state.activeTab === 'settings') {
    waPollResumeOnVisible = false;
    loadWhatsappStatus().catch(() => {});
  }
});

function renderWhatsappStatus(st) {
  const badge = document.getElementById('waStatusBadge');
  const phoneInfo = document.getElementById('waPhoneInfo');
  const qrBox = document.getElementById('waQrBox');
  const qrImg = document.getElementById('waQrImg');
  const btnConnect = document.getElementById('btnWaConnect');
  const btnDisconnect = document.getElementById('btnWaDisconnect');

  const labels = {
    disconnected: ['Desconectado', 'badge-neutral'],
    connecting: ['Conectando...', 'badge-pending'],
    qr: ['Aguardando QR Code', 'badge-pending'],
    connected: ['Conectado', 'badge-active'],
  };
  const [label, cls] = labels[st.status] || labels.disconnected;
  badge.textContent = label;
  badge.className = `badge ${cls}`;
  phoneInfo.textContent = st.phone ? `(${st.phone})` : st.lastError ? `— ${st.lastError}` : '';
  document.getElementById('waDailyCounter').textContent = `${st.sentToday} / ${st.dailyLimit}`;
  document.getElementById('waQueueCounter').textContent = String(st.queueLength);

  if (st.status === 'qr' && st.qrDataUrl) {
    qrImg.src = st.qrDataUrl;
    qrBox.classList.remove('hidden');
  } else {
    qrBox.classList.add('hidden');
  }

  btnConnect.classList.toggle('hidden', st.status === 'connected');
  btnDisconnect.classList.toggle('hidden', st.status === 'disconnected');

  if (waPollTimer) {
    clearTimeout(waPollTimer);
    waPollTimer = null;
  }
  const shouldPollWa = (st.status === 'qr' || st.status === 'connecting') && state.activeTab === 'settings';
  waPollResumeOnVisible = shouldPollWa && document.hidden;
  if (shouldPollWa && !document.hidden) {
    waPollTimer = setTimeout(() => {
      if (document.hidden) {
        waPollResumeOnVisible = state.activeTab === 'settings';
        return;
      }
      loadWhatsappStatus().catch(() => {
        if (state.activeTab === 'settings' && !document.hidden) {
          waPollTimer = setTimeout(() => loadWhatsappStatus().catch(() => {}), 5000);
        }
      });
    }, 3000);
  }
}

async function loadWhatsappStatus() {
  const [st, logs] = await Promise.all([api('/api/whatsapp/status'), api('/api/whatsapp/logs?limit=25')]);
  renderWhatsappStatus(st);
  const kindLabels = {
    payment: 'Pagamento',
    due_reminder: 'Vencimento',
    inactive: 'Retorno (ausente)',
    test: 'Teste',
    manual: 'Manual',
  };
  document.getElementById('waLogsBody').innerHTML = logs.length
    ? logs
        .map(
          (l) => `<tr>
            <td>${escapeHtml(l.sent_at || l.created_at || '-')}</td>
            <td>${escapeHtml(l.member_name || l.phone)}</td>
            <td>${escapeHtml(kindLabels[l.kind] || l.kind)}</td>
            <td><span class="badge ${l.status === 'sent' ? 'badge-active' : l.status === 'queued' ? 'badge-pending' : 'badge-blocked'}" title="${escapeHtml(l.error || '')}">${escapeHtml(l.status)}</span></td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="empty-cell">Nenhum envio registrado.</td></tr>';
}

document.getElementById('btnWaConnect').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const st = await api('/api/whatsapp/connect', { method: 'POST' });
      renderWhatsappStatus(st);
      showToast('Iniciando conexão WhatsApp...');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnWaDisconnect').addEventListener('click', async (e) => {
  if (!window.confirm('Desconectar a sessão do WhatsApp? Será necessário ler o QR Code novamente.')) return;
  await withLoading(e.currentTarget, async () => {
    try {
      const st = await api('/api/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({ clearSession: true }) });
      renderWhatsappStatus(st);
      showToast('WhatsApp desconectado.');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnWaRefresh').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await loadWhatsappStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnWaRunNow').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/whatsapp/run-campaigns', { method: 'POST', body: JSON.stringify({ ignoreWindow: true }) });
      if (res.skippedReason === 'disabled') {
        showToast('Ative os envios automáticos e salve antes de executar.', true);
      } else {
        showToast(`Na fila: ${res.dueQueued} vencimento(s) e ${res.inactiveQueued} retorno(s).`);
      }
      await loadWhatsappStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnWaTest').addEventListener('click', async (e) => {
  const phone = document.getElementById('waTestPhone').value.trim();
  if (!phone) {
    showToast('Informe um número para teste.', true);
    return;
  }
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/whatsapp/test', {
        method: 'POST',
        body: JSON.stringify({ phone, message: 'Teste de conexão WhatsApp - Sistema Academia' }),
      });
      showToast('Mensagem de teste enviada!');
      await loadWhatsappStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('whatsappForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          whatsapp_enabled: document.getElementById('waEnabled').checked ? '1' : '0',
          whatsapp_notify_payment: document.getElementById('waNotifyPayment').checked ? '1' : '0',
          whatsapp_notify_due: document.getElementById('waNotifyDue').checked ? '1' : '0',
          whatsapp_notify_inactive: document.getElementById('waNotifyInactive').checked ? '1' : '0',
          whatsapp_notify_welcome: document.getElementById('waNotifyWelcome')?.checked ? '1' : '0',
          whatsapp_notify_workout_review: document.getElementById('waNotifyWorkoutReview')?.checked ? '1' : '0',
          whatsapp_notify_winback: document.getElementById('waNotifyWinback')?.checked ? '1' : '0',
          whatsapp_notify_class_reminder: document.getElementById('waNotifyClassReminder')?.checked ? '1' : '0',
          whatsapp_notify_waitlist: document.getElementById('waNotifyWaitlist')?.checked ? '1' : '0',
          whatsapp_due_days_before: document.getElementById('waDueDays').value,
          whatsapp_inactive_days: document.getElementById('waInactiveDays').value,
          whatsapp_daily_limit: document.getElementById('waDailyLimit').value,
          whatsapp_min_delay_sec: document.getElementById('waMinDelay').value,
          whatsapp_window_start: document.getElementById('waWindowStart').value,
          whatsapp_window_end: document.getElementById('waWindowEnd').value,
          whatsapp_tpl_payment: document.getElementById('waTplPayment').value,
          whatsapp_tpl_due: document.getElementById('waTplDue').value,
          whatsapp_tpl_inactive: document.getElementById('waTplInactive').value,
          whatsapp_receipt_enabled: document.getElementById('waReceiptEnabled').checked ? '1' : '0',
          gemini_api_key: document.getElementById('waGeminiKey').value,
          gemini_model: document.getElementById('waGeminiModel').value.trim() || 'gemini-3.8-flash',
          pix_recipient_name: document.getElementById('waPixName').value,
          pix_recipient_key: document.getElementById('waPixKey').value,
        }),
      });
      showToast('Regras do WhatsApp salvas!');
      await loadWhatsappStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadReceipts() {
  const queue = document.getElementById('receiptsQueue');
  if (!queue) return;
  const receipts = await api('/api/receipts?limit=20');
  if (!receipts.length) {
    queue.innerHTML = '<div class="muted">Nenhum comprovante lido recentemente.</div>';
    return;
  }
  const statusMap = {
    pending: ['Pendente', 'badge-pending'],
    approved: ['Baixado', 'badge-active'],
    rejected: ['Rejeitado', 'badge-neutral'],
    duplicate: ['Duplicado', 'badge-blocked'],
  };
  queue.innerHTML = receipts
    .map((r) => {
      const [label, cls] = statusMap[r.status] || statusMap.pending;
      const canAct = r.status === 'pending';
      const linkedMember = state.allMembers.find((member) => member.id === r.member_id);
      const memberDisplay = linkedMember ? memberLabel(linkedMember) : '';
      return `
        <div class="billing-member" style="flex-direction: column; align-items: stretch; cursor: default;" data-receipt-id="${r.id}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div>
              <strong>${r.amount_cents ? fmtMoney(r.amount_cents) : 'Valor não identificado'}</strong>
              <span class="badge ${cls}">${label}</span>
              ${r.confidence ? `<span class="muted">IA: ${r.confidence}%</span>` : ''}
            </div>
            <span class="muted">${escapeHtml(r.source === 'whatsapp' ? `WhatsApp (${r.sender_phone || '-'})` : 'Upload')} · ${escapeHtml(r.created_at)}</span>
          </div>
          <div class="muted" style="font-size:12px;">
            Pagador: ${escapeHtml(r.payer_name || '-')} · Recebedor: ${escapeHtml(r.recipient_name || '-')} ${r.transaction_id ? `· ID: ${escapeHtml(r.transaction_id)}` : ''}
          </div>
          ${r.reject_reason ? `<div class="text-danger" style="font-size:12px;">${escapeHtml(r.reject_reason)}</div>` : ''}
          ${
            canAct
              ? `<div class="inline-actions" style="margin-top:6px;">
                  <input type="search" class="receipt-member-input" list="membersDatalist" value="${escapeHtml(memberDisplay)}" placeholder="Vincular aluno..." style="flex:1;min-width:180px;" />
                  <button type="button" class="btn btn-success btn-sm" data-approve-receipt="${r.id}">Confirmar baixa (Pix)</button>
                  <button type="button" class="btn btn-secondary btn-sm" data-reject-receipt="${r.id}">Rejeitar</button>
                </div>`
              : ''
          }
        </div>`;
    })
    .join('');
}

document.getElementById('btnRefreshReceipts')?.addEventListener('click', () => loadReceipts().catch((e) => showToast(e.message, true)));
for (const eventName of ['focusin', 'input']) {
  document.getElementById('receiptsQueue').addEventListener(eventName, (event) => {
    if (event.target.matches('.receipt-member-input')) populateMemberDatalist(event.target.value);
  });
}

document.getElementById('btnAnalyzeReceipt')?.addEventListener('click', async (e) => {
  const input = document.getElementById('receiptFileInput');
  const file = input?.files?.[0];
  if (!file) {
    showToast('Selecione uma imagem ou PDF do comprovante.', true);
    return;
  }
  await withLoading(e.currentTarget, async () => {
    try {
      const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Falha ao ler arquivo.'));
        reader.readAsDataURL(file);
      });
      await api('/api/receipts/analyze', {
        method: 'POST',
        body: JSON.stringify({ base64Data, mimeType: file.type || 'image/jpeg' }),
      });
      input.value = '';
      showToast('Comprovante analisado pela IA!');
      await Promise.all([loadReceipts(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('receiptsQueue')?.addEventListener('click', async (e) => {
  const approveBtn = e.target.closest('button[data-approve-receipt]');
  if (approveBtn) {
    const card = approveBtn.closest('[data-receipt-id]');
    const memberText = card.querySelector('.receipt-member-input')?.value || '';
    const member = resolveMemberFromInput(memberText);
    if (!member || !window.confirm(`Confirmar a baixa do comprovante para ${member.name} (#${member.id}) após conferir o crédito no banco?`)) {
      if (!member) showToast('Selecione o aluno pelo CPF ou escolha na lista.', true);
      return;
    }
    await withLoading(approveBtn, async () => {
      try {
        await api(`/api/receipts/${approveBtn.dataset.approveReceipt}/approve`, {
          method: 'POST',
          body: JSON.stringify({ member_id: member?.id || null, method: 'pix' }),
        });
        showToast('Baixa confirmada no caixa!');
        await Promise.all([loadReceipts(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
      } catch (err) {
        if (err.code === 'CASH_CLOSED') await openCashFromBilling();
        else showToast(err.message, true);
      }
    });
    return;
  }

  const rejectBtn = e.target.closest('button[data-reject-receipt]');
  if (rejectBtn) {
    await withLoading(rejectBtn, async () => {
      try {
        await api(`/api/receipts/${rejectBtn.dataset.rejectReceipt}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Rejeitado pela recepção' }),
        });
        showToast('Comprovante rejeitado.');
        await loadReceipts();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

let activePixChargeId = null;

document.getElementById('btnCreateWhatsAppCheckout').addEventListener('click', (event) => withLoading(event.currentTarget, async () => {
  const member_id = Number(document.getElementById('pMember').value);
  const box = document.getElementById('whatsappCheckoutBox');
  box.classList.add('hidden');
  if (!member_id) {
    showToast('Selecione o aluno primeiro.', true);
    document.getElementById('pMemberSearch').focus();
    return;
  }
  try {
    const { charge, whatsapp_url } = await api('/api/gateways/mp/whatsapp-checkout', {
      method: 'POST', body: JSON.stringify({ member_id }),
    });
    if (member_id !== Number(document.getElementById('pMember').value)) return;
    const url = new URL(whatsapp_url);
    if (url.origin !== 'https://wa.me') throw new Error('Link do WhatsApp inválido.');
    document.getElementById('whatsappCheckoutAmount').textContent = `${charge.member_name || document.getElementById('pMemberSearch').value} · ${fmtMoney(charge.amount_cents)}`;
    document.getElementById('whatsappCheckoutLink').href = url.href;
    box.classList.remove('hidden');
    await loadGatewayCharges();
  } catch (err) {
    showToast(err.message, true);
  }
}));

function renderPixChargeBox(charge) {
  const box = document.getElementById('pixChargeBox');
  if (!charge) {
    activePixChargeId = null;
    box.classList.add('hidden');
    return;
  }
  activePixChargeId = charge.id;
  const img = document.getElementById('pixQrImg');
  const qrSrc = sanitizeQrImageSrc(charge.qr_base64);
  if (qrSrc) {
    img.src = qrSrc;
    img.classList.remove('hidden');
  } else {
    img.src = '';
    img.classList.add('hidden');
  }
  document.getElementById('pixCopyInput').value = charge.qr_code || charge.payment_url || '';
  document.getElementById('pixChargeStatus').textContent =
    charge.status === 'paid'
      ? 'Pagamento confirmado (Mercado Pago)!'
      : `Aguardando pagamento de ${fmtMoney(charge.amount_cents)} via Mercado Pago.`;
  box.classList.remove('hidden');
}

async function loadGatewayCharges() {
  const container = document.getElementById('pixChargesList');
  if (!container) return;
  const charges = await api('/api/gateways/charges?limit=15');
  if (!charges.length) {
    container.innerHTML = '<div class="muted">Nenhuma cobrança online gerada ainda.</div>';
    return;
  }
  container.innerHTML = charges
    .map(
      (c) => `
      <div class="billing-member" style="cursor:default;">
        <div>
          <strong>${escapeHtml(c.member_name)}</strong> · ${fmtMoney(c.amount_cents)}
          <span class="badge ${c.status === 'paid' ? 'badge-active' : 'badge-pending'}">${c.status === 'paid' ? 'Pago' : 'Pendente'}</span>
          <div class="muted" style="font-size:12px;">${c.checkout_ref ? 'Checkout Mercado Pago' : 'Pix Mercado Pago'} · ${escapeHtml(c.created_at)}</div>
        </div>
        ${
          c.status === 'pending'
            ? `<button type="button" class="btn btn-success btn-sm" data-check-charge="${c.id}">Verificar</button>`
            : ''
        }
      </div>`,
    )
    .join('');
}

let paymentPollTimer = null;
let paymentPollDeadline = 0;

function stopPaymentAutoPoll() {
  if (paymentPollTimer) {
    clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
  }
  paymentPollDeadline = 0;
}

function startPaymentAutoPoll({ type, id }) {
  stopPaymentAutoPoll();
  if (!id) return;
  paymentPollDeadline = Date.now() + 2 * 60 * 1000;

  const tick = async () => {
    paymentPollTimer = null;
    if (Date.now() > paymentPollDeadline || state.activeTab !== 'billing') {
      stopPaymentAutoPoll();
      return;
    }
    try {
      if (type === 'pix') {
        const res = await api(`/api/gateways/charges/${id}/check`, { method: 'POST' });
        if (res.paid) {
          stopPaymentAutoPoll();
          if (activePixChargeId === Number(id) && res.charge) renderPixChargeBox(res.charge);
          showToast('Pix confirmado e mensalidade baixada!');
          await Promise.all([loadGatewayCharges(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
          if (res.payment) openPaymentReceipt(res.payment);
          return;
        }
      } else if (type === 'point') {
        const res = await api(`/api/gateways/mp/point-orders/${id}/check`, { method: 'POST' });
        if (res.paid) {
          stopPaymentAutoPoll();
          showToast('Pagamento na Point Smart confirmado e baixado!');
          await Promise.all([loadPointOrders(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
          if (res.payment) openPaymentReceipt(res.payment);
          return;
        }
        if (['canceled', 'failed', 'expired'].includes(res.status)) {
          stopPaymentAutoPoll();
          await loadPointOrders().catch(() => {});
          return;
        }
      }
    } catch {
      // Transient error during background polling; retry until deadline.
    }
    if (Date.now() <= paymentPollDeadline && state.activeTab === 'billing') {
      paymentPollTimer = setTimeout(tick, 3000);
    }
  };

  paymentPollTimer = setTimeout(tick, 3000);
}

document.getElementById('btnGeneratePix')?.addEventListener('click', async (e) => {
  const memberId = document.getElementById('pMember').value;
  if (!memberId) {
    showToast('Selecione o aluno primeiro.', true);
    document.getElementById('pMemberSearch').focus();
    return;
  }
  const amountCents = toCents(document.getElementById('pAmount').value);
  const planId = document.getElementById('pPlan').value || null;

  await withLoading(e.currentTarget, async () => {
    try {
      const charge = await api('/api/gateways/charges', {
        method: 'POST',
        body: JSON.stringify({ member_id: memberId, plan_id: planId, amount_cents: amountCents }),
      });
      renderPixChargeBox(charge);
      showToast('QR Code Pix gerado!');
      await loadGatewayCharges();
      if (charge?.id) startPaymentAutoPoll({ type: 'pix', id: charge.id });
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnCopyPix')?.addEventListener('click', async () => {
  const val = document.getElementById('pixCopyInput').value;
  if (!val) return;
  try {
    await navigator.clipboard.writeText(val);
    showToast('Código Pix copiado!');
  } catch {
    document.getElementById('pixCopyInput').select();
    showToast('Selecione e copie o código Pix.');
  }
});

async function verifyPixChargeById(chargeId, triggerEl) {
  await withLoading(triggerEl, async () => {
    try {
      const res = await api(`/api/gateways/charges/${chargeId}/check`, { method: 'POST' });
      if (res.paid) {
        if (activePixChargeId === Number(chargeId) && res.charge) renderPixChargeBox(res.charge);
        showToast('Pix confirmado e mensalidade baixada!');
        await Promise.all([loadGatewayCharges(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
      } else {
        showToast('Pagamento ainda pendente.');
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

document.getElementById('btnCheckPixCharge')?.addEventListener('click', (e) => {
  if (activePixChargeId) verifyPixChargeById(activePixChargeId, e.currentTarget);
});

document.getElementById('pixChargesList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-check-charge]');
  if (btn) verifyPixChargeById(btn.dataset.checkCharge, btn);
});

function subFrequencyLabel(s) {
  if (s.frequency_type === 'days') {
    if (s.frequency === 7) return 'Semanal';
    if (s.frequency === 15) return 'Quinzenal';
    return `A cada ${s.frequency} dias`;
  }
  if (s.frequency === 1) return 'Mensal';
  if (s.frequency === 2) return 'Bimestral';
  if (s.frequency === 3) return 'Trimestral';
  if (s.frequency === 6) return 'Semestral';
  if (s.frequency === 12) return 'Anual';
  return `A cada ${s.frequency} meses`;
}

function subStatusBadge(status) {
  if (status === 'active') return '<span class="badge badge-active">Ativa</span>';
  if (status === 'canceled') return '<span class="badge badge-blocked">Cancelada</span>';
  if (status === 'paused') return '<span class="badge badge-pending">Pausada</span>';
  return '<span class="badge badge-pending">Aguardando autorização</span>';
}

async function loadMpSubscriptions() {
  const container = document.getElementById('mpSubscriptionsList');
  if (!container) return;
  const subs = await api('/api/gateways/mp/subscriptions?limit=30');
  if (!subs.length) {
    container.innerHTML = '<div class="muted">Nenhuma assinatura recorrente criada ainda.</div>';
    return;
  }
  container.innerHTML = subs
    .map(
      (s) => `
      <div class="billing-member" style="cursor:default;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${escapeHtml(s.member_name)}</strong> · ${fmtMoney(s.amount_cents)}
          ${subStatusBadge(s.status)}
          <div class="muted" style="font-size:12px;">
            ${escapeHtml(subFrequencyLabel(s))} · ${escapeHtml(s.payer_email || '-')}
          </div>
        </div>
        <div class="inline-actions">
          ${(() => {
            const safeUrl = s.status !== 'canceled' ? sanitizeHttpUrl(s.init_point) : '';
            return safeUrl
              ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">Abrir link</a>` +
                `<button type="button" class="btn btn-secondary btn-sm" data-copy-sub-link="${escapeHtml(safeUrl)}">Copiar link</button>`
              : '';
          })()}
          ${s.status !== 'canceled' ? `<button type="button" class="btn btn-success btn-sm" data-sync-sub="${s.id}">Sincronizar</button>` : ''}
          ${s.status !== 'canceled' ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-sub="${s.id}">Cancelar</button>` : ''}
        </div>
      </div>`,
    )
    .join('');
}

document.getElementById('btnRefreshSubscriptions')?.addEventListener('click', () => {
  loadMpSubscriptions().catch((err) => showToast(err.message, true));
});

document.getElementById('btnCreateSubscription')?.addEventListener('click', async (e) => {
  const memberId = document.getElementById('pMember').value;
  if (!memberId) {
    showToast('Selecione o aluno primeiro.', true);
    document.getElementById('pMemberSearch').focus();
    return;
  }
  const amountCents = toCents(document.getElementById('pAmount').value);
  const planId = document.getElementById('pPlan').value || null;
  const cycle = document.getElementById('subCycle').value;
  const payerEmail = document.getElementById('subPayerEmail').value.trim() || null;

  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/gateways/mp/subscriptions', {
        method: 'POST',
        body: JSON.stringify({
          member_id: memberId,
          plan_id: planId,
          amount_cents: amountCents,
          cycle,
          payer_email: payerEmail,
        }),
      });
      showToast('Assinatura criada! Envie o link para o aluno autorizar.');
      await loadMpSubscriptions();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('mpSubscriptionsList')?.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('button[data-copy-sub-link]');
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copySubLink);
      showToast('Link da assinatura copiado!');
    } catch {
      showToast('Não foi possível copiar automaticamente.', true);
    }
    return;
  }

  const syncBtn = e.target.closest('button[data-sync-sub]');
  if (syncBtn) {
    await withLoading(syncBtn, async () => {
      try {
        const res = await api(`/api/gateways/mp/subscriptions/${syncBtn.dataset.syncSub}/sync`, { method: 'POST' });
        if (res.settledCount > 0) {
          showToast(`${res.settledCount} pagamento(s) da assinatura baixado(s)!`);
          await Promise.all([loadMpSubscriptions(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
        } else {
          showToast('Assinatura sincronizada. Nenhum novo pagamento confirmado.');
          await loadMpSubscriptions();
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const cancelBtn = e.target.closest('button[data-cancel-sub]');
  if (cancelBtn) {
    if (!confirm('Cancelar esta assinatura recorrente no Mercado Pago?')) return;
    await withLoading(cancelBtn, async () => {
      try {
        await api(`/api/gateways/mp/subscriptions/${cancelBtn.dataset.cancelSub}`, { method: 'DELETE' });
        showToast('Assinatura cancelada.');
        await loadMpSubscriptions();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

document.getElementById('gatewaysForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      const settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          mp_access_token: document.getElementById('gwMpToken').value.trim(),
          mp_point_access_token: document.getElementById('gwMpPointToken').value.trim(),
          mp_webhook_secret: document.getElementById('gwMpWebhookSecret').value.trim(),
          mp_point_webhook_secret: document.getElementById('gwMpPointWebhookSecret').value.trim(),
          mp_point_terminal_id: document.getElementById('gwMpPointTerminalId').value.trim(),
        }),
      });
      document.getElementById('gwMpToken').value = settings.mp_access_token || '';
      document.getElementById('gwMpPointToken').value = settings.mp_point_access_token || '';
      document.getElementById('gwMpWebhookSecret').value = settings.mp_webhook_secret || '';
      document.getElementById('gwMpPointWebhookSecret').value = settings.mp_point_webhook_secret || '';
      showToast('Credenciais do Mercado Pago salvas!');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadPointOrders() {
  const container = document.getElementById('pointOrdersList');
  if (!container) return;
  const orders = await api('/api/gateways/mp/point-orders?limit=15');
  if (!orders.length) {
    container.innerHTML = '<div class="muted">Nenhuma cobrança enviada para a Point Smart ainda.</div>';
    return;
  }
  container.innerHTML = orders
    .map((o) => {
      const badge =
        o.status === 'paid'
          ? '<span class="badge badge-active">Pago</span>'
          : o.status === 'canceled' || o.status === 'expired' || o.status === 'failed'
            ? `<span class="badge badge-blocked">${escapeHtml(o.status)}</span>`
            : '<span class="badge badge-pending">Aguardando na máquina</span>';
      return `
      <div class="billing-member" style="cursor:default;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${escapeHtml(o.member_name)}</strong> · ${fmtMoney(o.amount_cents)} ${badge}
          <div class="muted" style="font-size:12px;">Terminal: ${escapeHtml(o.terminal_id)} · ${escapeHtml(o.created_at)}</div>
        </div>
        <div class="inline-actions">
          ${o.status === 'pending' ? `<button type="button" class="btn btn-success btn-sm" data-check-point="${o.id}">Verificar</button>` : ''}
          ${o.status === 'pending' ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-point="${o.id}">Cancelar</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('btnSendPointOrder')?.addEventListener('click', async (e) => {
  const memberId = document.getElementById('pMember').value;
  if (!memberId) {
    showToast('Selecione o aluno primeiro.', true);
    document.getElementById('pMemberSearch').focus();
    return;
  }
  const amountCents = toCents(document.getElementById('pAmount').value);
  const planId = document.getElementById('pPlan').value || null;
  const paymentMethod = document.getElementById('pMethod').value || 'credit';

  await withLoading(e.currentTarget, async () => {
    try {
      const order = await api('/api/gateways/mp/point-orders', {
        method: 'POST',
        body: JSON.stringify({ member_id: memberId, plan_id: planId, amount_cents: amountCents, payment_method: paymentMethod }),
      });
      showToast('Cobrança enviada para a tela da Point Smart!');
      await loadPointOrders();
      if (order?.id) startPaymentAutoPoll({ type: 'point', id: order.id });
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('pointOrdersList')?.addEventListener('click', async (e) => {
  const checkBtn = e.target.closest('button[data-check-point]');
  if (checkBtn) {
    await withLoading(checkBtn, async () => {
      try {
        const res = await api(`/api/gateways/mp/point-orders/${checkBtn.dataset.checkPoint}/check`, { method: 'POST' });
        if (res.paid) {
          showToast('Pagamento na Point Smart confirmado e baixado!');
          await Promise.all([loadPointOrders(), loadPayments(), loadCurrentCash(), loadMembers(), loadDashboard()]);
        } else {
          showToast(`Status na maquininha: ${res.status || 'pendente'}`);
          await loadPointOrders();
        }
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }

  const cancelBtn = e.target.closest('button[data-cancel-point]');
  if (cancelBtn) {
    await withLoading(cancelBtn, async () => {
      try {
        await api(`/api/gateways/mp/point-orders/${cancelBtn.dataset.cancelPoint}/cancel`, { method: 'POST' });
        showToast('Cobrança cancelada na Point Smart.');
        await loadPointOrders();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

async function saveMpCredentialsIfEdited() {
  const token = document.getElementById('gwMpToken')?.value?.trim() || '';
  const terminalId = document.getElementById('gwMpPointTerminalId')?.value?.trim() || '';
  const payload = {};
  if (token && token !== '******') payload.mp_access_token = token;
  const pointToken = document.getElementById('gwMpPointToken').value.trim();
  if (pointToken && pointToken !== '******') payload.mp_point_access_token = pointToken;
  if (terminalId) payload.mp_point_terminal_id = terminalId;
  if (Object.keys(payload).length) {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
  }
}

document.getElementById('btnListMpTerminals')?.addEventListener('click', async (e) => {
  const container = document.getElementById('mpTerminalsList');
  await withLoading(e.currentTarget, async () => {
    try {
      await saveMpCredentialsIfEdited();
      const terminals = await api('/api/gateways/mp/terminals');
      if (!terminals.length) {
        container.innerHTML = '<div class="muted">Nenhuma maquininha Point encontrada nesta conta.</div>';
        return;
      }
      container.innerHTML = terminals
        .map(
          (t) => `
          <div class="billing-member" style="cursor:default;">
            <div>
              <strong>${escapeHtml(t.id)}</strong>
              <span class="badge ${t.operating_mode === 'PDV' ? 'badge-active' : 'badge-pending'}">${escapeHtml(t.operating_mode || 'STANDALONE')}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-pick-terminal="${escapeHtml(t.id)}">Selecionar</button>
          </div>`,
        )
        .join('');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('mpTerminalsList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pick-terminal]');
  if (btn) {
    document.getElementById('gwMpPointTerminalId').value = btn.dataset.pickTerminal;
    showToast('Maquininha selecionada! Clique em "Salvar credenciais de pagamento".');
  }
});

document.getElementById('btnEnablePointPdv')?.addEventListener('click', async (e) => {
  const terminalId = document.getElementById('gwMpPointTerminalId').value.trim();
  await withLoading(e.currentTarget, async () => {
    try {
      await saveMpCredentialsIfEdited();
      await api('/api/gateways/mp/terminals/setup', {
        method: 'POST',
        body: JSON.stringify({ terminal_id: terminalId, operating_mode: 'PDV' }),
      });
      showToast('Modo PDV ativado! Reinicie a Point Smart para aplicar.');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          gym_name: document.getElementById('sGymName').value,
          gym_phone: document.getElementById('sGymPhone').value,
          tolerance_days: document.getElementById('sTolerance').value,
          antipassback_minutes: document.getElementById('sAntipassback')?.value || '0',
          max_capacity: document.getElementById('sMaxCapacity')?.value || '0',
          controlid_ip: document.getElementById('sIp').value,
          controlid_port: document.getElementById('sPort').value,
          controlid_user: document.getElementById('sUser').value,
          controlid_password: document.getElementById('sPass').value,
          toletus_ip: document.getElementById('sToletusIp').value,
          toletus_port: document.getElementById('sToletusPort').value,
          toletus_enabled: document.getElementById('sToletusEnabled').checked ? 'true' : 'false',
          controlid_mock_mode: document.getElementById('sMockMode').checked ? 'true' : 'false',
        }),
      });
      showToast('Configurações salvas!');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('partnersForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          wellhub_enabled: document.getElementById('sWellhubEnabled').checked ? '1' : 'false',
          wellhub_require_checkin: document.getElementById('sWellhubRequireCheckin').checked ? '1' : '0',
          wellhub_gym_id: document.getElementById('sWellhubGymId').value.trim(),
          wellhub_api_key: document.getElementById('sWellhubApiKey').value.trim(),
          wellhub_webhook_secret: document.getElementById('sWellhubWebhookSecret').value.trim(),
          totalpass_enabled: document.getElementById('sTotalpassEnabled').checked ? '1' : 'false',
          totalpass_require_checkin: document.getElementById('sTotalpassRequireCheckin').checked ? '1' : '0',
          totalpass_gym_id: document.getElementById('sTotalpassGymId').value.trim(),
          totalpass_api_token: document.getElementById('sTotalpassApiToken').value.trim(),
          totalpass_webhook_secret: document.getElementById('sTotalpassWebhookSecret').value.trim(),
        }),
      });
      showToast('Configurações de convênios salvas!');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('profPartnerProvider')?.addEventListener('change', (e) => {
  const isWellhub = e.target.value === 'wellhub';
  document.getElementById('profWellhubWrap')?.classList.toggle('hidden', !isWellhub);
});

document.getElementById('btnPartnerCheckinNow')?.addEventListener('click', async (e) => {
  if (!state.selectedProfileId) return;
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/partners/checkin', {
        method: 'POST',
        body: JSON.stringify({ member_id: state.selectedProfileId }),
      });
      showToast('Check-in do convênio registrado para hoje!');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('pmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.target, async () => {
    try {
      await api('/api/payment-methods', {
        method: 'POST',
        body: JSON.stringify({ name: document.getElementById('pmName').value }),
      });
      e.target.reset();
      showToast('Forma de pagamento adicionada!');
      await loadPaymentMethods();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Botoes Hardware ---
document.getElementById('turnstilePreviewForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await withLoading(event.currentTarget, async () => {
    try {
      await api('/api/turnstile/preview', {
        method: 'POST',
        body: JSON.stringify({ outcome: document.getElementById('turnstilePreviewState').value }),
      });
      showToast('Teste enviado à tela da catraca.');
    } catch (err) { showToast(err.message, true); }
  });
});

document.getElementById('btnTestToletus').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/device/test-toletus', { method: 'POST' });
      showToast(res.message);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnTestConn').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/device/test', { method: 'POST' });
      document.getElementById('deviceStatusText').textContent = res.mock ? 'Modo simulado' : 'FaceID testado';
      showToast(res.message);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('releaseDirection')?.addEventListener('change', (e) => {
  e.currentTarget.dataset.userChanged = '1';
});

document.getElementById('btnRelease').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const direction = document.getElementById('releaseDirection')?.value || 'entry';
      const turnstileVal = document.getElementById('releaseTurnstileId')?.value || '';
      const turnstile_id = turnstileVal ? Number(turnstileVal) : null;
      await api('/api/device/release', {
        method: 'POST',
        body: JSON.stringify({ direction, turnstile_id }),
      });
      showToast(`Catraca liberada (${DIRECTION_LABELS[direction] || direction})!`);
      await loadDashboard();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('turnstileForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('tId').value;
  const payload = {
    name: document.getElementById('tName').value.trim(),
    driver: document.getElementById('tDriver').value,
    ip: document.getElementById('tIp').value.trim(),
    port: Number(document.getElementById('tPort').value) || 7878,
    release_seconds: Number(document.getElementById('tReleaseSeconds').value) || 5,
    default_direction: document.getElementById('tDefaultDirection').value,
    free_side: document.getElementById('tFreeSide').value,
    active: document.getElementById('tActive').checked,
  };
  try {
    if (id) {
      await api(`/api/devices/turnstiles/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Catraca atualizada!');
    } else {
      await api('/api/devices/turnstiles', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Catraca cadastrada!');
    }
    resetTurnstileForm();
    await loadDevices();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btnCancelTurnstileEdit')?.addEventListener('click', resetTurnstileForm);

document.getElementById('turnstilesBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-turnstile-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.turnstileAction;
  const item = (state.turnstiles || []).find((t) => t.id === id);
  if (action === 'edit' && item) {
    document.getElementById('tId').value = String(item.id);
    document.getElementById('tName').value = item.name || '';
    document.getElementById('tDriver').value = item.driver || 'toletus';
    document.getElementById('tIp').value = item.ip || '';
    document.getElementById('tPort').value = String(item.port || 7878);
    document.getElementById('tReleaseSeconds').value = String(item.release_seconds || 5);
    document.getElementById('tDefaultDirection').value = item.default_direction || 'entry';
    document.getElementById('tFreeSide').value = item.free_side || 'none';
    document.getElementById('tActive').checked = Boolean(item.active);
    document.getElementById('btnSaveTurnstile').textContent = 'Atualizar Catraca';
    document.getElementById('btnCancelTurnstileEdit').classList.remove('hidden');
    return;
  }
  await withLoading(btn, async () => {
    try {
      if (action === 'test') {
        const res = await api(`/api/devices/turnstiles/${id}/test`, { method: 'POST' });
        showToast(res.message || 'Catraca testada!');
      } else if (action === 'apply') {
        const res = await api(`/api/devices/turnstiles/${id}/apply`, { method: 'POST' });
        showToast(res.message || 'Configuração aplicada na catraca!');
      } else if (action === 'delete') {
        if (!confirm(`Excluir a catraca "${item?.name || id}"?`)) return;
        await api(`/api/devices/turnstiles/${id}`, { method: 'DELETE' });
        showToast('Catraca removida.');
        await loadDevices();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('readerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('rId').value;
  const payload = {
    name: document.getElementById('rName').value.trim(),
    ip: document.getElementById('rIp').value.trim(),
    port: Number(document.getElementById('rPort').value) || 80,
    username: document.getElementById('rUsername').value.trim() || 'admin',
    action_mode: document.getElementById('rActionMode').value,
    secbox_id: Number(document.getElementById('rSecboxId').value) || 65793,
    group_id: Number(document.getElementById('rGroupId').value) || 1,
    direction: document.getElementById('rDirection').value,
    turnstile_id: document.getElementById('rTurnstileId').value ? Number(document.getElementById('rTurnstileId').value) : null,
    active: document.getElementById('rActive').checked,
  };
  const password = document.getElementById('rPassword').value;
  if (password) payload.password = password;
  try {
    if (id) {
      await api(`/api/devices/readers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Leitor atualizado!');
    } else {
      await api('/api/devices/readers', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Leitor cadastrado!');
    }
    resetReaderForm();
    await loadDevices();
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btnCancelReaderEdit')?.addEventListener('click', resetReaderForm);

document.getElementById('readersBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-reader-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.readerAction;
  const item = (state.readers || []).find((r) => r.id === id);
  if (action === 'edit' && item) {
    document.getElementById('rId').value = String(item.id);
    document.getElementById('rName').value = item.name || '';
    document.getElementById('rIp').value = item.ip || '';
    document.getElementById('rPort').value = String(item.port || 80);
    document.getElementById('rUsername').value = item.username || 'admin';
    document.getElementById('rPassword').value = '';
    document.getElementById('rActionMode').value = item.action_mode || 'sec_box';
    document.getElementById('rSecboxId').value = String(item.secbox_id || 65793);
    document.getElementById('rGroupId').value = String(item.group_id || 1);
    document.getElementById('rDirection').value = item.direction || 'entry';
    document.getElementById('rTurnstileId').value = item.turnstile_id ? String(item.turnstile_id) : '';
    document.getElementById('rActive').checked = Boolean(item.active);
    document.getElementById('btnSaveReader').textContent = 'Atualizar Leitor';
    document.getElementById('btnCancelReaderEdit').classList.remove('hidden');
    return;
  }
  await withLoading(btn, async () => {
    try {
      if (action === 'test') {
        const res = await api(`/api/devices/readers/${id}/test`, { method: 'POST' });
        showToast(res.message || 'Leitor testado!');
      } else if (action === 'delete') {
        if (!confirm(`Excluir o leitor "${item?.name || id}"?`)) return;
        await api(`/api/devices/readers/${id}`, { method: 'DELETE' });
        showToast('Leitor removido.');
        await loadDevices();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function syncLogsAction(e) {
  await withLoading(e?.currentTarget, async () => {
    try {
      const res = await api('/api/device/sync-logs', { method: 'POST' });
      showToast(`${res.inserted} novo(s) log(s) importado(s).`);
      await Promise.all([loadLogs(), loadDashboard()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}
document.getElementById('btnSyncLogs').addEventListener('click', syncLogsAction);
document.getElementById('btnSyncLogsDash').addEventListener('click', syncLogsAction);

document.getElementById('btnCheckExpired').addEventListener('click', async (e) => {
  if (!window.confirm('Deseja verificar e bloquear todos os alunos com mensalidade vencida?')) return;
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/device/check-expired', { method: 'POST' });
      showToast(`${res.blockedCount} inadimplente(s) bloqueado(s).`);
      await Promise.all([loadMembers(), loadDashboard()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

window.toggleMemberStatus = async (id, status, name = 'este aluno') => {
  const activate = status === 'active';
  const prompt = activate
    ? `Reativar o acesso de ${name}? É necessário ter uma matrícula vigente.`
    : `Bloquear o acesso de ${name}?`;
  if (!window.confirm(prompt)) return;
  try {
    const res = await api(`/api/members/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    showToast(
      res.sync.synced ? (activate ? 'Acesso sincronizado com o FaceID.' : 'Acesso suspenso.') : `Salvo localmente (aviso catraca: ${res.sync.error})`,
      !res.sync.synced,
    );
    if (!patchMemberInState(res.member || { id, status, access_status: status })) {
      await loadMembers();
    }
    await loadDashboard();
  } catch (err) {
    showToast(err.message, true);
  }
};

// --- Modal FaceID ---
const faceMirrorChannel = typeof window.BroadcastChannel === 'function'
  ? new BroadcastChannel('oxigenio_face_mirror')
  : null;
let faceMirrorTimer = null;
let faceMirrorLastServerPush = 0;

function publishFaceMirror(payload) {
  if (faceMirrorChannel) faceMirrorChannel.postMessage(payload);
  const now = Date.now();
  if (!payload?.active || payload?.captured || now - faceMirrorLastServerPush >= 500) {
    faceMirrorLastServerPush = now;
    api('/api/turnstile/face-mirror', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}

function stopFaceMirror({ clearRemote = true } = {}) {
  clearInterval(faceMirrorTimer);
  faceMirrorTimer = null;
  if (clearRemote) publishFaceMirror({ active: false });
}

function startFaceMirror(video, memberName) {
  stopFaceMirror({ clearRemote: false });
  const mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = 360;
  mirrorCanvas.height = 270;
  const ctx = mirrorCanvas.getContext('2d');
  faceMirrorTimer = setInterval(() => {
    if (!state.webcamStream || video.readyState < 2 || !ctx) return;
    ctx.drawImage(video, 0, 0, mirrorCanvas.width, mirrorCanvas.height);
    const frame = mirrorCanvas.toDataURL('image/jpeg', 0.6);
    publishFaceMirror({ active: true, captured: false, memberName, frame });
  }, 90);
}

function stopWebcam({ clearMirror = false } = {}) {
  stopFaceMirror({ clearRemote: clearMirror });
  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach((t) => t.stop());
    state.webcamStream = null;
  }
  document.getElementById('webcamVideo').classList.add('hidden');
  document.getElementById('btnSnapCam').classList.add('hidden');
}

function closeFaceModal() {
  state.faceCapture = null;
  stopWebcam({ clearMirror: true });
  hideModal('faceModal');
}

window.openFaceModal = (id, name) => {
  stopWebcam({ clearMirror: true });
  state.faceCapture = Symbol();
  state.selectedFaceMemberId = id;
  state.selectedFaceMemberName = name;
  state.selectedFaceBase64 = null;
  document.getElementById('faceModalTitle').textContent = `FaceID — ${name}`;
  document.getElementById('facePreview').classList.add('hidden');
  document.getElementById('btnSaveFace').disabled = true;
  document.getElementById('faceFileInput').value = '';
  showModal('faceModal', 'btnCloseFaceModal');
};

document.getElementById('btnCloseFaceModal').addEventListener('click', closeFaceModal);

document.getElementById('btnStartCam').addEventListener('click', async () => {
  const capture = state.faceCapture = Symbol();
  try {
    stopWebcam({ clearMirror: true });
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (state.faceCapture !== capture) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.webcamStream = stream;
    const video = document.getElementById('webcamVideo');
    video.srcObject = state.webcamStream;
    video.classList.remove('hidden');
    document.getElementById('facePreview').classList.add('hidden');
    document.getElementById('btnSnapCam').classList.remove('hidden');
    startFaceMirror(video, state.selectedFaceMemberName || '');
  } catch (err) {
    if (state.faceCapture === capture) showToast(`Erro na webcam: ${err.message}`, true);
  }
});

document.getElementById('btnSnapCam').addEventListener('click', () => {
  const video = document.getElementById('webcamVideo');
  const canvas = document.getElementById('webcamCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  state.selectedFaceBase64 = dataUrl;
  const preview = document.getElementById('facePreview');
  preview.src = dataUrl;
  preview.classList.remove('hidden');
  document.getElementById('btnSaveFace').disabled = false;
  stopWebcam({ clearMirror: false });
  const mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = 360;
  mirrorCanvas.height = 270;
  mirrorCanvas.getContext('2d')?.drawImage(canvas, 0, 0, 360, 270);
  publishFaceMirror({
    active: true,
    captured: true,
    memberName: state.selectedFaceMemberName || '',
    frame: mirrorCanvas.toDataURL('image/jpeg', 0.72),
  });
});

document.getElementById('faceFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const capture = state.faceCapture = Symbol();
  const reader = new FileReader();
  reader.onload = () => {
    if (state.faceCapture !== capture) return;
    state.selectedFaceBase64 = reader.result;
    const preview = document.getElementById('facePreview');
    preview.src = reader.result;
    preview.classList.remove('hidden');
    document.getElementById('btnSaveFace').disabled = false;
    stopWebcam();
  };
  reader.readAsDataURL(file);
});

document.getElementById('btnSaveFace').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await api(`/api/members/${state.selectedFaceMemberId}/face`, {
        method: 'POST',
        body: JSON.stringify({ imageBase64: state.selectedFaceBase64 }),
      });
      showToast('FaceID enviado!');
      closeFaceModal();
      if (
        state.selectedProfileId === state.selectedFaceMemberId &&
        !document.getElementById('profileModal').classList.contains('hidden')
      ) {
        document.getElementById('profPhoto').src = `/api/members/${state.selectedProfileId}/photo?t=${Date.now()}`;
      }
      await loadMembers();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnImportSca').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById('scaFileInput');
  const file = input.files[0];
  if (!file) return showToast('Selecione um arquivo .xls ou .html exportado do SCA.', true);
  const reader = new FileReader();
  reader.onload = async () => {
    await withLoading(btn, async () => {
      try {
        const preview = await api('/api/import/sca', {
          method: 'POST',
          body: JSON.stringify({ htmlContent: reader.result, preview: true }),
        });
        if (!window.confirm(`Prévia do SCA: ${preview.membersImported} cadastro(s), ${preview.enrollmentsUpdated} matrícula(s), ${preview.chargesUpdated} cobrança(s), ${preview.receiptsImported} recebimento(s) e ${preview.conflicts} divergência(s) ignorada(s). Aplicar a importação?`)) return;
        const res = await api('/api/import/sca', {
          method: 'POST',
          body: JSON.stringify({ htmlContent: reader.result }),
        });
        const msg = `SCA importado: ${res.membersImported} aluno(s), ${res.enrollmentsUpdated} matrícula(s), ${res.chargesUpdated || 0} cobrança(s), ${res.plansCreated} plano(s), ${res.classesImported} turma(s), ${res.staffImported} atendente(s), ${res.instructorsImported} professor(es).`;
        document.getElementById('importResult').textContent = `${msg} ${res.conflicts ?? 0} divergência(s) ignorada(s).`;
        showToast(msg);
        input.value = '';
        await Promise.all([loadMembers(), loadPlans(), loadStaff(), loadGymStructure(), loadDashboard()]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  };
  reader.readAsText(file, 'UTF-8');
});

document.getElementById('btnSyncControlIdUsers').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/import/controlid', { method: 'POST' });
      const msg = (res.mock || res.queuedForEdge)
        ? res.message
        : `Control iD: ${res.linked} vinculado(s), ${res.imported} novo(s), ${res.conflicts ?? 0} divergência(s) para conferir.`;
      document.getElementById('importResult').textContent = msg;
      showToast(msg);
      await Promise.all([loadMembers(), loadDashboard()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// Fechar modais ao clicar fora (apenas se mousedown também começou no backdrop) ou pressionar Escape
['profileModal', 'faceModal', 'receiptPreviewModal'].forEach((modalId) => {
  const modalEl = document.getElementById(modalId);
  let backdropPressed = false;
  modalEl?.addEventListener('mousedown', (e) => {
    backdropPressed = e.target.id === modalId;
  });
  modalEl?.addEventListener('click', (e) => {
    if (backdropPressed && e.target.id === modalId) {
      if (modalId === 'faceModal') closeFaceModal();
      else if (modalId === 'profileModal') closeProfileModal();
      else hideModal(modalId);
    }
    backdropPressed = false;
  });
});

document.addEventListener('keydown', (e) => {
  const modal = document.querySelector('#loginOverlay:not(.hidden)') ||
    document.querySelector('#receiptPreviewModal:not(.hidden)') ||
    document.querySelector('#faceModal:not(.hidden)') ||
    document.querySelector('#profileModal:not(.hidden)');
  if (e.key === 'Escape') {
    if (modal?.id === 'receiptPreviewModal') hideModal(modal.id);
    if (modal?.id === 'faceModal') closeFaceModal();
    if (modal?.id === 'profileModal') closeProfileModal();
    if (modal) return;
  }

  const tag = (document.activeElement?.tagName || '').toLowerCase();
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (modal && e.key === 'Tab') {
    const focusable = [...modal.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex="0"]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
    const first = focusable[0];
    const last = focusable.at(-1);
    const outside = !modal.contains(document.activeElement);
    if (outside || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      e.preventDefault();
      (e.shiftKey ? last : first)?.focus();
    }
  }

  if (!e.repeat && !modal && (e.key === 'F9' || (!isTyping && e.ctrlKey && e.altKey && e.key.toLowerCase() === 'l'))) {
    e.preventDefault();
    document.getElementById('btnRelease')?.click();
  }
});

const THEME_STORAGE_KEY = 'oxigenio_theme';

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(next === 'dark'));
    btn.textContent = next === 'dark' ? '☀ Tema claro' : '🌙 Tema escuro';
  }
}

const savedTheme = (() => {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
})();
applyTheme(savedTheme === 'light' ? 'light' : 'dark');

document.getElementById('btnThemeToggle')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore storage errors
  }
});

const SIDEBAR_STORAGE_KEY = 'oxigenio_sidebar_collapsed';

function applySidebarCollapsed(isCollapsed) {
  const collapsed = Boolean(isCollapsed);
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('btnCollapseSidebar');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('title', collapsed ? 'Expandir menu' : 'Recolher menu');
    const useEl = btn.querySelector('use');
    if (useEl) {
      useEl.setAttribute('href', collapsed ? '#i-chevron-right' : '#i-chevron-left');
    }
  }
}

const savedSidebarCollapsed = (() => {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
})();
applySidebarCollapsed(savedSidebarCollapsed);

document.getElementById('btnCollapseSidebar')?.addEventListener('click', () => {
  const nextCollapsed = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(nextCollapsed);
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, nextCollapsed ? '1' : '0');
  } catch {
    // ignore storage errors
  }
});

function renderHorizontalBars(containerId, items, valueFormatter = (v) => String(v), emptyText = 'Sem dados no período.') {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = `<div class="muted">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const max = Math.max(...items.map((x) => Number(x.value || 0)), 1);
  el.innerHTML = items
    .map((item) => {
      const pct = Math.max(4, Math.round((Number(item.value || 0) / max) * 100));
      return `
      <div class="report-bar-row">
        <div class="report-bar-head">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(valueFormatter(item.value, item))}</strong>
        </div>
        <div class="report-bar-track">
          <div class="report-bar-fill" style="width:${pct}%"></div>
        </div>
      </div>`;
    })
    .join('');
}

function renderRevenueSvgChart(series) {
  const wrap = document.getElementById('repRevenueChart');
  if (!wrap) return;
  if (!series || !series.length) {
    wrap.innerHTML = '<div class="muted">Sem dados financeiros para exibir.</div>';
    return;
  }
  const W = 720;
  const H = 220;
  const padL = 56;
  const padR = 16;
  const padT = 22;
  const padB = 34;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxVal = Math.max(...series.map((s) => s.totalCents), 100);
  const step = chartW / series.length;
  const barW = Math.min(44, step * 0.58);

  const monthFmt = (m) => {
    const [y, mo] = m.split('-');
    return `${mo}/${y.slice(2)}`;
  };

  const bars = series
    .map((s, idx) => {
      const h = Math.max(2, Math.round((s.totalCents / maxVal) * chartH));
      const x = Math.round(padL + idx * step + (step - barW) / 2);
      const y = padT + chartH - h;
      const fill = s.projected ? 'rgba(234, 88, 12, 0.25)' : '#ea580c';
      const stroke = s.projected ? 'stroke="#ea580c" stroke-width="2" stroke-dasharray="4 3"' : '';
      const valText = `R$ ${Math.round(s.totalCents / 100)}`;
      return `
        <g>
          <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="${fill}" ${stroke}></rect>
          <text x="${x + barW / 2}" y="${Math.max(12, y - 5)}" text-anchor="middle" font-size="10" fill="currentColor">${escapeHtml(valText)}</text>
          <text x="${x + barW / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">${escapeHtml(monthFmt(s.month))}${s.projected ? '*' : ''}</text>
        </g>`;
    })
    .join('');

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de receita mensal e projeção">
      <line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="currentColor" stroke-opacity="0.2" />
      <text x="${padL - 8}" y="${padT + 8}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">R$ ${Math.round(maxVal / 100)}</text>
      <text x="${padL - 8}" y="${padT + chartH}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">R$ 0</text>
      ${bars}
    </svg>`;
}

async function loadReports() {
  const monthInput = document.getElementById('reportMonth');
  if (monthInput && !monthInput.value) {
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const month = monthInput?.value || '';
  const data = await api(`/api/reports/analytics${month ? `?month=${encodeURIComponent(month)}` : ''}`);

  document.getElementById('repTotalCents').textContent = fmtMoney(data.financial.totalCents);
  document.getElementById('repGrowth').textContent =
    data.financial.growthPct === null
      ? 'Sem comparativo do mês anterior'
      : `${data.financial.growthPct >= 0 ? '+' : ''}${data.financial.growthPct}% vs mês anterior`;
  document.getElementById('repSplit').textContent = `${fmtMoney(data.financial.mensalidadesCents)} / ${fmtMoney(data.financial.vendasCents)}`;
  document.getElementById('repTicket').textContent = `${data.financial.paymentsCount} pag. · Ticket médio ${fmtMoney(data.financial.ticketAvgCents)}`;
  document.getElementById('repProjectedEnd').textContent = fmtMoney(data.projections.projectedMonthEndCents);
  document.getElementById('repOpenReceivables').textContent = `A receber no mês: ${fmtMoney(data.projections.openReceivablesCents)}`;
  document.getElementById('repMrr').textContent = fmtMoney(data.projections.mrrCents);
  document.getElementById('repAvgStay').textContent = `${data.retention.avgMonthsOverall} meses`;
  document.getElementById('repAvgStaySub').textContent = `Média geral de permanência`;

  renderRevenueSvgChart(data.projections.series);

  renderHorizontalBars(
    'repMethodsChart',
    data.financial.byMethod.map((m) => ({ label: m.label, value: m.total_cents, count: m.count })),
    (v, item) => `${fmtMoney(v)} (${item.count})`,
    'Nenhum pagamento confirmado neste mês.',
  );

  renderHorizontalBars(
    'repPlansList',
    data.financial.byPlan.map((p) => ({ label: p.name, value: p.total_cents, count: p.count })),
    (v, item) => `${fmtMoney(v)} (${item.count})`,
    'Nenhum plano recebido neste mês.',
  );

  document.getElementById('repStuActive').textContent = data.members.active;
  document.getElementById('repStuBlocked').textContent = data.members.blocked;
  document.getElementById('repStuPending').textContent = data.members.pending;
  document.getElementById('repStuNew').textContent = data.members.newInMonth;
  document.getElementById('repStuRenewed').textContent = data.members.renewedInMonth;
  document.getElementById('repStuCanceled').textContent = `${data.members.canceledInMonth} (${data.members.churnRatePct}%)`;
  document.getElementById('repStayActive').textContent = `${data.retention.avgMonthsActive} meses`;
  document.getElementById('repStayCanceled').textContent = `${data.retention.avgMonthsCanceled} meses`;
  document.getElementById('repAvgPayments').textContent = data.retention.avgPaymentsPerMember;

  renderHorizontalBars(
    'repModalitiesChart',
    data.members.byModality.map((m) => ({ label: m.name, value: m.count })),
    (v) => `${v} aluno(s)`,
    'Sem alunos ativos com modalidade.',
  );

  renderHorizontalBars(
    'repCancelChart',
    data.cancellations.byReason.map((r) => ({ label: r.reason, value: r.count })),
    (v) => `${v} (${data.cancellations.total > 0 ? Math.round((v / data.cancellations.total) * 100) : 0}%)`,
    'Nenhum cancelamento registrado ainda.',
  );

  document.getElementById('repCancelBody').innerHTML =
    data.cancellations.recent
      .map(
        (c) => `<tr>
          <td>${escapeHtml(c.canceled_at)}</td>
          <td>${escapeHtml(c.member_name)}</td>
          <td>${escapeHtml(c.plan_name || '—')}</td>
          <td>${escapeHtml(c.reason)}</td>
          <td>${escapeHtml(c.notes || '—')}</td>
        </tr>`,
      )
      .join('') || '<tr><td colspan="5" class="empty-cell">Nenhum cancelamento registrado.</td></tr>';

  await loadFinanceSection(month).catch(() => {});
}

document.getElementById('reportMonth')?.addEventListener('change', () => {
  loadReports().catch((err) => showToast(err.message, true));
});
document.getElementById('btnRefreshReports')?.addEventListener('click', () => {
  loadReports().catch((err) => showToast(err.message, true));
});

document.getElementById('cancelMemberSearch')?.addEventListener('input', (e) => {
  populateMemberDatalist(e.target.value);
  const match = resolveMemberFromInput(e.target.value);
  document.getElementById('cancelMemberId').value = match ? String(match.id) : '';
});

document.getElementById('cancelEnrollmentForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const memberId = resolveMemberFromInput(document.getElementById('cancelMemberSearch').value)?.id;
  if (!memberId) {
    showToast('Selecione um aluno válido da lista.', true);
    document.getElementById('cancelMemberSearch').focus();
    return;
  }

  await withLoading(e.target, async () => {
    try {
      await api(`/api/members/${memberId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({
          reason: document.getElementById('cancelReason').value,
          notes: document.getElementById('cancelNotes').value.trim(),
        }),
      });
      document.getElementById('cancelMemberSearch').value = '';
      document.getElementById('cancelMemberId').value = '';
      document.getElementById('cancelNotes').value = '';
      showToast('Cancelamento registrado e acesso bloqueado.');
      await Promise.all([loadReports(), loadMembers(), loadDashboard()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function showLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.remove('hidden');
  document.getElementById('loginPass')?.focus();
  for (const element of document.querySelectorAll('body > .layout, body > .modal')) element.inert = true;
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay')?.classList.add('hidden');
  document.getElementById('loginError')?.classList.add('hidden');
  for (const element of document.querySelectorAll('body > .layout, body > .modal')) element.inert = false;
}

document.getElementById('btnStudentInvite').addEventListener('click', (event) => {
  const id = state.selectedProfileId;
  return withLoading(event.currentTarget, async () => {
    const output = document.getElementById('studentInviteCode');
    try {
      const { code } = await api(`/api/members/${id}/portal-invite`, { method: 'POST' });
      if (state.selectedProfileId === id) output.textContent = `Código: ${code} · uso único, válido por 24 horas`;
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function updateLogoutButton(enabled) {
  document.getElementById('btnLogout')?.classList.toggle('hidden', !enabled);
}

document.getElementById('authForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = document.getElementById('authEnabled').checked;
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirmPass = document.getElementById('authPasswordConfirm').value;

  if (password && password !== confirmPass) {
    showToast('As senhas não conferem.', true);
    return;
  }

  await withLoading(e.target, async () => {
    try {
      const res = await api('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ enabled, username, password }),
      });
      document.getElementById('authPassword').value = '';
      document.getElementById('authPasswordConfirm').value = '';
      updateLogoutButton(res.enabled);
      showToast(res.enabled ? 'Login ativado! Sessão iniciada.' : 'Login desativado.');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;

  await withLoading(e.target, async () => {
    try {
      const loginRes = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      let role = loginRes?.user?.role || loginRes?.role;
      if (!role) {
        const statusRes = await api('/api/auth/status').catch(() => null);
        role = statusRes?.role || 'admin';
      }
      document.getElementById('loginPass').value = '';
      hideLoginOverlay();
      updateLogoutButton(true);
      applyRoleUi(role);
      startTurnstileEventsStream();
      switchTab(getTabFromHash(), { updateHash: !window.location.hash });
    } catch (err) {
      errEl.textContent = err.message || 'Usuário ou senha inválidos.';
      errEl.classList.remove('hidden');
    }
  });
});

function clearSessionState() {
  stopTurnstileEventsStream();
  stopPaymentAutoPoll();
  clearTimeout(state.logsTimer);
  state.logsTimer = null;
  clearTimeout(waPollTimer);
  waPollTimer = null;
  if (paymentsAbortController) {
    paymentsAbortController.abort();
    paymentsAbortController = null;
  }
  tabRequests.clear();
  sharedLoads.clear();

  state.authRole = 'admin';

  state.plans = [];
  state.allMembers = [];
  state.teamMembers = [];
  state.memberSearchIndex = [];
  state.filteredMembers = [];
  state.modalities = [];
  state.instructors = [];
  state.classes = [];
  state.staff = [];
  state.paymentMethods = [];
  state.products = [];
  state.logs = [];
  state.cashSession = null;
  state.selectedProfileId = null;
  state.selectedProfileName = null;
  state.selectedProfileMember = null;
  state.selectedProfilePayments = [];
  state.paymentsList = [];
  state.salesList = [];

  for (const id of ['gwMpToken', 'gwMpPointToken', 'gwMpWebhookSecret', 'gwMpPointWebhookSecret', 'gwMpPointTerminalId', 'waGeminiKey', 'sWellhubApiKey', 'sWellhubWebhookSecret', 'sTotalpassApiToken', 'sTotalpassWebhookSecret', 'sPass']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  for (const id of ['membersBody', 'paymentsBody', 'receiptsQueue', 'pixChargesList', 'pointOrdersList', 'mpSubscriptionsList', 'logsBody', 'dashLogsBody', 'cashMovementsBody', 'cashHistoryBody', 'salesHistoryBody']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
  closeFaceModal();
  closeProfileModal(false);
  hideModal('receiptPreviewModal', false);
}

document.getElementById('btnLogout')?.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearSessionState();
  showLoginOverlay();
});

const receptionDate = document.getElementById('receptionDate');
receptionDate.textContent = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date());

(async () => {
  if (!window.oxigenioDemo) {
    try {
      const auth = await api('/api/auth/status');
      updateLogoutButton(auth.enabled);
      if (auth.username) {
        document.getElementById('loginUser').value = auth.username;
      }
      if (auth.enabled && !auth.authenticated) {
        showLoginOverlay();
        return;
      }
      applyRoleUi(auth.role || 'admin');
    } catch {
      showLoginOverlay();
      const errEl = document.getElementById('loginError');
      if (errEl) {
        errEl.textContent = 'Não foi possível verificar a autenticação. Faça login ou recarregue a página.';
        errEl.classList.remove('hidden');
      }
      return;
    }
  }
  startTurnstileEventsStream();
  switchTab(getTabFromHash(), { updateHash: !window.location.hash });
})();

if (window.oxigenioDemo) {
  document.getElementById('demoBadge').classList.remove('hidden');
  const tools = document.getElementById('demoAccess');
  tools.classList.remove('hidden');
  for (const [outcome, label] of [['allowed', 'Simular acesso autorizado'], ['denied', 'Simular acesso negado']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.textContent = label;
    button.addEventListener('click', async () => {
      try {
        await api('/api/demo/access', { method: 'POST', body: JSON.stringify({ outcome }) });
        await Promise.all([loadLogs(), loadDashboard()]);
        showToast('Evento simulado enviado à tela da catraca.');
      } catch (err) {
        showToast(err.message, true);
      }
    });
    tools.append(button);
  }
}


// --- Treinos do Aluno (Admin / Professores) ---
let currentProfileWorkouts = [];
let workoutTemplates = [];
const workoutExerciseChoices = () => [...exerciseCatalogEntries, window.EXERCISE_LIBRARY.findExercise('custom')];

function addWorkoutExerciseRow(ex = {}, container = document.getElementById('wkExercisesRows')) {
  const catalog = workoutExerciseChoices();
  if (ex.exercise_key && !catalog.some((item) => item.key === ex.exercise_key)) {
    catalog.push({ key: ex.exercise_key, name: ex.exercise_name, muscle_group: ex.muscle_group || 'Geral' });
  }
  const row = document.createElement('div');
  row.className = 'panel wk-ex-row';
  row.style.cssText = 'padding:10px;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;align-items:end;';

  const selectedKey = catalog.some((item) => item.key === ex.exercise_key)
    ? ex.exercise_key : ex.exercise_key ? 'custom' : (catalog[0]?.key || 'custom');
  const found = catalog.find((c) => c.key === selectedKey) || catalog[catalog.length - 1];
  const opts = catalog.map((c) => `<option value="${escapeHtml(c.key)}" ${c.key === selectedKey ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.muscle_group)})</option>`).join('');

  row.innerHTML = `
    <label style="grid-column:span 2;">Exercício do catálogo
      <select class="wk-ex-key">${opts}</select>
    </label>
    <label>Nome exibido
      <input type="text" class="wk-ex-name" value="${escapeHtml(ex.exercise_name || found?.name || '')}" required />
    </label>
    <label>Séries
      <input type="number" class="wk-ex-sets" min="1" value="${Number(ex.sets || 3)}" required />
    </label>
    <label>Reps / Tempo
      <input type="text" class="wk-ex-reps" value="${escapeHtml(ex.reps || '12')}" required />
    </label>
    <label>Descanso (s)
      <input type="number" class="wk-ex-rest" min="0" value="${Number(ex.rest_seconds ?? 60)}" />
    </label>
    <label>Carga (opcional)
      <input type="text" class="wk-ex-load" value="${escapeHtml(ex.load_kg || '')}" placeholder="Ex: 20kg" />
    </label>
    <label>Orientação <input type="text" class="wk-ex-notes" value="${escapeHtml(ex.notes || '')}" /></label>
    <div style="display:flex;align-items:center;gap:6px;">
      <div class="wk-ex-preview" style="width:68px;">${window.EXERCISE_LIBRARY?.renderExerciseAnimation(selectedKey, { size: 'sm' }) || ''}</div>
      <button type="button" class="btn btn-danger btn-sm wk-ex-remove">Remover</button>
    </div>
  `;

  const keySel = row.querySelector('.wk-ex-key');
  const nameInput = row.querySelector('.wk-ex-name');
  const preview = row.querySelector('.wk-ex-preview');
  row.dataset.exerciseMuscle = found?.muscle_group || 'Geral';
  keySel.addEventListener('change', () => {
    const item = catalog.find((c) => c.key === keySel.value);
    if (item && item.key !== 'custom') nameInput.value = item.name;
    row.dataset.exerciseMuscle = item?.muscle_group || 'Geral';
    preview.innerHTML = window.EXERCISE_LIBRARY?.renderExerciseAnimation(keySel.value, { size: 'sm' }) || '';
  });
  row.querySelector('.wk-ex-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function loadMemberWorkouts(memberId) {
  const instSel = document.getElementById('wkInstructor');
  const instOpts = (state.instructors || []).map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
  instSel.innerHTML = `<option value="">Sem professor definido</option>${instOpts}`;

  currentProfileWorkouts = await api(`/api/members/${memberId}/workouts`);
  const listEl = document.getElementById('profWorkoutsList');
  if (!currentProfileWorkouts.length) {
    listEl.innerHTML = '<li class="muted">Nenhum treino cadastrado para este aluno.</li>';
    return;
  }
  listEl.innerHTML = currentProfileWorkouts.map((w) => `
    <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
      <span><strong>${escapeHtml(w.title)}</strong>${w.goal ? ` · ${escapeHtml(w.goal)}` : ''} · ${(w.exercises || []).length} exercício(s)</span>
      <span class="inline-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-edit-workout="${w.id}">Editar</button>
        <button type="button" class="btn btn-danger btn-sm" data-delete-workout="${w.id}">Excluir</button>
      </span>
    </li>
  `).join('');
}

document.getElementById('btnNewWorkout').addEventListener('click', async () => {
  try { await loadExerciseCatalog(); } catch (err) { showToast(err.message, true); return; }
  document.getElementById('wkEditId').value = '';
  document.getElementById('workoutForm').reset();
  document.getElementById('wkExercisesRows').innerHTML = '';
  addWorkoutExerciseRow();
  document.getElementById('workoutForm').classList.remove('hidden');
  try { await loadWorkoutTemplates(); } catch (err) { showToast(err.message, true); }
});

document.getElementById('btnUseWorkoutTemplate').addEventListener('click', () => {
  const template = getWorkoutTemplate(document.getElementById('wkTemplateSelect').value);
  if (!template) return;
  document.getElementById('wkTitle').value = template.title;
  document.getElementById('wkGoal').value = template.goal || '';
  document.getElementById('wkNotes').value = template.notes || '';
  const container = document.getElementById('wkExercisesRows');
  container.replaceChildren();
  template.exercises.forEach((exercise) => addWorkoutExerciseRow(exercise, container));
});

document.getElementById('btnCancelWorkout').addEventListener('click', () => {
  document.getElementById('workoutForm').classList.add('hidden');
});

document.getElementById('btnAddWorkoutEx').addEventListener('click', () => addWorkoutExerciseRow());

document.getElementById('profWorkoutsList').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-workout]');
  if (editBtn) {
    const wk = currentProfileWorkouts.find((w) => Number(w.id) === Number(editBtn.dataset.editWorkout));
    if (!wk) return;
    try { await loadExerciseCatalog(); } catch (err) { showToast(err.message, true); return; }
    document.getElementById('wkEditId').value = wk.id;
    document.getElementById('wkTitle').value = wk.title || '';
    document.getElementById('wkGoal').value = wk.goal || '';
    document.getElementById('wkInstructor').value = wk.instructor_id || '';
    document.getElementById('wkNotes').value = wk.notes || '';
    document.getElementById('wkExercisesRows').innerHTML = '';
    (wk.exercises || []).forEach((ex) => addWorkoutExerciseRow(ex));
    if (!(wk.exercises || []).length) addWorkoutExerciseRow();
    document.getElementById('workoutForm').classList.remove('hidden');
    loadWorkoutTemplates().catch((err) => showToast(err.message, true));
    return;
  }

  const delBtn = e.target.closest('[data-delete-workout]');
  if (delBtn) {
    const wkId = Number(delBtn.dataset.deleteWorkout);
    if (!confirm('Excluir este treino do aluno?')) return;
    try {
      await api(`/api/workouts/${wkId}`, { method: 'DELETE' });
      showToast('Treino excluído!');
      await loadMemberWorkouts(state.selectedProfileId);
    } catch (err) {
      showToast(err.message, true);
    }
  }
});

function readWorkoutExercises(containerId) {
  const catalog = workoutExerciseChoices();
  return [...document.getElementById(containerId).querySelectorAll('.wk-ex-row')].map((row, idx) => {
    const key = row.querySelector('.wk-ex-key').value;
    const cat = catalog.find((c) => c.key === key);
    return {
      exercise_key: key,
      exercise_name: row.querySelector('.wk-ex-name').value.trim(),
      muscle_group: cat?.muscle_group || row.dataset.exerciseMuscle || 'Geral',
      sets: Number(row.querySelector('.wk-ex-sets').value || 3),
      reps: row.querySelector('.wk-ex-reps').value.trim() || '12',
      rest_seconds: Number(row.querySelector('.wk-ex-rest').value || 60),
      load_kg: row.querySelector('.wk-ex-load').value.trim() || null,
      notes: row.querySelector('.wk-ex-notes').value.trim() || null,
      sort_order: idx,
    };
  });
}

const workoutExamples = () => window.EXERCISE_LIBRARY?.WORKOUT_EXAMPLES || [];
function getWorkoutTemplate(value) {
  return value.startsWith('example:') ? workoutExamples().find((item) => item.key === value.slice(8))
    : workoutTemplates.find((item) => item.id === Number(value));
}

async function loadWorkoutTemplates() {
  workoutTemplates = await api('/api/workout-templates');
  const options = workoutTemplates.map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`);
  const examples = workoutExamples();
  options.push(...examples.map((item) => `<option value="example:${item.key}">Exemplo · ${escapeHtml(item.title)}</option>`));
  document.getElementById('wkTemplateSelect').innerHTML = '<option value="">Escolha um modelo</option>' + options.join('');
  const quickSel = document.getElementById('profQuickTemplateSelect');
  if (quickSel) {
    quickSel.innerHTML = '<option value="">Escolha um modelo predefinido...</option>' + options.join('');
  }
  document.getElementById('workoutTemplatesList').innerHTML = [...workoutTemplates, ...examples].map((item) => `
    <li class="enrollment-row">
      <div><strong>${escapeHtml(item.title)}</strong><div class="muted">${item.id ? 'Modelo salvo' : 'Exemplo'} · ${item.exercises.length} exercícios</div></div>
      <div class="inline-actions">
        <button class="btn btn-secondary btn-sm" type="button" data-template="${item.id || `example:${item.key}`}">${item.id ? 'Editar' : 'Usar como base'}</button>
        ${item.id ? `<button class="btn btn-secondary btn-sm" type="button" data-delete-template="${item.id}">Excluir</button>` : ''}
      </div>
    </li>`).join('');
}

function editWorkoutTemplate(template = {}) {
  document.getElementById('templateId').value = template.id || '';
  document.getElementById('templateTitle').value = template.title || '';
  document.getElementById('templateGoal').value = template.goal || '';
  document.getElementById('templateNotes').value = template.notes || '';
  const container = document.getElementById('templateRows');
  container.replaceChildren();
  (template.exercises || [{}]).forEach((exercise) => addWorkoutExerciseRow(exercise, container));
  document.getElementById('workoutTemplateForm').classList.remove('hidden');
  document.getElementById('templateTitle').focus();
}

document.getElementById('btnNewTemplate').addEventListener('click', async () => {
  if (await loadTab('workouts')) editWorkoutTemplate();
});
document.getElementById('btnAddTemplateExercise').addEventListener('click', () => addWorkoutExerciseRow({}, document.getElementById('templateRows')));
document.getElementById('btnCancelTemplate').addEventListener('click', () => document.getElementById('workoutTemplateForm').classList.add('hidden'));
document.getElementById('workoutTemplatesList').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-template]');
  if (edit) {
    editWorkoutTemplate(getWorkoutTemplate(edit.dataset.template));
    return;
  }
  const remove = event.target.closest('[data-delete-template]');
  if (!remove || !confirm('Excluir este modelo de treino?')) return;
  await withLoading(remove, async () => {
    try {
      await api(`/api/workout-templates/${remove.dataset.deleteTemplate}`, { method: 'DELETE' });
      if (document.getElementById('templateId').value === remove.dataset.deleteTemplate) {
        document.getElementById('workoutTemplateForm').classList.add('hidden');
      }
      await loadWorkoutTemplates();
      showToast('Modelo excluído.');
    } catch (err) { showToast(err.message, true); }
  });
});

document.getElementById('workoutTemplateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.getElementById('templateId').value;
  await withLoading(form, async () => {
    try {
      await api(id ? `/api/workout-templates/${id}` : '/api/workout-templates', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify({
          title: document.getElementById('templateTitle').value,
          goal: document.getElementById('templateGoal').value,
          notes: document.getElementById('templateNotes').value,
          exercises: readWorkoutExercises('templateRows'),
        }),
      });
      form.classList.add('hidden');
      await loadWorkoutTemplates();
      showToast('Modelo de treino salvo.');
    } catch (err) { showToast(err.message, true); }
  });
});

document.getElementById('workoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedProfileId) return;
  const exercises = readWorkoutExercises('wkExercisesRows');

  const payload = {
    title: document.getElementById('wkTitle').value.trim(),
    goal: document.getElementById('wkGoal').value.trim() || null,
    instructor_id: document.getElementById('wkInstructor').value || null,
    notes: document.getElementById('wkNotes').value.trim() || null,
    exercises,
  };

  await withLoading(e.currentTarget, async () => {
    try {
      const editId = document.getElementById('wkEditId').value.trim();
      if (editId) {
        await api(`/api/workouts/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Treino atualizado!');
      } else {
        await api(`/api/members/${state.selectedProfileId}/workouts`, { method: 'POST', body: JSON.stringify(payload) });
        showToast('Treino criado!');
      }
      document.getElementById('workoutForm').classList.add('hidden');
      await loadMemberWorkouts(state.selectedProfileId);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Recibo Térmico MP-4200 (80mm) ---
let currentReceiptHtml = '';

function isAutoPrintReceiptEnabled() {
  return localStorage.getItem('oxigenio_auto_receipt') !== '0';
}

function showReceiptModal(html) {
  currentReceiptHtml = html;
  const chk = document.getElementById('chkAutoPrintReceipt');
  if (chk) chk.checked = isAutoPrintReceiptEnabled();
  const frame = document.getElementById('rcpPreviewFrame');
  if (frame) frame.srcdoc = html;
  showModal('receiptPreviewModal', 'btnPrintReceiptNow');
}

function openPaymentReceipt(payment, memberObj = null) {
  if (!window.MP4200_RECEIPT || !payment) return;
  const member = memberObj || (state.allMembers || []).find((m) => Number(m.id) === Number(payment.member_id));
  const plan = (state.plans || []).find((p) => Number(p.id) === Number(payment.plan_id));
  const validUntil = payment.enrollment_ends_on || '';
  const html = window.MP4200_RECEIPT.buildReceiptHtml({
    gymName: state.gymName || document.getElementById('sGymName')?.value || 'Academia Oxigênio',
    gymPhone: state.gymPhone || document.getElementById('sGymPhone')?.value || '',
    receiptNumber: String(payment.id || '-').padStart(6, '0'),
    issuedAt: fmtDateTime(payment.paid_at || new Date().toISOString()),
    kind: 'MENSALIDADE',
    customerName: payment.member_name || member?.name || 'Aluno',
    customerDoc: member?.document || '',
    items: [
      {
        title: payment.plan_name || plan?.name || 'Mensalidade / Plano',
        detail: plan?.duration_days ? `${plan.duration_days} dias` : '1x',
        amountCents: payment.amount_cents,
      },
    ],
    totalCents: payment.amount_cents,
    paymentMethod: methodName(payment.method),
    validUntil: validUntil ? fmtDate(validUntil) : '',
    operatorName: payment.staff_name || '',
  });
  showReceiptModal(html);
}

function openSaleReceipt(sale, memberObj = null) {
  if (!window.MP4200_RECEIPT || !sale) return;
  const product = (state.products || []).find((p) => Number(p.id) === Number(sale.product_id));
  const html = window.MP4200_RECEIPT.buildReceiptHtml({
    gymName: state.gymName || document.getElementById('sGymName')?.value || 'Academia Oxigênio',
    gymPhone: state.gymPhone || document.getElementById('sGymPhone')?.value || '',
    receiptNumber: `V-${String(sale.id || '-').padStart(5, '0')}`,
    issuedAt: fmtDateTime(sale.sold_at || new Date().toISOString()),
    kind: 'VENDA',
    customerName: sale.member_name || memberObj?.name || 'Consumidor avulso',
    customerDoc: sale.member_document || memberObj?.document || '',
    items: [
      {
        title: sale.product_name || product?.name || 'Produto',
        detail: `${sale.quantity || 1}x`,
        amountCents: sale.total_cents,
      },
    ],
    totalCents: sale.total_cents,
    paymentMethod: methodName(sale.method),
  });
  showReceiptModal(html);
}

document.getElementById('paymentsBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-print-payment]');
  if (!btn) return;
  const pay = (state.paymentsList || []).find((p) => Number(p.id) === Number(btn.dataset.printPayment));
  if (pay) openPaymentReceipt(pay);
});

document.getElementById('profPaymentsList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-print-prof-payment]');
  if (!btn) return;
  const pay = (state.selectedProfilePayments || []).find((p) => Number(p.id) === Number(btn.dataset.printProfPayment));
  if (pay) openPaymentReceipt(pay, state.selectedProfileMember);
});

let paymentsSearchTimer = null;
document.getElementById('paymentsSearch').addEventListener('input', () => {
  clearTimeout(paymentsSearchTimer);
  paymentsSearchTimer = setTimeout(() => loadPayments().catch(() => {}), 220);
});

document.getElementById('salesHistoryBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-print-sale]');
  if (!btn) return;
  const sale = (state.salesList || []).find((s) => Number(s.id) === Number(btn.dataset.printSale));
  if (sale) openSaleReceipt(sale);
});

document.getElementById('btnCloseReceiptModal').addEventListener('click', () => {
  hideModal('receiptPreviewModal');
});

document.getElementById('btnPrintReceiptNow').addEventListener('click', () => {
  if (currentReceiptHtml) window.MP4200_RECEIPT.printReceiptHtml(currentReceiptHtml);
});

document.getElementById('chkAutoPrintReceipt').addEventListener('change', (e) => {
  localStorage.setItem('oxigenio_auto_receipt', e.target.checked ? '1' : '0');
});

// --- Crédito do Aluno ---
document.getElementById('pUseCredit')?.addEventListener('change', renderBillingSummary);

function renderMemberCredit({ credit_cents = 0, logs = [] }) {
  document.getElementById('profCreditBalance').textContent = `Saldo: ${fmtMoney(credit_cents)}`;
  const kpiCreditEl = document.getElementById('profKpiCredit');
  if (kpiCreditEl) kpiCreditEl.textContent = fmtMoney(credit_cents);
  document.getElementById('profCreditLogsList').innerHTML = logs.length
    ? logs.slice(0, 8).map((l) => {
        const sign = l.delta_cents >= 0 ? '+' : '-';
        return `<li>${escapeHtml(fmtDateTime(l.created_at))} · <strong>${sign}${fmtMoney(Math.abs(l.delta_cents))}</strong> (Saldo: ${fmtMoney(l.balance_after_cents)}) — ${escapeHtml(l.reason || '')}</li>`;
      }).join('')
    : '<li class="muted">Nenhuma movimentação de crédito.</li>';
}

async function loadMemberCredit(memberId) {
  const data = await api(`/api/members/${memberId}/credit`);
  renderMemberCredit(data);
}

document.getElementById('creditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedProfileId) return;
  await withLoading(e.target, async () => {
    try {
      const data = await api(`/api/members/${state.selectedProfileId}/credit`, {
        method: 'POST',
        body: JSON.stringify({
          type: document.getElementById('creditType').value,
          amount_cents: toCents(document.getElementById('creditAmount').value),
          reason: document.getElementById('creditReason').value.trim(),
        }),
      });
      e.target.reset();
      renderMemberCredit(data);
      showToast(`Crédito atualizado! Saldo: ${fmtMoney(data.credit_cents)}`);
      await loadMembers();
      if (Number(document.getElementById('pMember').value) === Number(state.selectedProfileId)) {
        renderBillingSummary();
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

attachCpfValidation('mDoc', 'mDocFeedback', () => 0);
attachCpfValidation('stDoc', 'stDocFeedback', () => 0);
attachCpfValidation('profDoc', 'profDocFeedback', () => state.selectedProfileId || 0);

// --- Visitante / Day Use ---
document.getElementById('visitorForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/visitors', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('visName').value.trim(),
          document: document.getElementById('visDoc').value.trim() || null,
          phone: document.getElementById('visPhone').value.trim() || null,
          valid_until: document.getElementById('visValidUntil').value || null,
        }),
      });
      e.target.reset();
      const id = res.visitor?.id;
      showToast(res.sync?.synced === false
        ? `Visitante #${id} criado. Aviso catraca: ${res.sync.error}`
        : `Visitante #${id} liberado!`);
      await Promise.all([loadDashboard(), loadMembers()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Trancamento, Contrato/PAR-Q e Avaliação Física (Perfil do Aluno) ---
document.getElementById('freezeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const rawDays = document.getElementById('freezeDays').value.trim();
  const reason = document.getElementById('freezeReason').value.trim() || null;
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/freeze`, {
        method: 'POST',
        body: JSON.stringify({
          days: rawDays ? Number(rawDays) : null,
          reason,
        }),
      });
      showToast('Matrícula trancada.');
      if (!patchMemberInState(res.member || { id, frozen_until: res.frozen_until, frozen_reason: reason })) {
        await loadMembers();
      }
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnUnfreezeMember')?.addEventListener('click', async (e) => {
  const id = state.selectedProfileId;
  if (!id) return;
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/unfreeze`, { method: 'POST' });
      showToast(`Matrícula destrancada (+${res.extendedDays || 0} dia(s) estendidos).`);
      if (!patchMemberInState(res.member || { id, frozen_until: null, frozen_reason: null })) {
        await loadMembers();
      }
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('contractForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const signature = document.getElementById('contractSignature').value.trim();
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/members/${id}/contract`, {
        method: 'POST',
        body: JSON.stringify({ signature }),
      });
      showToast('PAR-Q e Contrato assinados!');
      patchMemberInState(res.member || { id, contract_signed_at: new Date().toISOString(), contract_signature: signature });
      await openProfile(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadMemberAssessments(memberId) {
  const listEl = document.getElementById('profAssessmentsList');
  if (!listEl) return;
  const rows = await api(`/api/members/${memberId}/assessments`).catch(() => []);
  listEl.innerHTML = rows.length
    ? rows.map((a) => {
        const metrics = [
          a.weight_kg != null ? `${a.weight_kg} kg` : '',
          a.height_cm != null ? `${a.height_cm} cm` : '',
          a.body_fat_pct != null ? `${a.body_fat_pct}% gord.` : '',
          a.muscle_mass_kg != null ? `${a.muscle_mass_kg} kg magra` : '',
          a.waist_cm != null ? `Cintura ${a.waist_cm} cm` : '',
        ].filter(Boolean).join(' · ');
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <span><strong>${escapeHtml(fmtDate(a.assessed_at))}</strong> — ${escapeHtml(metrics || 'Sem medidas')}${a.notes ? ` · ${escapeHtml(a.notes)}` : ''}</span>
          <button type="button" class="btn btn-danger btn-sm" data-delete-assessment="${a.id}">Excluir</button>
        </li>`;
      }).join('')
    : '<li class="muted">Nenhuma avaliação física registrada.</li>';
}

document.getElementById('assessmentForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.selectedProfileId;
  if (!id) return;
  const num = (elId) => {
    const v = document.getElementById(elId)?.value;
    return v === '' || v == null ? null : Number(v);
  };
  await withLoading(e.currentTarget, async () => {
    try {
      await api(`/api/members/${id}/assessments`, {
        method: 'POST',
        body: JSON.stringify({
          weight_kg: num('assWeight'),
          height_cm: num('assHeight'),
          body_fat_pct: num('assBodyFat'),
          muscle_mass_kg: num('assMuscle'),
          waist_cm: num('assWaist'),
          notes: document.getElementById('assNotes').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Avaliação física salva!');
      await loadMemberAssessments(id);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('profAssessmentsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-assessment]');
  if (!btn || !window.confirm('Excluir esta avaliação física?')) return;
  await withLoading(btn, async () => {
    try {
      await api(`/api/assessments/${btn.dataset.deleteAssessment}`, { method: 'DELETE' });
      showToast('Avaliação excluída.');
      if (state.selectedProfileId) await loadMemberAssessments(state.selectedProfileId);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Financeiro: DRE, Despesas, Comissões e Cobrança Automática ---
async function loadFinanceSection(month) {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  const [dre, expenses, commissions] = await Promise.all([
    api(`/api/finance/dre${qs}`).catch(() => null),
    api(`/api/finance/expenses${qs}`).catch(() => []),
    api('/api/finance/commissions').catch(() => []),
  ]);

  if (dre) {
    document.getElementById('dreRevenue').textContent = fmtMoney(dre.revenue_cents);
    document.getElementById('dreExpensesPaid').textContent = fmtMoney(dre.expenses_paid_cents);
    document.getElementById('dreExpensesPending').textContent = fmtMoney(dre.expenses_pending_cents);
    const netEl = document.getElementById('dreNetProfit');
    netEl.textContent = fmtMoney(dre.net_profit_cents);
    netEl.className = `card-value ${dre.net_profit_cents < 0 ? 'text-danger' : 'text-success'}`;
  }

  const expBody = document.getElementById('expensesBody');
  if (expBody) {
    expBody.innerHTML = expenses.length
      ? expenses.map((ex) => `<tr>
          <td>${escapeHtml(ex.description)}</td>
          <td>${escapeHtml(ex.category)}</td>
          <td>${escapeHtml(fmtDate(ex.due_date))}</td>
          <td>${fmtMoney(ex.amount_cents)}</td>
          <td><span class="badge ${ex.status === 'paid' ? 'badge-active' : 'badge-pending'}">${ex.status === 'paid' ? 'Pago' : 'Pendente'}</span></td>
          <td class="inline-actions">
            ${ex.status !== 'paid' ? `<button type="button" class="btn btn-success btn-sm" data-pay-expense="${ex.id}">Pagar</button>` : ''}
            <button type="button" class="btn btn-danger btn-sm" data-del-expense="${ex.id}">Excluir</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty-cell">Nenhuma despesa lançada.</td></tr>';
  }

  const commBody = document.getElementById('commissionsBody');
  if (commBody) {
    commBody.innerHTML = commissions.length
      ? commissions.map((c) => `<tr>
          <td>${escapeHtml(c.staff_name)}</td>
          <td>${escapeHtml(c.source_type)}</td>
          <td>${fmtMoney(c.amount_cents)}</td>
          <td><span class="badge ${c.status === 'paid' ? 'badge-active' : 'badge-pending'}">${c.status === 'paid' ? 'Paga' : 'Pendente'}</span></td>
          <td>${c.status !== 'paid' ? `<button type="button" class="btn btn-success btn-sm" data-pay-commission="${c.id}">Pagar</button>` : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty-cell">Nenhuma comissão registrada.</td></tr>';
  }
}

document.getElementById('expenseForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/finance/expenses', {
        method: 'POST',
        body: JSON.stringify({
          description: document.getElementById('expDesc').value.trim(),
          category: document.getElementById('expCategory').value.trim() || 'geral',
          amount_cents: toCents(document.getElementById('expAmount').value),
          due_date: document.getElementById('expDueDate').value,
          notes: document.getElementById('expNotes').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Despesa lançada.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('expensesBody')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-expense]');
  if (payBtn) {
    await withLoading(payBtn, async () => {
      try {
        await api(`/api/finance/expenses/${payBtn.dataset.payExpense}/pay`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Despesa marcada como paga.');
        await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const delBtn = e.target.closest('[data-del-expense]');
  if (delBtn && window.confirm('Excluir esta despesa?')) {
    await withLoading(delBtn, async () => {
      try {
        await api(`/api/finance/expenses/${delBtn.dataset.delExpense}`, { method: 'DELETE' });
        showToast('Despesa excluída.');
        await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

document.getElementById('commissionForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/finance/commissions', {
        method: 'POST',
        body: JSON.stringify({
          staff_name: document.getElementById('commStaffName').value.trim(),
          source_type: document.getElementById('commSourceType').value,
          amount_cents: toCents(document.getElementById('commAmount').value),
          description: document.getElementById('commDesc').value.trim() || null,
        }),
      });
      e.target.reset();
      showToast('Comissão lançada.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('commissionsBody')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-commission]');
  if (!payBtn) return;
  await withLoading(payBtn, async () => {
    try {
      await api(`/api/finance/commissions/${payBtn.dataset.payCommission}/pay`, { method: 'POST' });
      showToast('Comissão paga.');
      await loadFinanceSection(document.getElementById('reportMonth')?.value || '');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnAutoCollection')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/finance/auto-collection', { method: 'POST' });
      showToast(`Cobrança automática executada: ${res.queued ?? 0} mensagem(ns) enfileirada(s).`);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Multi-leitor, RBAC, Auditoria & Backup ---
document.getElementById('btnSyncAllReaders')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/devices/readers/sync-all', { method: 'POST' });
      showToast(`Sincronização concluída: ${res.totalSynced ?? 0} face(s), ${res.totalErrors ?? 0} erro(s).`, (res.totalErrors ?? 0) > 0);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

async function loadRbacUsers() {
  const body = document.getElementById('rbacUsersBody');
  if (!body) return;
  const users = await api('/api/auth/users');
  body.innerHTML = users.length
    ? users.map((u) => `<tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.role)}</td>
        <td><span class="badge ${u.active ? 'badge-active' : 'badge-blocked'}">${u.active ? 'Ativo' : 'Inativo'}</span></td>
        <td class="inline-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-toggle-rbac-user="${u.id}" data-next-active="${u.active ? 0 : 1}">${u.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-del-rbac-user="${u.id}">Excluir</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty-cell">Nenhum usuário RBAC cadastrado.</td></tr>';
}

document.getElementById('rbacUserForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('rbacUsername').value.trim(),
          password: document.getElementById('rbacPassword').value,
          role: document.getElementById('rbacRole').value,
        }),
      });
      e.target.reset();
      showToast('Usuário criado.');
      await loadRbacUsers();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('rbacUsersBody')?.addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('[data-toggle-rbac-user]');
  if (toggleBtn) {
    await withLoading(toggleBtn, async () => {
      try {
        await api(`/api/auth/users/${toggleBtn.dataset.toggleRbacUser}`, {
          method: 'PUT',
          body: JSON.stringify({ active: Number(toggleBtn.dataset.nextActive) }),
        });
        showToast('Usuário atualizado.');
        await loadRbacUsers();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    return;
  }
  const delBtn = e.target.closest('[data-del-rbac-user]');
  if (delBtn && window.confirm('Excluir este usuário?')) {
    await withLoading(delBtn, async () => {
      try {
        await api(`/api/auth/users/${delBtn.dataset.delRbacUser}`, { method: 'DELETE' });
        showToast('Usuário excluído.');
        await loadRbacUsers();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

async function loadAuditLogs() {
  const body = document.getElementById('auditLogsBody');
  if (!body) return;
  const rows = await api('/api/audit-logs?limit=50');
  body.innerHTML = rows.length
    ? rows.map((r) => `<tr>
        <td>${escapeHtml(fmtDateTime(r.created_at))}</td>
        <td>${escapeHtml(r.actor_user || 'sistema')}</td>
        <td>${escapeHtml(r.action)}</td>
        <td>${escapeHtml([r.entity, r.entity_id].filter(Boolean).join(' #') || '—')}</td>
        <td>${escapeHtml(r.details || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-cell">Nenhum registro de auditoria.</td></tr>';
}

document.getElementById('btnRefreshAudit')?.addEventListener('click', (e) => {
  withLoading(e.currentTarget, () => loadAuditLogs().catch((err) => showToast(err.message, true)));
});

async function loadBackups() {
  const list = document.getElementById('backupsList');
  if (!list) return;
  const files = await api('/api/backups');
  list.innerHTML = files.length
    ? files.map((f) => {
        const name = typeof f === 'string' ? f : f.filename;
        const sizeKb = typeof f === 'object' && f.size ? ` (${Math.round(f.size / 1024)} KB)` : '';
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span>${escapeHtml(name)}${escapeHtml(sizeKb)}</span>
          <a class="btn btn-secondary btn-sm" href="/api/backups/${encodeURIComponent(name)}" download>Baixar</a>
        </li>`;
      }).join('')
    : '<li class="muted">Nenhum backup disponível.</li>';
}

document.getElementById('btnCreateBackup')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api('/api/backups', { method: 'POST' });
      const driveNote = res.gdrive?.ok
        ? ' e enviado ao Google Drive!'
        : (res.gdrive?.error ? ` (aviso Drive: ${res.gdrive.error})` : '');
      showToast(`Backup gerado: ${res.filename || 'OK'}${driveNote}`, Boolean(res.gdrive?.error));
      await Promise.all([loadBackups(), loadSettings()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function toggleGdriveModeFields() {
  const mode = document.getElementById('gdriveMode')?.value || 'api';
  const isLocal = mode === 'local';
  document.getElementById('gdriveLocalDirWrap')?.classList.toggle('hidden', !isLocal);
  document.getElementById('gdriveApiFields')?.classList.toggle('hidden', isLocal);
  document.getElementById('btnGdriveConnect')?.classList.toggle('hidden', isLocal);
}

document.getElementById('gdriveMode')?.addEventListener('change', toggleGdriveModeFields);

async function saveGdriveSettingsFromForm() {
  const payload = {
    backup_gdrive_enabled: document.getElementById('gdriveEnabled')?.checked ? 'true' : 'false',
    backup_gdrive_mode: document.getElementById('gdriveMode')?.value || 'api',
    backup_gdrive_local_dir: document.getElementById('gdriveLocalDir')?.value.trim() || '',
    backup_gdrive_folder_id: document.getElementById('gdriveFolderId')?.value.trim() || '',
    backup_gdrive_client_id: document.getElementById('gdriveClientId')?.value.trim() || '',
  };
  const secret = document.getElementById('gdriveClientSecret')?.value.trim();
  if (secret) payload.backup_gdrive_client_secret = secret;
  const refresh = document.getElementById('gdriveRefreshToken')?.value.trim();
  if (refresh) payload.backup_gdrive_refresh_token = refresh;
  const sa = document.getElementById('gdriveServiceAccount')?.value.trim();
  if (sa) payload.backup_gdrive_service_account_json = sa;
  await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
}

document.getElementById('gdriveBackupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      showToast('Configuração do Google Drive salva.');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnGdriveConnect')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      const { url } = await api('/api/backups/gdrive/auth-url');
      window.location.href = url;
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnGdriveSyncNow')?.addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, async () => {
    try {
      await saveGdriveSettingsFromForm();
      const res = await api('/api/backups/gdrive/sync', { method: 'POST' });
      showToast(`Backup enviado para o Google Drive: ${res.gdrive?.filename || 'OK'}`);
      await Promise.all([loadBackups(), loadSettings()]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// --- Pagamento Dividido & Débitos em Aberto ---
function getActiveMethodsForSplit() {
  return (state.paymentMethods || []).filter((pm) => pm.active);
}

function addSplitRow(preferredCode = null, amountValue = '') {
  const container = document.getElementById('pSplitRows');
  if (!container) return;
  const methods = getActiveMethodsForSplit();
  const optionsHtml = methods
    .map((pm) => `<option value="${escapeHtml(pm.code)}" ${pm.code === preferredCode ? 'selected' : ''}>${escapeHtml(pm.name)}</option>`)
    .join('');
  const row = document.createElement('div');
  row.className = 'split-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 130px auto;gap:8px;align-items:center;';
  row.innerHTML = `
    <select class="split-method" aria-label="Forma de pagamento">${optionsHtml}</select>
    <input type="number" min="0" step="0.01" class="split-amount" placeholder="0,00" value="${escapeHtml(amountValue)}" aria-label="Valor nesta forma (R$)" />
    <button type="button" class="btn btn-secondary btn-sm split-remove" title="Remover forma" aria-label="Remover forma">&times;</button>
  `;
  container.appendChild(row);
}

function resetSplitBox() {
  const container = document.getElementById('pSplitRows');
  if (container) {
    container.innerHTML = '';
    const methods = getActiveMethodsForSplit();
    const first = methods.find((m) => m.code === 'cash')?.code || methods[0]?.code || 'cash';
    const second = methods.find((m) => m.code === 'pix')?.code || methods[1]?.code || first;
    addSplitRow(first);
    addSplitRow(second);
  }
  const debtInput = document.getElementById('pDebtAmount');
  if (debtInput) debtInput.value = '0';
  const debtDate = document.getElementById('pDebtDueDate');
  if (debtDate) debtDate.value = '';
}

function readSplitState() {
  const rows = [...document.querySelectorAll('#pSplitRows .split-row')];
  const splitPayments = rows
    .map((row) => ({
      method: row.querySelector('.split-method')?.value || '',
      amount_cents: toCents(row.querySelector('.split-amount')?.value || 0),
    }))
    .filter((item) => item.amount_cents > 0);
  const debtCents = toCents(document.getElementById('pDebtAmount')?.value || 0);
  const paidCents = splitPayments.reduce((acc, item) => acc + item.amount_cents, 0);
  return { splitPayments, debtCents, paidCents, totalCoveredCents: paidCents + debtCents };
}

function syncSplitSummary(targetNetCents) {
  const summaryEl = document.getElementById('pSplitSummary');
  const { paidCents, debtCents, totalCoveredCents } = readSplitState();
  const remaining = Number(targetNetCents || 0) - totalCoveredCents;
  if (summaryEl) {
    summaryEl.textContent = `Pago agora: ${fmtMoney(paidCents)} · Saldo pendente (fiado): ${fmtMoney(debtCents)} · Restante: ${fmtMoney(remaining)}`;
    summaryEl.style.color = remaining === 0 ? 'var(--success)' : 'var(--danger, #f87171)';
  }
  return remaining;
}

document.getElementById('pSplitToggle')?.addEventListener('change', (e) => {
  if (e.target.checked && !document.querySelectorAll('#pSplitRows .split-row').length) {
    resetSplitBox();
  }
  renderBillingSummary();
});

document.getElementById('btnAddSplitRow')?.addEventListener('click', () => {
  addSplitRow();
  renderBillingSummary();
});

document.getElementById('pSplitRows')?.addEventListener('input', () => renderBillingSummary());
document.getElementById('pSplitRows')?.addEventListener('change', () => renderBillingSummary());
document.getElementById('pSplitRows')?.addEventListener('click', (e) => {
  const rm = e.target.closest('.split-remove');
  if (!rm) return;
  const rows = document.querySelectorAll('#pSplitRows .split-row');
  if (rows.length <= 1) {
    rm.closest('.split-row').querySelector('.split-amount').value = '';
  } else {
    rm.closest('.split-row').remove();
  }
  renderBillingSummary();
});

document.getElementById('pDebtAmount')?.addEventListener('input', () => renderBillingSummary());

document.getElementById('btnRestToDebt')?.addEventListener('click', () => {
  const member = state.allMembers.find((entry) => entry.id === Number(document.getElementById('pMember').value));
  const charge = member?.next_charge;
  const baseAmount = charge?.amount ?? toCents(document.getElementById('pAmount').value);
  const creditCents = Number(member?.credit_cents || 0);
  const useCredit = Boolean(document.getElementById('pUseCredit')?.checked);
  const creditUsed = member && creditCents > 0 && useCredit ? Math.min(creditCents, baseAmount) : 0;
  const netTarget = Math.max(0, baseAmount - creditUsed);
  const { paidCents } = readSplitState();
  const restCents = Math.max(0, netTarget - paidCents);
  const debtInput = document.getElementById('pDebtAmount');
  if (debtInput) debtInput.value = (restCents / 100).toFixed(2);
  renderBillingSummary();
});

async function loadOpenDebts() {
  const container = document.getElementById('openDebtsQueue');
  if (!container) return;
  const debts = await api('/api/debts?status=open');
  state.openDebts = debts;
  container.innerHTML = debts.length
    ? debts.map((d) => `
      <div class="billing-member" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;cursor:default;">
        <div class="billing-member-main">
          <strong>${escapeHtml(d.member_name)}</strong>
          <span class="billing-member-meta">Saldo pendente (fiado): <strong>${fmtMoney(d.remaining_cents)}</strong>${d.due_date ? ` · Venc. ${escapeHtml(fmtDate(d.due_date))}` : ''}${d.notes ? ` · ${escapeHtml(d.notes)}` : ''}</span>
        </div>
        <div class="inline-actions billing-member-cta">
          <button type="button" class="btn btn-primary btn-sm" data-pay-debt="${d.id}">Receber</button>
          <button type="button" class="btn btn-secondary btn-sm" data-cancel-debt="${d.id}">Cancelar</button>
        </div>
      </div>
    `).join('')
    : '<p class="muted">Nenhum saldo pendente (fiado) em aberto.</p>';
}

document.getElementById('openDebtsQueue')?.addEventListener('click', async (e) => {
  const payBtn = e.target.closest('[data-pay-debt]');
  if (payBtn) {
    const id = Number(payBtn.dataset.payDebt);
    const debt = (state.openDebts || []).find((d) => d.id === id);
    if (!debt) return;
    document.getElementById('debtPayId').value = String(debt.id);
    document.getElementById('debtPayAmount').value = (Number(debt.remaining_cents) / 100).toFixed(2);
    document.getElementById('debtPayAmount').max = (Number(debt.remaining_cents) / 100).toFixed(2);
    document.getElementById('debtPayNotes').value = '';
    document.getElementById('debtPayInfo').textContent = `${debt.member_name} · Saldo pendente (fiado): ${fmtMoney(debt.remaining_cents)}`;
    document.getElementById('debtPayModal')?.showModal();
    return;
  }
  const cancelBtn = e.target.closest('[data-cancel-debt]');
  if (cancelBtn) {
    const id = Number(cancelBtn.dataset.cancelDebt);
    if (!window.confirm('Cancelar este saldo pendente (fiado) em aberto?')) return;
    await withLoading(cancelBtn, async () => {
      try {
        await api(`/api/debts/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
        showToast('Saldo pendente cancelado.');
        await Promise.all([loadOpenDebts(), loadMembers()]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }
});

document.getElementById('btnCloseDebtPayModal')?.addEventListener('click', () => {
  document.getElementById('debtPayModal')?.close();
});

document.getElementById('debtPayForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = Number(document.getElementById('debtPayId').value);
  await withLoading(e.target, async () => {
    try {
      await api(`/api/debts/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          amount_cents: toCents(document.getElementById('debtPayAmount').value),
          method: document.getElementById('debtPayMethod').value,
          notes: document.getElementById('debtPayNotes').value.trim() || null,
        }),
      });
      document.getElementById('debtPayModal')?.close();
      showToast('Saldo pendente recebido com sucesso!');
      await Promise.all([loadOpenDebts(), loadPayments(), loadMembers(), loadDashboard(), tabRequests.has('cash') ? loadCash() : loadCurrentCash()]);
      if (state.selectedProfileId && !document.getElementById('profileModal')?.classList.contains('hidden')) {
        await loadMemberOpenDebts(state.selectedProfileId);
      }
    } catch (err) {
      if (err.code === 'CASH_CLOSED') {
        document.getElementById('debtPayModal')?.close();
        await openCashFromBilling();
      } else {
        showToast(err.message, true);
      }
    }
  });
});

// --- Gestão Completa de Turmas (Chamada, Fila de Espera e Recorrente) ---
const BOOKING_STATUS_BADGE = {
  confirmed: ['badge-active', 'Confirmado'],
  waitlist: ['badge-pending', 'Lista de espera'],
  attended: ['badge-active', 'Presente'],
  no_show: ['badge-blocked', 'Faltou'],
  canceled: ['badge-neutral', 'Cancelado'],
};

async function loadClassBookings() {
  const classId = document.getElementById('cbClassSelect')?.value;
  const date = document.getElementById('cbDate')?.value;
  const tbody = document.getElementById('cbBookingsBody');
  if (!tbody) return;
  if (!classId || !date) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted">Selecione uma turma e data.</td></tr>';
    return;
  }
  const rows = await api(`/api/classes/${classId}/bookings?date=${encodeURIComponent(date)}`);
  tbody.innerHTML = rows.length
    ? rows.map((b) => {
        const [badgeCls, label] = BOOKING_STATUS_BADGE[b.status] || ['badge-neutral', b.status];
        const canMark = b.status !== 'canceled';
        return `
        <tr>
          <td><strong>${escapeHtml(b.member_name || `#${b.member_id}`)}</strong></td>
          <td><span class="badge ${badgeCls}">${escapeHtml(label)}</span></td>
          <td class="inline-actions">
            ${canMark ? `<button type="button" class="btn btn-success btn-sm" data-cb-attend="${b.id}">Presente</button>` : ''}
            ${canMark ? `<button type="button" class="btn btn-warning btn-sm" data-cb-noshow="${b.id}">Faltou</button>` : ''}
            ${canMark ? `<button type="button" class="btn btn-secondary btn-sm" data-cb-cancel="${b.id}">Cancelar</button>` : ''}
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="3" class="muted">Nenhuma reserva para esta turma nesta data.</td></tr>';
}

document.getElementById('cbClassSelect')?.addEventListener('change', () => loadClassBookings().catch(() => {}));
document.getElementById('cbDate')?.addEventListener('change', () => loadClassBookings().catch(() => {}));
document.getElementById('btnRefreshClassBookings')?.addEventListener('click', (e) => {
  withLoading(e.currentTarget, () => loadClassBookings().catch((err) => showToast(err.message, true)));
});

document.getElementById('cbBookingForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const classId = document.getElementById('cbClassSelect')?.value;
  const date = document.getElementById('cbDate')?.value;
  const member = resolveMemberFromInput(document.getElementById('cbMemberSearch')?.value || '');
  const weeks = Math.min(12, Math.max(1, Number(document.getElementById('cbWeeks')?.value || 1)));
  if (!classId || !date) return showToast('Selecione a turma e a data.', true);
  if (!member) return showToast('Selecione um aluno válido na lista.', true);

  await withLoading(e.currentTarget, async () => {
    try {
      const res = await api(`/api/classes/${classId}/bookings`, {
        method: 'POST',
        body: JSON.stringify({ member_id: member.id, booking_date: date, weeks }),
      });
      if (weeks > 1) {
        showToast(`Reservas criadas: ${(res.created || []).length}${res.skipped?.length ? ` (${res.skipped.length} já existentes)` : ''}.`);
      } else {
        showToast(res.status === 'waitlist' ? 'Turma lotada: aluno adicionado à lista de espera.' : 'Vaga reservada!');
      }
      document.getElementById('cbMemberSearch').value = '';
      await loadClassBookings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('cbBookingsBody')?.addEventListener('click', async (e) => {
  const attendBtn = e.target.closest('[data-cb-attend]');
  const noshowBtn = e.target.closest('[data-cb-noshow]');
  const cancelBtn = e.target.closest('[data-cb-cancel]');
  const btn = attendBtn || noshowBtn || cancelBtn;
  if (!btn) return;
  await withLoading(btn, async () => {
    try {
      if (attendBtn) {
        await api(`/api/bookings/${attendBtn.dataset.cbAttend}/attendance`, { method: 'POST', body: JSON.stringify({ status: 'attended' }) });
        showToast('Presença registrada.');
      } else if (noshowBtn) {
        await api(`/api/bookings/${noshowBtn.dataset.cbNoshow}/attendance`, { method: 'POST', body: JSON.stringify({ status: 'no_show' }) });
        showToast('Falta registrada.');
      } else if (cancelBtn) {
        const res = await api(`/api/bookings/${cancelBtn.dataset.cbCancel}/cancel`, { method: 'POST' });
        showToast(res.promoted ? 'Reserva cancelada e próximo da fila promovido!' : 'Reserva cancelada.');
      }
      await loadClassBookings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// ===== SETTINGS WORKSPACE UX/UI =====
let activeSettingsCategory = 'general';
let lastFocusedWaTemplate = null;

function activateSettingsCategory(category = 'general') {
  activeSettingsCategory = category;
  const searchInput = document.getElementById('settingsSearchInput');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    document.getElementById('btnClearSettingsSearch')?.classList.add('hidden');
  }
  document.getElementById('settingsSearchEmpty')?.classList.add('hidden');

  document.querySelectorAll('#settingsNav .settings-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsCat === category);
  });
  document.querySelectorAll('#settingsContent [data-settings-cat]').forEach((el) => {
    el.classList.toggle('settings-cat-hidden', el.dataset.settingsCat !== category);
  });
}

function filterSettingsContent(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const clearBtn = document.getElementById('btnClearSettingsSearch');
  const emptyEl = document.getElementById('settingsSearchEmpty');
  if (clearBtn) clearBtn.classList.toggle('hidden', !query);

  if (!query) {
    activateSettingsCategory(activeSettingsCategory);
    return;
  }

  document.querySelectorAll('#settingsNav .settings-nav-btn').forEach((btn) => {
    btn.classList.remove('active');
  });

  let visibleCards = 0;
  document.querySelectorAll('#settingsContent > [data-settings-cat]').forEach((block) => {
    if (block.classList.contains('hidden')) {
      block.classList.add('settings-cat-hidden');
      return;
    }
    const nestedCards = block.querySelectorAll('.settings-card');
    if (nestedCards.length > 0) {
      let anyNestedVisible = false;
      nestedCards.forEach((card) => {
        if (card.classList.contains('hidden')) {
          card.classList.add('settings-cat-hidden');
          return;
        }
        const hay = `${card.dataset.settingsKeywords || ''} ${card.textContent || ''}`.toLowerCase();
        const match = hay.includes(query);
        card.classList.toggle('settings-cat-hidden', !match);
        if (match) {
          anyNestedVisible = true;
          visibleCards += 1;
        }
      });
      block.classList.toggle('settings-cat-hidden', !anyNestedVisible);
      return;
    }

    const hay = `${block.dataset.settingsKeywords || ''} ${block.textContent || ''}`.toLowerCase();
    const match = hay.includes(query);
    block.classList.toggle('settings-cat-hidden', !match);
    if (match) visibleCards += 1;
  });

  if (emptyEl) emptyEl.classList.toggle('hidden', visibleCards > 0);
}

document.getElementById('settingsNav')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-nav-btn[data-settings-cat]');
  if (!btn) return;
  activateSettingsCategory(btn.dataset.settingsCat);
});

document.getElementById('settingsSearchInput')?.addEventListener('input', (e) => {
  filterSettingsContent(e.target.value);
});

document.getElementById('btnClearSettingsSearch')?.addEventListener('click', () => {
  activateSettingsCategory(activeSettingsCategory);
  document.getElementById('settingsSearchInput')?.focus();
});

['waTplPayment', 'waTplDue', 'waTplInactive'].forEach((id) => {
  document.getElementById(id)?.addEventListener('focus', (e) => {
    lastFocusedWaTemplate = e.target;
  });
});

document.querySelectorAll('.wa-placeholder-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const token = chip.dataset.placeholder || chip.textContent || '';
    const target = lastFocusedWaTemplate || document.getElementById('waTplDue');
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = `${target.value.slice(0, start)}${token}${target.value.slice(end)}`;
    target.focus();
    const nextPos = start + token.length;
    if (typeof target.setSelectionRange === 'function') {
      target.setSelectionRange(nextPos, nextPos);
    }
  });
});

activateSettingsCategory('general');

// ===== PROFILE MODAL TABS, OPEN DEBTS & QUICK TEMPLATE =====
function activateProfileTab(tabName = 'personal') {
  document.querySelectorAll('#profileTabs .profile-tab-btn').forEach((btn) => {
    const isActive = btn.dataset.profTab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  document.querySelectorAll('#profileModal [data-prof-tab-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.profTabPanel !== tabName);
  });
}

document.getElementById('profileTabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.profile-tab-btn[data-prof-tab]');
  if (!btn || btn.classList.contains('hidden')) return;
  activateProfileTab(btn.dataset.profTab);
});

async function loadMemberOpenDebts(memberId) {
  const listEl = document.getElementById('profOpenDebtsList');
  const totalEl = document.getElementById('profOpenDebtsTotal');
  const kpiDebtEl = document.getElementById('profKpiDebt');
  const badgeEl = document.getElementById('profDebtsCountBadge');
  if (!listEl) return;
  try {
    const debts = await api(`/api/members/${memberId}/debts?status=open`);
    const charges = state.selectedProfileOpenCharges || [];
    state.selectedProfileDebts = debts;
    const totalCents = debts.reduce((sum, d) => sum + Number(d.remaining_cents || 0), 0)
      + charges.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    const openCount = debts.length + charges.length;
    if (totalEl) totalEl.textContent = fmtMoney(totalCents);
    if (kpiDebtEl) kpiDebtEl.textContent = fmtMoney(totalCents);
    if (badgeEl) {
      badgeEl.textContent = String(openCount);
      badgeEl.classList.toggle('hidden', openCount === 0);
    }
    const chargesHtml = charges.map((c) => `
      <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${fmtMoney(c.amount)}</strong>
          <span class="badge badge-pending" style="margin-left:6px;">Em aberto</span>
          <span class="muted"> · Mensalidade do plano · Venc. ${escapeHtml(fmtDate(c.due))}</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-prof-pay-charge="${c.id}">Receber</button>
      </li>
    `).join('');
    const debtsHtml = debts.map((d) => `
      <li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${fmtMoney(d.remaining_cents)}</strong>
          <span class="muted">${d.due_date ? ` · Venc. ${escapeHtml(fmtDate(d.due_date))}` : ''}${d.notes ? ` · ${escapeHtml(d.notes)}` : ''}</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-prof-pay-debt="${d.id}">Receber</button>
      </li>
    `).join('');
    listEl.innerHTML = (chargesHtml + debtsHtml) || '<li class="muted">Nenhuma conta em aberto.</li>';
  } catch (err) {
    listEl.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
  }
}

document.getElementById('profOpenDebtsList')?.addEventListener('click', async (e) => {
  const chargeBtn = e.target.closest('[data-prof-pay-charge]');
  if (chargeBtn) {
    const member = state.selectedProfileMember || state.allMembers.find((m) => Number(m.id) === Number(state.selectedProfileId));
    closeProfileModal(false);
    document.querySelector('.tab[data-tab="billing"]')?.click();
    await loadTab('billing');
    if (member) {
      const fullMember = state.allMembers.find((m) => Number(m.id) === Number(member.id)) || member;
      selectBillingMember(fullMember);
    }
    return;
  }
  const btn = e.target.closest('[data-prof-pay-debt]');
  if (!btn) return;
  const id = Number(btn.dataset.profPayDebt);
  const debt = (state.selectedProfileDebts || []).find((d) => d.id === id);
  if (!debt) return;
  document.getElementById('debtPayId').value = String(debt.id);
  document.getElementById('debtPayAmount').value = (Number(debt.remaining_cents) / 100).toFixed(2);
  document.getElementById('debtPayAmount').max = (Number(debt.remaining_cents) / 100).toFixed(2);
  document.getElementById('debtPayNotes').value = '';
  document.getElementById('debtPayInfo').textContent = `${state.selectedProfileName || 'Aluno'} · Saldo em aberto: ${fmtMoney(debt.remaining_cents)}`;
  document.getElementById('debtPayModal')?.showModal();
});

document.getElementById('btnQuickAddTemplate')?.addEventListener('click', async () => {
  const templateKey = document.getElementById('profQuickTemplateSelect')?.value;
  if (!templateKey) return showToast('Escolha um modelo predefinido na lista.', true);
  try { await loadExerciseCatalog(); } catch (err) { showToast(err.message, true); return; }
  const template = getWorkoutTemplate(templateKey);
  if (!template) return showToast('Modelo de treino não encontrado.', true);
  document.getElementById('wkEditId').value = '';
  document.getElementById('workoutForm').reset();
  document.getElementById('wkTemplateSelect').value = templateKey;
  document.getElementById('wkTitle').value = template.title;
  document.getElementById('wkGoal').value = template.goal || '';
  document.getElementById('wkNotes').value = template.notes || '';
  const container = document.getElementById('wkExercisesRows');
  container.replaceChildren();
  template.exercises.forEach((exercise) => addWorkoutExerciseRow(exercise, container));
  const form = document.getElementById('workoutForm');
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ---- Atendimento / Chat WhatsApp ----
let chatItemsCache = [];
let activeChatPhone = null;
let chatPollTimer = null;

function updateChatNavBadge(data) {
  const badge = document.getElementById('chatNavBadge');
  if (!badge) return;
  const count = Number(data?.needsHumanCount || 0) || Number(data?.unreadTotal || 0);
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderChatList() {
  const listEl = document.getElementById('chatList');
  if (!listEl) return;
  const q = String(document.getElementById('chatSearchInput')?.value || '').trim().toLowerCase();
  const filtered = chatItemsCache.filter((c) => {
    if (!q) return true;
    const name = String(c.member_name || c.contact_name || '').toLowerCase();
    return name.includes(q) || String(c.phone || '').includes(q);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="muted" style="padding:12px;">Nenhuma conversa registrada ainda.</div>';
    return;
  }

  listEl.innerHTML = filtered.map((c) => {
    const title = c.member_name || c.contact_name || c.phone;
    const activeClass = c.phone === activeChatPhone ? ' active' : '';
    const humanTag = Number(c.needs_human) === 1
      ? '<span class="badge badge-pending">Atendente</span>'
      : (Number(c.unread_count) > 0 ? `<span class="badge badge-active">${Number(c.unread_count)}</span>` : '');
    return `
      <button type="button" class="chat-item${activeClass}" data-chat-phone="${escapeHtml(c.phone)}">
        <div class="chat-item-top">
          <strong>${escapeHtml(title)}</strong>
          ${humanTag}
        </div>
        <div class="chat-item-preview">${escapeHtml(c.last_message || '')}</div>
      </button>
    `;
  }).join('');
}

async function openChat(phone) {
  if (!phone) return;
  activeChatPhone = phone;
  renderChatList();
  const data = await api(`/api/whatsapp/chats/${encodeURIComponent(phone)}/messages`);
  const chat = data.chat || { phone };
  const title = chat.member_name || chat.contact_name || chat.phone;
  const paused = Number(chat.bot_paused) === 1;
  const headerEl = document.getElementById('chatHeader');
  if (headerEl) {
    headerEl.innerHTML = `
      <div>
        <strong>${escapeHtml(title)}</strong>
        <div class="muted" style="font-size:12px;">${escapeHtml(chat.phone)}${chat.member_status ? ` · ${escapeHtml(chat.member_status)}` : ''}</div>
      </div>
      <div class="inline-actions">
        <button type="button" id="btnToggleChatBot" class="btn btn-secondary btn-sm">${paused ? 'Retomar bot' : 'Pausar bot'}</button>
      </div>
    `;
    document.getElementById('btnToggleChatBot')?.addEventListener('click', async () => {
      try {
        await api(`/api/whatsapp/chats/${encodeURIComponent(phone)}/bot`, {
          method: 'POST',
          body: JSON.stringify({ paused: !paused }),
        });
        showToast(paused ? 'Bot retomado para este contato.' : 'Bot pausado para este contato.');
        await Promise.all([openChat(phone), loadChats({ skipActiveReload: true })]);
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  const msgsEl = document.getElementById('chatMessages');
  if (msgsEl) {
    msgsEl.innerHTML = (data.messages || []).map((m) => {
      const cls = m.direction === 'in' ? 'in' : 'out';
      const roleCls = m.direction === 'out' ? (m.sender_type === 'bot' ? 'bot' : 'human') : '';
      const who = m.sender_type === 'bot' ? 'Bot IA' : (m.sender_type === 'human' ? 'Atendente' : 'Cliente');
      const rawDate = String(m.created_at || '');
      const time = rawDate.length >= 16 ? `${rawDate.slice(8, 10)}/${rawDate.slice(5, 7)} ${rawDate.slice(11, 16)}` : rawDate;
      let mediaHtml = '';
      if (m.media_url) {
        if (m.media_type === 'image') {
          mediaHtml = `<img src="${escapeHtml(m.media_url)}" alt="Imagem" style="max-width:240px;border-radius:10px;display:block;margin-bottom:6px;cursor:pointer;" onclick="window.open(this.src,'_blank')" />`;
        } else if (m.media_type === 'sticker') {
          mediaHtml = `<img src="${escapeHtml(m.media_url)}" alt="Figurinha" style="max-width:140px;display:block;margin-bottom:6px;" />`;
        } else if (m.media_type === 'audio') {
          mediaHtml = `<audio controls preload="none" src="${escapeHtml(m.media_url)}" style="max-width:240px;height:36px;display:block;margin-bottom:6px;"></audio>`;
        }
      }
      const cleanText = String(m.body || '').replace(/^\[ts=\d+\]\s*/i, '');
      const bodyHtml = cleanText ? `<div>${escapeHtml(cleanText)}</div>` : '';
      return `
        <div class="chat-bubble ${cls} ${roleCls}">
          ${mediaHtml}${bodyHtml}
          <div class="chat-bubble-meta">${escapeHtml(who)} · ${escapeHtml(time)}</div>
        </div>
      `;
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  document.getElementById('chatReplyForm')?.classList.remove('hidden');
}

async function loadChats({ skipActiveReload = false } = {}) {
  const data = await api('/api/whatsapp/chats');
  chatItemsCache = data.items || [];
  updateChatNavBadge(data);
  renderChatList();
  if (!skipActiveReload && activeChatPhone) {
    await openChat(activeChatPhone);
  }
  clearTimeout(chatPollTimer);
  if (state.activeTab === 'chat' && !document.hidden) {
    chatPollTimer = setTimeout(() => {
      if (state.activeTab === 'chat' && !document.hidden) {
        loadChats().catch(() => {});
      }
    }, 5000);
  }
}

document.getElementById('btnRefreshChats')?.addEventListener('click', () => {
  loadChats().catch((err) => showToast(err.message, true));
});
document.getElementById('chatSearchInput')?.addEventListener('input', renderChatList);
document.getElementById('chatList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-chat-phone]');
  if (!btn) return;
  openChat(btn.dataset.chatPhone).catch((err) => showToast(err.message, true));
});
document.getElementById('chatReplyForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeChatPhone) return;
  const input = document.getElementById('chatReplyInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  try {
    await api(`/api/whatsapp/chats/${encodeURIComponent(activeChatPhone)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    input.value = '';
    await Promise.all([openChat(activeChatPhone), loadChats({ skipActiveReload: true })]);
  } catch (err) {
    showToast(err.message, true);
  }
});

// ---- Subaba Contexto do Bot IA (WhatsApp & IA) ----
async function loadWhatsappBotContext() {
  try {
    const data = await api('/api/whatsapp/bot-context');
    const enabledEl = document.getElementById('waBotEnabled');
    const textEl = document.getElementById('waBotContextText');
    if (enabledEl) enabledEl.checked = Boolean(data.enabled);
    if (textEl) textEl.value = data.context || '';
  } catch (err) {
    showToast(err.message, true);
  }
}

document.querySelectorAll('.wa-subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.waSubtab;
    document.querySelectorAll('.wa-subtab-btn').forEach((b) => {
      const active = b.dataset.waSubtab === target;
      b.classList.toggle('btn-primary', active);
      b.classList.toggle('btn-secondary', !active);
      b.setAttribute('aria-selected', String(active));
    });
    document.getElementById('waSubtabRules')?.classList.toggle('hidden', target !== 'rules');
    document.getElementById('waSubtabContext')?.classList.toggle('hidden', target !== 'context');
    if (target === 'context') {
      loadWhatsappBotContext();
    }
  });
});

document.getElementById('waBotContextForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        whatsapp_bot_enabled: document.getElementById('waBotEnabled')?.checked ? '1' : '0',
        whatsapp_bot_context: document.getElementById('waBotContextText')?.value || '',
      }),
    });
    showToast('Contexto do Bot IA salvo com sucesso.');
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btnWaBotContextReset')?.addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ whatsapp_bot_context: '' }),
    });
    await loadWhatsappBotContext();
    showToast('Contexto restaurado para o padrão.');
  } catch (err) {
    showToast(err.message, true);
  }
});
