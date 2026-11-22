const studentState = {
  data: null,
  selectedWorkoutId: null,
  activePixChargeId: null,
  pixPollTimer: null,
  restTimers: {},
  modalExerciseKey: null,
  modalSpeed: 1,
  modalPaused: false,
  completingWorkout: false,
};

function esc(val) {
  return String(val ?? '')
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

function stopPortalPixPolling() {
  if (studentState.pixPollTimer) {
    clearInterval(studentState.pixPollTimer);
    studentState.pixPollTimer = null;
  }
}

function clearAllRestTimers() {
  Object.values(studentState.restTimers).forEach(({ interval }) => clearInterval(interval));
  studentState.restTimers = {};
  studentState.activeRestExerciseId = null;
  document.getElementById('stFloatingRestBar')?.classList.add('hidden');
  document.getElementById('studentPortalView')?.classList.remove('has-floating-rest');
}

function formatTimerMmSs(totalSec) {
  const sec = Math.max(0, Math.ceil(Number(totalSec || 0)));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function syncFloatingRestBar() {
  const bar = document.getElementById('stFloatingRestBar');
  const timeEl = document.getElementById('stFloatingRestTime');
  const labelEl = document.getElementById('stFloatingRestLabel');
  const portal = document.getElementById('studentPortalView');
  if (!bar || !timeEl) return;
  const entries = Object.entries(studentState.restTimers);
  if (!entries.length) {
    studentState.activeRestExerciseId = null;
    bar.classList.add('hidden');
    portal?.classList.remove('has-floating-rest');
    return;
  }
  const [exId, timer] = entries[entries.length - 1];
  studentState.activeRestExerciseId = Number(exId);
  const rem = remainingRestSeconds(timer);
  timeEl.textContent = formatTimerMmSs(rem);
  if (labelEl) {
    labelEl.textContent = timer.exerciseName ? `Descanso · ${timer.exerciseName}` : 'Descanso em andamento';
  }
  bar.classList.remove('hidden');
  portal?.classList.add('has-floating-rest');
}

function switchProgressSubtab(subtab) {
  document.querySelectorAll('[data-progress-subtab]').forEach((b) => {
    const active = b.dataset.progressSubtab === subtab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-progress-panel]').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.progressPanel !== subtab);
  });
}

function switchStudentTab(tab) {
  document.querySelectorAll('.student-tab-btn').forEach((b) => {
    const active = b.dataset.stTab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
    b.tabIndex = active ? 0 : -1;
  });
  document.getElementById('stTabWorkouts').classList.toggle('hidden', tab !== 'workouts');
  document.getElementById('stTabProgress').classList.toggle('hidden', tab !== 'progress');
  document.getElementById('stTabPayments').classList.toggle('hidden', tab !== 'payments');
  document.getElementById('stTabProfile').classList.toggle('hidden', tab !== 'profile');
}

function resetStudentUi() {
  clearAllRestTimers();
  stopPortalPixPolling();
  studentState.data = null;
  studentState.selectedWorkoutId = null;
  studentState.activePixChargeId = null;
  studentState.completingWorkout = false;
  document.getElementById('stPayEmail').value = '';
  document.getElementById('stPixBox').classList.add('hidden');
  const checkout = document.getElementById('stCheckoutBox');
  checkout.classList.add('hidden');
  delete checkout.dataset.chargeId;
  document.getElementById('stCheckoutLink').removeAttribute('href');
  document.getElementById('stPixCode').value = '';
  document.getElementById('stPixQr').src = '';
  document.getElementById('stPixQr').classList.add('hidden');
  document.getElementById('stSubBox').classList.add('hidden');
  document.getElementById('stSubLink').href = '#';
  document.getElementById('stFitnessAlias').value = '';
  switchProgressSubtab('summary');
  switchStudentTab('workouts');
}

async function withBusyButton(btn, fn, busyText = '') {
  if (btn?.disabled) return;
  const prevText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
    if (busyText) btn.textContent = busyText;
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (busyText && btn.textContent === busyText) btn.textContent = prevText;
    }
  }
}

function fmtMoney(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDateBr(iso) {
  if (!iso) return '-';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${isError ? 'err' : 'ok'}`;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
  } catch (networkErr) {
    const err = new Error('Sem conexão com a internet. Verifique sua rede.');
    err.isNetworkError = true;
    err.cause = networkErr;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/status')) {
    await clearStudentOfflineCache();
    resetStudentUi();
    document.getElementById('studentLoginView').classList.remove('hidden');
    document.getElementById('studentPortalView').classList.add('hidden');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Erro HTTP ${res.status}`);
    err.status = res.status;
    err.isNetworkError = res.status === 503;
    throw err;
  }
  return data;
}

function initialsOf(name) {
  const parts = String(name || 'A').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || 'A';
}

function localIsoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function doneStorageKey() {
  const today = localIsoDate();
  const memberId = studentState.data?.member?.id || 'anon';
  return `oxigenio_done_${memberId}_${today}`;
}

function getTodayDoneMap() {
  try {
    return JSON.parse(localStorage.getItem(doneStorageKey()) || '{}');
  } catch {
    return {};
  }
}

function updateWorkoutChecklistUi(exercises, map = getTodayDoneMap()) {
  const checklist = document.getElementById('stWorkoutChecklist');
  const wrap = document.getElementById('stWorkoutProgressWrap');
  const fill = document.getElementById('stWorkoutProgressFill');
  const resetBtn = document.getElementById('btnResetWorkoutCheck');
  const nextBtn = document.getElementById('btnNextPendingExercise');
  const completeBtn = document.getElementById('stCompleteWorkout');

  if (!exercises?.length) {
    if (checklist) checklist.textContent = '';
    wrap?.classList.add('hidden');
    completeBtn?.classList.remove('is-ready');
    return;
  }

  const checked = exercises.filter((exercise) => map[exercise.id]).length;
  const pct = Math.round((checked / exercises.length) * 100);
  if (checklist) {
    checklist.textContent = `${checked} de ${exercises.length} ${exercises.length === 1 ? 'exercício marcado' : 'exercícios marcados'} (${pct}%)`;
  }
  wrap?.classList.remove('hidden');
  if (fill) fill.style.width = `${pct}%`;
  resetBtn?.classList.toggle('hidden', checked === 0);
  nextBtn?.classList.toggle('hidden', checked === exercises.length);
  if (completeBtn && !completeBtn.disabled) {
    const allDone = checked === exercises.length;
    completeBtn.classList.toggle('is-ready', allDone);
    if (!completeBtn.dataset.confirmEmpty) {
      completeBtn.textContent = allDone ? '100% marcado — Concluir treino de hoje ✓' : 'Concluir treino de hoje';
    }
  }
}

function toggleExerciseDone(exId) {
  const map = getTodayDoneMap();
  const nextDone = !map[exId];
  map[exId] = nextDone;
  localStorage.setItem(doneStorageKey(), JSON.stringify(map));

  const btn = document.querySelector(`[data-done-ex="${exId}"]`);
  const card = btn?.closest('.exercise-card');
  if (btn && card) {
    card.classList.toggle('is-done', nextDone);
    btn.classList.toggle('btn-success', nextDone);
    btn.classList.toggle('btn-primary', !nextDone);
    btn.setAttribute('aria-pressed', String(nextDone));
    btn.textContent = nextDone ? 'Feito ✓' : 'Marcar feito';
    const current = (studentState.data?.workouts || []).find((w) => Number(w.id) === Number(studentState.selectedWorkoutId));
    const exercises = current?.exercises || [];
    updateWorkoutChecklistUi(exercises, map);
  } else {
    renderWorkouts();
  }
}

function renderAvatar(imgEl, emptyEl, photo, name) {
  if (photo) {
    imgEl.src = photo;
    imgEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
  } else {
    imgEl.src = '';
    imgEl.classList.add('hidden');
    emptyEl.textContent = initialsOf(name);
    emptyEl.classList.remove('hidden');
  }
}

function computeMemberCelebration(member) {
  if (!member) return null;
  const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
  const now = new Date();
  const todayMmDd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const messages = [];
  let icon = '🎉';
  let title = '';

  const birthMatch = String(member.birth_date || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  if (birthMatch && `${birthMatch[1]}-${birthMatch[2]}` === todayMmDd) {
    icon = '🎂';
    title = `Feliz Aniversário, ${firstName}!`;
    messages.push('A família Academia Oxigênio deseja muita saúde, energia e novas conquistas dentro e fora dos treinos!');
  }

  const createdMatch = String(member.created_at || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (createdMatch) {
    const joined = new Date(Number(createdMatch[1]), Number(createdMatch[2]) - 1, Number(createdMatch[3]));
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor((todayStart - joined) / 86400000);
    const monthsDiff = (todayStart.getFullYear() - joined.getFullYear()) * 12 + (todayStart.getMonth() - joined.getMonth());
    const nearAnniversaryDay = Math.abs(todayStart.getDate() - joined.getDate()) <= 1;

    if (diffDays >= 0 && diffDays <= 1) {
      if (!title) {
        icon = '💪';
        title = `Bem-vindo(a) à Academia Oxigênio, ${firstName}!`;
      }
      messages.push('Que alegria ter você com a gente! Conte com nossa equipe para alcançar seus objetivos.');
    } else if (monthsDiff >= 12 && monthsDiff % 12 === 0 && nearAnniversaryDay) {
      const years = monthsDiff / 12;
      if (!title) {
        icon = '🏆';
        title = `${years} ${years === 1 ? 'ano' : 'anos'} de Academia Oxigênio, ${firstName}!`;
      }
      messages.push(`Parabéns por completar ${years} ${years === 1 ? 'ano' : 'anos'} treinando com a gente! Sua constância inspira.`);
    } else if ([1, 3, 6].includes(monthsDiff) && nearAnniversaryDay) {
      if (!title) {
        icon = '🔥';
        title = `${monthsDiff} ${monthsDiff === 1 ? 'mês' : 'meses'} com a gente, ${firstName}!`;
      }
      messages.push(
        monthsDiff === 1
          ? 'Você completou seu primeiro mês na Academia Oxigênio! O passo mais difícil já foi dado — continue firme!'
          : `Parabéns pelos ${monthsDiff} meses de foco e evolução na Academia Oxigênio!`,
      );
    }
  }

  if (!title || !messages.length) return null;
  return { icon, title, message: messages.join(' ') };
}

function renderCelebrationBanner(member) {
  const banner = document.getElementById('stCelebrationBanner');
  if (!banner) return;
  const dismissKey = `oxigenio_celebration_dismissed_${member.id}_${new Date().toISOString().slice(0, 10)}`;
  if (sessionStorage.getItem(dismissKey)) {
    banner.classList.add('hidden');
    return;
  }
  const celebration = computeMemberCelebration(member);
  if (!celebration) {
    banner.classList.add('hidden');
    return;
  }
  document.getElementById('stCelebrationIcon').textContent = celebration.icon;
  document.getElementById('stCelebrationTitle').textContent = celebration.title;
  document.getElementById('stCelebrationMessage').textContent = celebration.message;
  banner.classList.remove('hidden');

  const closeBtn = document.getElementById('btnDismissCelebration');
  if (closeBtn) {
    closeBtn.onclick = () => {
      sessionStorage.setItem(dismissKey, '1');
      banner.classList.add('hidden');
    };
  }
}

function computeValidityDays(validUntil) {
  if (!validUntil) return null;
  const m = String(validUntil).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueStart = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((dueStart - todayStart) / 86400000);
}

function renderQuickSummary(d) {
  const m = d?.member;
  if (!m) return;
  const valCard = document.getElementById('stSummaryValidityCard');
  const valValue = document.getElementById('stSummaryValidityValue');
  const valSub = document.getElementById('stSummaryValiditySub');
  const weekValue = document.getElementById('stSummaryWeekValue');
  const weekSub = document.getElementById('stSummaryWeekSub');
  const faceValue = document.getElementById('stSummaryFaceValue');
  const faceSub = document.getElementById('stSummaryFaceSub');

  if (valCard && valValue && valSub) {
    valCard.classList.remove('is-warn', 'is-danger');
    if (m.partner_provider === 'wellhub' || m.partner_provider === 'totalpass') {
      valValue.textContent = m.partner_provider === 'wellhub' ? 'Wellhub Ativo' : 'TotalPass Ativo';
      valSub.textContent = 'Convênio corporativo';
    } else {
      const diff = computeValidityDays(m.valid_until);
      if (diff === null) {
        valValue.textContent = m.plan_name || 'Sem vigência';
        valSub.textContent = 'Consulte a aba Pagamentos';
        valCard.classList.add('is-warn');
      } else if (diff < 0) {
        valValue.textContent = `Vencida há ${Math.abs(diff)}d`;
        valSub.textContent = `Venceu em ${fmtDateBr(m.valid_until)}`;
        valCard.classList.add('is-danger');
      } else if (diff === 0) {
        valValue.textContent = 'Vence hoje!';
        valSub.textContent = m.plan_name || 'Renove pelo portal';
        valCard.classList.add('is-warn');
      } else if (diff <= 5) {
        valValue.textContent = `Faltam ${diff} ${diff === 1 ? 'dia' : 'dias'}`;
        valSub.textContent = `Até ${fmtDateBr(m.valid_until)}`;
        valCard.classList.add('is-warn');
      } else {
        valValue.textContent = `Em dia (${diff}d)`;
        valSub.textContent = `Até ${fmtDateBr(m.valid_until)}`;
      }
    }
  }

  if (weekValue && weekSub) {
    const visitsCount = d.fitness?.visits?.length || 0;
    const goal = d.fitness?.goal || 3;
    weekValue.textContent = `${visitsCount} de ${goal} treinos`;
    weekSub.textContent = visitsCount >= goal ? 'Meta da semana batida! 🔥' : `Faltam ${Math.max(0, goal - visitsCount)} na semana`;
  }

  if (faceValue && faceSub) {
    faceValue.textContent = m.face_registered ? 'FaceID Ativo ✓' : 'FaceID Pendente';
    faceSub.textContent = `Matrícula #${m.id}`;
  }
}

function renderFinancialSummary(d) {
  const m = d?.member;
  const grid = document.getElementById('stFinancialCards');
  if (grid && m) {
    const creditCents = Number(m.credit_cents || 0);
    const debtCents = Number(m.open_debt_cents || 0);
    grid.innerHTML = [
      `<div class="student-stat-card"><span class="student-stat-label">Plano Atual</span><strong>${esc(m.plan_name || 'Sem plano')}</strong><small class="muted">Validade: ${fmtDateBr(m.valid_until)}</small></div>`,
      creditCents > 0
        ? `<div class="student-stat-card"><span class="student-stat-label">Crédito Disponível</span><strong class="delta-positive">${fmtMoney(creditCents)}</strong><small class="muted">Abatido na renovação</small></div>`
        : '',
      debtCents > 0
        ? `<div class="student-stat-card is-warn"><span class="student-stat-label">Saldo em Aberto</span><strong class="delta-negative">${fmtMoney(debtCents)}</strong><small class="muted">Acerte na recepção ou Pix</small></div>`
        : '',
    ].filter(Boolean).join('');
  }

  const staticBox = document.getElementById('stStaticPixBox');
  const staticKeyEl = document.getElementById('stStaticPixKeyText');
  const staticTitleEl = document.getElementById('stStaticPixTitle');
  if (staticBox && staticKeyEl) {
    if (d?.pixRecipientKey) {
      staticTitleEl.textContent = d.pixRecipientName ? `Chave Pix — ${d.pixRecipientName}` : 'Chave Pix da Academia';
      staticKeyEl.textContent = d.pixRecipientKey;
      staticBox.classList.remove('hidden');
    } else {
      staticBox.classList.add('hidden');
    }
  }
}

function renderRecentCheckins(d) {
  const listEl = document.getElementById('stRecentCheckinsList');
  if (!listEl) return;
  const items = d?.recentCheckins || [];
  if (!items.length) {
    listEl.innerHTML = '<li class="muted">Nenhum acesso registrado recentemente.</li>';
    return;
  }
  listEl.innerHTML = items.map((c) => {
    const [datePart, timePart] = String(c.occurred_at || '').split(' ');
    return `<li><strong>${fmtDateBr(datePart)}</strong>${timePart ? ` às ${esc(timePart.slice(0, 5))}` : ''} · <span class="muted">${esc(c.event_label || 'Entrada autorizada')}</span></li>`;
  }).join('');
}

function renderPortal() {
  const d = studentState.data;
  if (!d?.member) return;
  const m = d.member;

  document.title = `${m.name} — Portal do Aluno`;
  document.getElementById('stMemberName').textContent = m.name;
  renderCelebrationBanner(m);
  const badge = document.getElementById('stStatusBadge');
  const statusMap = { active: ['Ativo', 'badge-active'], pending: ['Pendente', 'badge-pending'], blocked: ['Bloqueado', 'badge-blocked'] };
  const [label, cls] = statusMap[m.status] || [m.status || '-', 'badge-pending'];
  badge.textContent = label;
  badge.className = `badge ${cls}`;

  const planTxt = m.plan_name ? `${m.plan_name} · Validade: ${fmtDateBr(m.valid_until)}` : 'Sem plano vinculado';
  document.getElementById('stPlanSummary').textContent = planTxt;
  document.getElementById('stPayStatusLine').textContent = `Situação atual: ${label} · ${planTxt}`;

  renderAvatar(document.getElementById('stHeaderAvatar'), document.getElementById('stHeaderInitials'), m.profile_photo, m.name);
  renderAvatar(document.getElementById('stProfilePhotoPreview'), document.getElementById('stProfilePhotoEmpty'), m.profile_photo, m.name);

  // Dados cadastrais
  const mods = (d.modalities || []).map((x) => x.name).join(', ') || m.modality_name || '-';
  const classes = (d.enrollments || []).map((c) => `${c.class_name} (${c.schedule || '-'})`).join(', ') || '-';
  document.getElementById('stMemberDetailsList').innerHTML = [
    `<li><strong>Nome:</strong> ${esc(m.name)}</li>`,
    `<li><strong>CPF:</strong> ${esc(m.document || '-')}</li>`,
    `<li><strong>WhatsApp:</strong> ${esc(m.phone || '-')}</li>`,
    `<li><strong>E-mail:</strong> ${esc(m.email || '-')}</li>`,
    `<li><strong>Modalidades:</strong> ${esc(mods)}</li>`,
    `<li><strong>Turmas:</strong> ${esc(classes)}</li>`,
  ].join('');

  // Senha
  const hasPass = Boolean(m.has_portal_password);
  document.getElementById('stPasswordHint').textContent = hasPass
    ? 'Você já possui uma senha configurada. Informe a senha atual para alterá-la.'
    : 'Você ainda não definiu uma senha personalizada. Crie sua senha abaixo para os próximos acessos.';
  document.getElementById('stCurrentPassWrap').classList.toggle('hidden', !hasPass);

  const firstAccessBanner = document.getElementById('stFirstAccessBanner');
  if (firstAccessBanner) {
    let dismissedFirst = false;
    try {
      dismissedFirst = sessionStorage.getItem('oxigenio_dismiss_first_access') === '1';
    } catch {}
    firstAccessBanner.classList.toggle('hidden', hasPass || dismissedFirst);
  }

  // PAR-Q & Contrato Digital
  const contractStatus = document.getElementById('stContractStatus');
  const contractForm = document.getElementById('stContractForm');
  const contractSigInput = document.getElementById('stContractSignature');
  if (m.contract_signed_at) {
    contractStatus.textContent = `Assinado em ${fmtDateBr(m.contract_signed_at)} (${m.contract_signature || m.name}).`;
    contractForm.classList.add('hidden');
  } else {
    contractStatus.textContent = 'Pendente de assinatura. Assine abaixo para manter seu cadastro completo.';
    contractForm.classList.remove('hidden');
    if (!contractSigInput.value) contractSigInput.value = m.name || '';
  }

  // Planos para pagamento (em cascata: Modalidade/Plano -> Turma se necessário -> Periodicidade)
  renderStudentPaymentSelectors(d);
  if (m.email && !document.getElementById('stPayEmail').value) {
    document.getElementById('stPayEmail').value = m.email;
  }

  // Histórico de pagamentos
  const pays = d.payments || [];
  document.getElementById('stPaymentsList').innerHTML = pays.length
    ? pays.map((p) => `<li>${fmtDateBr(p.paid_at)} · ${esc(p.plan_name || 'Mensalidade')} · ${fmtMoney(p.amount_cents)} (${esc(p.method)})</li>`).join('')
    : '<li class="muted">Nenhum pagamento registrado ainda.</li>';

  const contactPhone = document.getElementById('stContactPhone');
  const contactEmail = document.getElementById('stContactEmail');
  const contactEmergency = document.getElementById('stContactEmergency');
  if (contactPhone) contactPhone.value = m.phone || '';
  if (contactEmail) contactEmail.value = m.email || '';
  if (contactEmergency) contactEmergency.value = m.emergency_contact || '';

  renderQuickSummary(d);
  renderFinancialSummary(d);
  renderRecentCheckins(d);
  renderWorkouts();
  renderFitness();
}

function normalizePlanText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractPlanCategory(planName) {
  let base = String(planName || '')
    .replace(/\(\s*(di[aá]ria|semanal|quinzenal|mensal|bimestral|trimestral|quadrimestral|semestral|anual|\d+\s*dias?)\s*\)/gi, '')
    .replace(/\b(di[aá]ria|semanal|quinzenal|mensal|bimestral|trimestral|quadrimestral|semestral|anual)\b/gi, '')
    .replace(/[-–/|]+$/g, '')
    .replace(/^[-–/|]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return base || String(planName || 'Plano');
}

function extractPlanPeriodLabel(plan) {
  const name = String(plan?.name || '');
  const m = name.match(/\b(di[aá]ria|semanal|quinzenal|mensal|bimestral|trimestral|quadrimestral|semestral|anual)\b/i);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const d = Number(plan?.duration_days || 0);
  if (d <= 1) return 'Diária';
  if (d === 7) return 'Semanal';
  if (d === 15) return 'Quinzenal';
  if (d >= 28 && d <= 31) return 'Mensal';
  if (d >= 58 && d <= 62) return 'Bimestral';
  if (d >= 88 && d <= 93) return 'Trimestral';
  if (d >= 175 && d <= 186) return 'Semestral';
  if (d >= 360 && d <= 366) return 'Anual';
  return `${d} dias`;
}

function categoryRequiresClass(category) {
  const s = normalizePlanText(category);
  return s.includes('nata') || s.includes('hidro') || s.includes('pilates');
}

function updateStudentPaymentCategory() {
  const d = studentState.data;
  const catSel = document.getElementById('stPayCategory');
  const classWrap = document.getElementById('stPayClassWrap');
  const classSel = document.getElementById('stPayClass');
  const planSel = document.getElementById('stPayPlan');
  if (!d || !catSel || !planSel) return;

  const selectedCat = catSel.value;
  const plans = d.plans || [];
  const matchingPlans = plans.filter((p) => extractPlanCategory(p.name) === selectedCat);
  const currentPlanId = Number(d.member?.plan_id || 0);

  planSel.innerHTML = matchingPlans.map((p) => {
    const period = extractPlanPeriodLabel(p);
    return `<option value="${p.id}" ${Number(p.id) === currentPlanId ? 'selected' : ''}>${esc(period)} — ${fmtMoney(p.price_cents)} (${p.duration_days}d)</option>`;
  }).join('');

  if (classWrap && classSel) {
    const needsClass = categoryRequiresClass(selectedCat);
    const catNorm = normalizePlanText(selectedCat);
    const allClasses = d.classes || [];
    const matchingClasses = needsClass
      ? allClasses.filter((c) => {
          const text = normalizePlanText(`${c.modality_name || ''} ${c.name || ''}`);
          if (catNorm.includes('hidro')) return text.includes('hidro');
          if (catNorm.includes('pilates')) return text.includes('pilates');
          if (catNorm.includes('nata')) return text.includes('nata');
          return false;
        })
      : [];

    if (needsClass && matchingClasses.length > 0) {
      const enrolledIds = new Set((d.enrollments || []).map((e) => Number(e.class_id)));
      classSel.innerHTML = `<option value="">Selecione uma turma / horário...</option>${matchingClasses.map((c) => {
        const closed = Number(c.allow_new_enrollments ?? 1) === 0 && !enrolledIds.has(Number(c.id));
        const full = Number(c.capacity || 0) > 0 && Number(c.enrolled_count || 0) >= Number(c.capacity) && !enrolledIds.has(Number(c.id));
        const disabled = closed || full ? 'disabled' : '';
        const suffix = enrolledIds.has(Number(c.id))
          ? ' (sua turma atual)'
          : closed
            ? ' — Fechada'
            : full
              ? ' — Lotada'
              : ` — ${Math.max(0, Number(c.capacity) - Number(c.enrolled_count || 0))} vaga(s)`;
        return `<option value="${c.id}" ${enrolledIds.has(Number(c.id)) ? 'selected' : ''} ${disabled}>${esc(c.name)} (${esc(c.schedule)})${esc(suffix)}</option>`;
      }).join('')}`;
      classWrap.classList.remove('hidden');
    } else {
      classSel.innerHTML = '';
      classWrap.classList.add('hidden');
    }
  }
}

function renderStudentPaymentSelectors(d) {
  const catSel = document.getElementById('stPayCategory');
  if (!catSel) return;
  const plans = d.plans || [];
  const categories = [...new Set(plans.map((p) => extractPlanCategory(p.name)))];
  const currentPlan = plans.find((p) => Number(p.id) === Number(d.member?.plan_id || 0));
  const preferredCat = currentPlan ? extractPlanCategory(currentPlan.name) : categories[0];

  catSel.innerHTML = categories.map((cat) =>
    `<option value="${esc(cat)}" ${cat === preferredCat ? 'selected' : ''}>${esc(cat)}</option>`
  ).join('');
  updateStudentPaymentCategory();
}

function validateStudentPaymentSelection() {
  const classWrap = document.getElementById('stPayClassWrap');
  const classSel = document.getElementById('stPayClass');
  if (classWrap && !classWrap.classList.contains('hidden') && classSel && classSel.options.length > 1 && !classSel.value) {
    showToast('Selecione uma turma / horário para continuar.', true);
    classSel.focus();
    return false;
  }
  return true;
}

document.getElementById('stPayCategory')?.addEventListener('change', updateStudentPaymentCategory);

function renderFitness() {
  const fitness = studentState.data?.fitness;
  if (!fitness) return;
  const { start, end, visits, goal, workoutsThisWeek, achievements, alias, ranking, challenge } = fitness;
  document.getElementById('stFitnessPeriod').textContent = `${fmtDateBr(start)} a ${fmtDateBr(end)}`;
  document.getElementById('stFitnessVisits').textContent = `${visits.length} de ${goal} visitas`;
  const goalSel = document.getElementById('stGoalSelect');
  if (goalSel) goalSel.value = String(goal);
  const goalBar = document.getElementById('stFitnessGoal');
  goalBar.max = goal;
  goalBar.value = visits.length;
  renderQuickSummary(studentState.data);
  document.getElementById('stFitnessDays').textContent = visits.length
    ? visits.map(fmtDateBr).join(' · ')
    : 'Nenhuma visita registrada nesta semana.';
  document.getElementById('stFitnessWorkouts').textContent = workoutsThisWeek === 1
    ? '1 treino concluído nesta semana'
    : `${workoutsThisWeek} treinos concluídos nesta semana`;

  const monthSummaryEl = document.getElementById('stMonthlySummary');
  const monthCalEl = document.getElementById('stMonthlyCalendar');
  if (monthSummaryEl && monthCalEl) {
    const mVisits = Array.isArray(fitness.monthVisits) ? fitness.monthVisits : [];
    const streak = Number(fitness.currentStreak || 0);
    const total = Number(fitness.totalVisits || 0);
    monthSummaryEl.textContent = `${mVisits.length} visita(s) no mês · ${streak} dia(s) seguidos · ${total} no total`;
    const refDate = String(fitness.date || new Date().toISOString().slice(0, 10));
    const [yr, mo] = refDate.split('-').map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const firstWeekday = new Date(yr, mo - 1, 1).getDay();
    const visitSet = new Set(mVisits);
    const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    let cells = weekdays.map((w) => `<div class="calendar-weekday" aria-hidden="true">${w}</div>`).join('');
    for (let i = 0; i < firstWeekday; i += 1) {
      cells += '<div class="calendar-day is-empty" aria-hidden="true"></div>';
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const hit = visitSet.has(iso);
      const isToday = iso === refDate;
      const cls = ['calendar-day', hit ? 'is-hit' : '', isToday ? 'is-today' : ''].filter(Boolean).join(' ');
      cells += `<div class="${cls}">${d}</div>`;
    }
    monthCalEl.innerHTML = cells;
  }

  document.getElementById('stFitnessAchievements').innerHTML = achievements.map(({ name, description, earned }) =>
    `<li><strong>${esc(name)}</strong> <span class="badge ${earned ? 'badge-active' : 'badge-neutral'}">${earned ? 'Conquistada' : 'Em andamento'}</span><div class="muted">${esc(description)}</div></li>`
  ).join('');
  document.getElementById('stFitnessRanking').innerHTML = ranking.map(({ alias: name, visits: count }) =>
    `<li><strong>${esc(name)}</strong> · ${count} ${count === 1 ? 'visita' : 'visitas'}</li>`
  ).join('');
  document.getElementById('stFitnessRankingEmpty').classList.toggle('hidden', ranking.length > 0);
  document.getElementById('stFitnessAlias').value = alias;
  document.getElementById('stFitnessChallengeLabel').textContent = `${challenge.completed} de ${challenge.target} treinos concluídos`;
  const challengeBar = document.getElementById('stFitnessChallenge');
  challengeBar.max = challenge.target;
  challengeBar.value = challenge.completed;
}

function renderWorkouts() {
  const workouts = studentState.data?.workouts || [];
  const pillsEl = document.getElementById('stWorkoutPills');
  const gridEl = document.getElementById('stExercisesGrid');
  const metaEl = document.getElementById('stWorkoutMeta');
  const notesEl = document.getElementById('stWorkoutNotes');
  const checklist = document.getElementById('stWorkoutChecklist');
  checklist.textContent = '';
  const completeButton = document.getElementById('stCompleteWorkout');
  completeButton.classList.add('hidden');

  if (!workouts.length) {
    pillsEl.innerHTML = '';
    metaEl.textContent = '';
    notesEl.textContent = '';
    updateWorkoutChecklistUi([]);
    gridEl.innerHTML = '<p class="muted">Nenhum treino cadastrado para você ainda. Peça ao seu professor na academia para montar sua ficha!</p>';
    return;
  }

  if (!workouts.some((w) => Number(w.id) === Number(studentState.selectedWorkoutId))) {
    studentState.selectedWorkoutId = workouts[0].id;
  }

  pillsEl.innerHTML = workouts.map((w) =>
    `<button type="button" class="workout-pill ${Number(w.id) === Number(studentState.selectedWorkoutId) ? 'active' : ''}" aria-pressed="${Number(w.id) === Number(studentState.selectedWorkoutId)}" data-workout-id="${w.id}">${esc(w.title)}</button>`
  ).join('');

  const current = workouts.find((w) => Number(w.id) === Number(studentState.selectedWorkoutId)) || workouts[0];
  metaEl.textContent = [current.goal ? `Objetivo: ${current.goal}` : '', current.instructor_name ? `Prof.: ${current.instructor_name}` : ''].filter(Boolean).join(' · ');
  notesEl.textContent = current.notes ? `Observações do treino: ${current.notes}` : '';

  const exercises = current.exercises || [];
  if (!exercises.length) {
    updateWorkoutChecklistUi([]);
    gridEl.innerHTML = '<p class="muted">Este treino ainda não possui exercícios.</p>';
    return;
  }
  const { fitness } = studentState.data;
  if (fitness) {
    const completed = fitness.completedToday.includes(Number(current.id));
    completeButton.classList.remove('hidden');
    completeButton.disabled = completed || studentState.completingWorkout;
    completeButton.textContent = completed ? 'Treino concluído hoje' : 'Concluir treino de hoje';
  }

  const doneMap = getTodayDoneMap();
  updateWorkoutChecklistUi(exercises, doneMap);
  gridEl.innerHTML = exercises.map((ex) => {
    const isDone = Boolean(doneMap[ex.id]);
    const restSec = Number(ex.rest_seconds || 60);
    const activeTimer = studentState.restTimers[ex.id];
    const restLabel = activeTimer ? `Descanso: ${remainingRestSeconds(activeTimer)}s` : `Descansar ${restSec}s`;
    const catalogEx = window.EXERCISE_LIBRARY?.findExercise(ex.exercise_key);
    const animHtml = ex.has_video ? '' : window.EXERCISE_LIBRARY?.renderExerciseAnimation(ex.exercise_key, { size: 'md' }) || '';
    const detailsLabel = ex.has_video ? 'Ver execução' : 'Detalhes';

    return `<article class="exercise-card ${isDone ? 'is-done' : ''}" data-card-ex="${ex.id}">
      <div class="exercise-heading">
        <div>
          <h3 style="margin:0 0 4px;">${esc(ex.exercise_name)}</h3>
          <span class="exercise-chip">${esc(ex.muscle_group || catalogEx?.muscle_group || 'Geral')}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-open-ex="${ex.id}" aria-label="${detailsLabel} de ${esc(ex.exercise_name)}">${detailsLabel}</button>
      </div>
      ${animHtml ? `<div class="exercise-animation">${animHtml}</div>` : ''}
      <dl class="exercise-meta">
        <div><dt>Séries</dt><dd>${ex.sets}</dd></div>
        <div><dt>Repetições</dt><dd>${esc(ex.reps)}</dd></div>
        <div><dt>Carga</dt><dd><button type="button" class="exercise-load-btn" data-edit-load-ex="${ex.id}" title="Toque para anotar ou atualizar sua carga">${esc(ex.load_kg || '+ Anotar')} ✎</button></dd></div>
      </dl>
      <div class="exercise-load-editor hidden" data-load-editor-ex="${ex.id}"></div>
      ${ex.notes ? `<p class="muted" style="margin:0;font-size:13px;">${esc(ex.notes)}</p>` : ''}
      <div class="student-action-grid">
        <button type="button" class="btn btn-secondary btn-sm" data-rest-ex="${ex.id}" data-rest-sec="${restSec}" aria-pressed="${Boolean(activeTimer)}">${restLabel}</button>
        <button type="button" class="btn ${isDone ? 'btn-success' : 'btn-primary'} btn-sm" data-done-ex="${ex.id}" aria-pressed="${isDone}">${isDone ? 'Feito ✓' : 'Marcar feito'}</button>
      </div>
    </article>`;
  }).join('');
}

function remainingRestSeconds(timer) {
  return Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
}

function playRestChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {}
}

function startRestTimer(exId, seconds) {
  const updateButton = (remaining = null) => {
    const button = document.querySelector(`[data-rest-ex="${exId}"]`);
    if (button) {
      button.textContent = remaining === null ? `Descansar ${seconds}s` : `Descanso: ${remaining}s`;
      button.setAttribute('aria-pressed', String(remaining !== null));
    }
    syncFloatingRestBar();
  };
  const stop = () => {
    clearInterval(studentState.restTimers[exId]?.interval);
    delete studentState.restTimers[exId];
    updateButton();
  };
  if (studentState.restTimers[exId]) {
    stop();
    return;
  }
  let exerciseName = '';
  for (const w of studentState.data?.workouts || []) {
    const match = (w.exercises || []).find((item) => Number(item.id) === Number(exId));
    if (match) {
      exerciseName = match.exercise_name || '';
      break;
    }
  }
  const timerState = { endsAt: Date.now() + seconds * 1000, interval: null, defaultSec: seconds, exerciseName };
  timerState.interval = setInterval(() => {
    const remaining = remainingRestSeconds(timerState);
    if (!remaining) {
      stop();
      navigator.vibrate?.([200, 100, 200]);
      playRestChime();
      showToast('Descanso finalizado! Próxima série!');
      return;
    }
    updateButton(remaining);
  }, 1000);
  studentState.restTimers[exId] = timerState;
  updateButton(seconds);
}

function adjustActiveRestTimer(deltaSeconds) {
  const exId = studentState.activeRestExerciseId;
  if (!exId || !studentState.restTimers[exId]) return;
  const timer = studentState.restTimers[exId];
  timer.endsAt = Math.max(Date.now() + 1000, timer.endsAt + deltaSeconds * 1000);
  const rem = remainingRestSeconds(timer);
  const button = document.querySelector(`[data-rest-ex="${exId}"]`);
  if (button) button.textContent = `Descanso: ${rem}s`;
  syncFloatingRestBar();
}

function openExerciseModal(exId) {
  const workouts = studentState.data?.workouts || [];
  let found = null;
  for (const w of workouts) {
    found = (w.exercises || []).find((e) => Number(e.id) === Number(exId));
    if (found) break;
  }
  if (!found) return;
  const cat = window.EXERCISE_LIBRARY?.findExercise(found.exercise_key);
  studentState.modalExerciseKey = found.exercise_key;
  studentState.modalSpeed = 1;
  studentState.modalPaused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('stExModalTitle').textContent = found.exercise_name;
  document.getElementById('stExModalSub').textContent = `${found.muscle_group || cat?.muscle_group || ''} · ${found.sets} séries × ${found.reps} · Descanso ${found.rest_seconds}s`;
  document.getElementById('stExModalTips').textContent = found.notes || found.catalog_tips || cat?.tips || '';
  const controls = document.getElementById('stExAnimationControls');
  controls.classList.toggle('hidden', Boolean(found.has_video));
  if (found.has_video) {
    const container = document.getElementById('stExModalAnim');
    const video = document.createElement('video');
    video.className = 'exercise-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', `Execução de ${found.exercise_name}`);
    video.addEventListener('error', () => {
      if (!video.isConnected) return;
      const message = document.createElement('p');
      message.textContent = 'O vídeo não pôde ser reproduzido neste aparelho.';
      renderModalAnimation();
      container.prepend(message);
      controls.classList.remove('hidden');
    });
    container.replaceChildren(video);
    video.src = `/api/student/me/exercises/${Number(exId)}/video`;
  } else {
    renderModalAnimation();
  }
  document.getElementById('stExerciseModal').showModal();
}

function renderModalAnimation() {
  if (!studentState.modalExerciseKey) return;
  document.getElementById('stExModalAnim').innerHTML = window.EXERCISE_LIBRARY.renderExerciseAnimation(
    studentState.modalExerciseKey,
    { size: 'lg', speed: studentState.modalSpeed, paused: studentState.modalPaused, allowMotion: true },
  );
  document.getElementById('btnExTogglePause').textContent = studentState.modalPaused ? 'Continuar' : 'Pausar';
  const hasAnimation = window.EXERCISE_LIBRARY.findExercise(studentState.modalExerciseKey).key !== 'custom';
  document.getElementById('btnExTogglePause').disabled = !hasAnimation;
  document.querySelectorAll('#stExerciseModal [data-ex-speed]').forEach((button) => { button.disabled = !hasAnimation; });
}

async function resizeImageToDataUrl(file, maxSize = 480) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Falha ao ler a imagem.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.84));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function loadStudentPortal() {
  const bootLoader = document.getElementById('stBootLoader');
  try {
    const status = await api('/api/student/auth/status');
    document.getElementById('stLoginGymName').textContent = status.gymName || 'Academia Oxigênio';
    if (!status.authenticated) {
      document.getElementById('studentLoginView').classList.remove('hidden');
      document.getElementById('studentPortalView').classList.add('hidden');
      return;
    }
    studentState.data = status;
    document.getElementById('studentLoginView').classList.add('hidden');
    document.getElementById('studentPortalView').classList.remove('hidden');
    renderPortal();
    await loadStudentExtras();
  } catch (err) {
    if (err.isNetworkError || err.status === 503 || !navigator.onLine) {
      document.getElementById('stOfflineBanner')?.classList.remove('hidden');
      if (!studentState.data?.member) {
        document.getElementById('studentLoginView')?.classList.remove('hidden');
        document.getElementById('studentPortalView')?.classList.add('hidden');
      }
    } else if (!studentState.data?.member) {
      document.getElementById('studentLoginView')?.classList.remove('hidden');
      document.getElementById('studentPortalView')?.classList.add('hidden');
    }
    throw err;
  } finally {
    bootLoader?.classList.add('hidden');
  }
}

function renderGamification(data) {
  const statsEl = document.getElementById('stGamificationStats');
  const listEl = document.getElementById('stGamificationBadges');
  if (!data) {
    statsEl.textContent = 'Sem dados de gamificação.';
    listEl.innerHTML = '';
    return;
  }
  const streak = Number(data.weeklyStreak || 0);
  statsEl.textContent = `${Number(data.monthVisits || 0)} visitas no mês · ${Number(data.totalVisits || 0)} no total · Sequência: ${streak} ${streak === 1 ? 'semana' : 'semanas'}`;
  const badges = Array.isArray(data.badges) ? data.badges : [];
  listEl.innerHTML = badges.length
    ? badges.map((b) => `<li><strong>🏅 ${esc(b.label || b.key)}</strong><div class="muted">${esc(b.description || '')}</div></li>`).join('')
    : '<li class="muted">Nenhuma medalha desbloqueada ainda.</li>';
}

function renderAssessments(data) {
  const listEl = document.getElementById('stAssessmentsList');
  const compEl = document.getElementById('stAssessmentComparison');
  const items = Array.isArray(data) ? data : (data?.assessments || []);
  if (!items.length) {
    if (compEl) compEl.classList.add('hidden');
    listEl.innerHTML = '<li class="muted">Nenhuma avaliação física registrada ainda.</li>';
    return;
  }

  if (compEl) {
    const latest = items[0];
    const prev = items[1] || null;
    const fmtDelta = (currVal, prevVal, unit = '', invertColor = false) => {
      if (currVal == null || prevVal == null) return '<small class="muted">1ª medição</small>';
      const diff = Number((Number(currVal) - Number(prevVal)).toFixed(1));
      if (diff === 0) return '<small class="muted">Sem alteração</small>';
      const sign = diff > 0 ? '+' : '';
      const isGood = invertColor ? diff < 0 : diff > 0;
      return `<small class="${isGood ? 'delta-positive' : 'delta-negative'}">${sign}${diff}${unit} vs anterior</small>`;
    };
    const bmi = latest.weight_kg && latest.height_cm
      ? Number((Number(latest.weight_kg) / ((Number(latest.height_cm) / 100) ** 2)).toFixed(1))
      : null;
    const prevBmi = prev?.weight_kg && prev?.height_cm
      ? Number((Number(prev.weight_kg) / ((Number(prev.height_cm) / 100) ** 2)).toFixed(1))
      : null;

    const cards = [
      latest.weight_kg != null
        ? `<div class="student-stat-card"><span class="student-stat-label">Peso Atual</span><strong>${latest.weight_kg} kg</strong>${fmtDelta(latest.weight_kg, prev?.weight_kg, ' kg', true)}</div>`
        : '',
      latest.body_fat_pct != null
        ? `<div class="student-stat-card"><span class="student-stat-label">% Gordura</span><strong>${latest.body_fat_pct}%</strong>${fmtDelta(latest.body_fat_pct, prev?.body_fat_pct, '%', true)}</div>`
        : '',
      latest.muscle_mass_kg != null
        ? `<div class="student-stat-card"><span class="student-stat-label">Massa Magra</span><strong>${latest.muscle_mass_kg} kg</strong>${fmtDelta(latest.muscle_mass_kg, prev?.muscle_mass_kg, ' kg', false)}</div>`
        : '',
      bmi != null
        ? `<div class="student-stat-card"><span class="student-stat-label">IMC</span><strong>${bmi}</strong>${fmtDelta(bmi, prevBmi, '', true)}</div>`
        : '',
    ].filter(Boolean);

    if (cards.length) {
      compEl.innerHTML = cards.join('');
      compEl.classList.remove('hidden');
    } else {
      compEl.classList.add('hidden');
    }
  }

  listEl.innerHTML = items.map((a) => {
    const metrics = [
      a.weight_kg != null ? `Peso: ${a.weight_kg} kg` : null,
      a.body_fat_pct != null ? `Gordura: ${a.body_fat_pct}%` : null,
      a.muscle_mass_kg != null ? `Massa magra: ${a.muscle_mass_kg} kg` : null,
      a.waist_cm != null ? `Cintura: ${a.waist_cm} cm` : null,
      a.chest_cm != null ? `Tórax: ${a.chest_cm} cm` : null,
      a.arm_cm != null ? `Braço: ${a.arm_cm} cm` : null,
      a.thigh_cm != null ? `Coxa: ${a.thigh_cm} cm` : null,
    ].filter(Boolean).join(' · ');
    return `<li><strong>${fmtDateBr(a.assessed_at)}</strong>${a.assessed_by ? ` · ${esc(a.assessed_by)}` : ''}<div class="muted">${esc(metrics || 'Medidas não informadas')}${a.notes ? ` — ${esc(a.notes)}` : ''}</div></li>`;
  }).join('');
}

function renderBookings(bookingsData, classesData) {
  const classSel = document.getElementById('stBookingClass');
  const dateInput = document.getElementById('stBookingDate');
  const listEl = document.getElementById('stBookingsList');

  if (dateInput) {
    dateInput.min = localIsoDate();
    if (!dateInput.value) dateInput.value = localIsoDate();
  }

  const classes = Array.isArray(classesData)
    ? classesData
    : (classesData?.classes || studentState.data?.classes || studentState.data?.enrollments || []);
  if (classSel) {
    classSel.innerHTML = classes.length
      ? classes.map((c) => {
          const cid = c.class_id || c.id;
          const cname = c.class_name || c.name;
          const capInfo = c.capacity ? ` · ${Number(c.enrolled_count || 0)}/${c.capacity} vagas` : '';
          return `<option value="${cid}">${esc(cname)}${c.schedule ? ` (${esc(c.schedule)})` : ''}${esc(capInfo)}</option>`;
        }).join('')
      : '<option value="">Nenhuma turma disponível</option>';
  }

  const bookings = Array.isArray(bookingsData) ? bookingsData : (bookingsData?.bookings || []);
  if (!listEl) return;
  listEl.innerHTML = bookings.length
    ? bookings.map((b) => {
        const badgeCls = b.status === 'confirmed' ? 'badge-active' : 'badge-pending';
        const statusTxt = b.status === 'confirmed' ? 'Confirmada' : 'Lista de espera';
        return `<li style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div>
            <strong>${esc(b.class_name || `Turma #${b.class_id}`)}</strong> · ${fmtDateBr(b.booking_date)}
            <span class="badge ${badgeCls}">${statusTxt}</span>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" data-cancel-booking="${b.id}">Cancelar</button>
        </li>`;
      }).join('')
    : '<li class="muted">Nenhuma reserva registrada.</li>';
}

async function loadStudentExtras() {
  const results = await Promise.allSettled([
    api('/api/student/gamification'),
    api('/api/student/assessments'),
    api('/api/student/bookings'),
    api('/api/student/classes'),
  ]);
  const [gamRes, assessRes, bookRes, classesRes] = results;
  renderGamification(gamRes.status === 'fulfilled' ? gamRes.value : null);
  renderAssessments(assessRes.status === 'fulfilled' ? assessRes.value : []);
  renderBookings(
    bookRes.status === 'fulfilled' ? bookRes.value : [],
    classesRes.status === 'fulfilled' ? classesRes.value : null,
  );
  if (results.every((r) => r.status === 'rejected')) {
    showToast('Não foi possível carregar alguns dados extras no momento.');
  }
}

document.getElementById('studentLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      await api('/api/student/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: document.getElementById('stLoginIdentifier').value,
          secret: document.getElementById('stLoginSecret').value,
        }),
      });
      e.target.reset();
      await loadStudentPortal();
    } catch (err) {
      showToast(err.message, true);
    }
  }, 'Entrando...');
});

async function clearStudentOfflineCache() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('oxigenio-aluno-api-')).map((k) => caches.delete(k)));
    }
  } catch {}
  navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_STUDENT_CACHE' });
}

document.getElementById('btnStudentLogout').addEventListener('click', async (e) => {
  await withBusyButton(e.currentTarget, async () => {
    try {
      await api('/api/student/auth/logout', { method: 'POST' });
    } catch (err) {
      showToast(err.message, true);
    } finally {
      await clearStudentOfflineCache();
      resetStudentUi();
      await loadStudentPortal().catch((err) => showToast(err.message, true));
    }
  });
});

document.querySelector('.student-tabs').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-st-tab]');
  if (!btn) return;
  const tab = btn.dataset.stTab;
  switchStudentTab(tab);
  window.scrollTo(0, 0);
  const profile = studentState.data;
  if (tab !== 'progress' || !profile) return;
  const previous = profile.fitness;
  const input = document.getElementById('stFitnessAlias');
  try {
    const fitness = await api('/api/student/me/fitness');
    if (studentState.data !== profile || profile.fitness !== previous) return;
    const draft = input.value;
    profile.fitness = fitness;
    renderFitness();
    if (draft !== (previous?.alias ?? '')) input.value = draft;
    renderWorkouts();
  } catch (err) {
    if (btn.classList.contains('active')) showToast(err.message, true);
  }
});

document.querySelector('.student-tabs').addEventListener('keydown', (event) => {
  const tabs = [...event.currentTarget.querySelectorAll('.student-tab-btn')];
  const currentIndex = tabs.indexOf(event.target);
  if (currentIndex < 0) return;
  const steps = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
  let nextIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else if (event.key in steps) nextIndex = (currentIndex + steps[event.key] + tabs.length) % tabs.length;
  else return;
  event.preventDefault();
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
});

document.querySelector('.progress-subtabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-progress-subtab]');
  if (!btn) return;
  switchProgressSubtab(btn.dataset.progressSubtab);
});

document.getElementById('stCompleteWorkout').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const workoutId = Number(studentState.selectedWorkoutId);
  const memberId = studentState.data?.member?.id;
  if (!memberId || !workoutId || studentState.completingWorkout) return;
  const current = (studentState.data?.workouts || []).find((w) => Number(w.id) === workoutId);
  const exercises = current?.exercises || [];
  const doneMap = getTodayDoneMap();
  const checked = exercises.filter((ex) => doneMap[ex.id]).length;
  if (exercises.length > 0 && checked === 0 && button.dataset.confirmEmpty !== '1') {
    button.dataset.confirmEmpty = '1';
    button.textContent = 'Nenhum marcado — tocar de novo para concluir';
    clearTimeout(button._confirmTimer);
    button._confirmTimer = setTimeout(() => {
      delete button.dataset.confirmEmpty;
      button.textContent = 'Concluir treino de hoje';
    }, 4000);
    return;
  }
  clearTimeout(button._confirmTimer);
  delete button.dataset.confirmEmpty;
  studentState.completingWorkout = true;
  button.disabled = true;
  try {
    const { created, fitness } = await api(`/api/student/me/workouts/${workoutId}/complete`, { method: 'POST' });
    if (studentState.data?.member?.id !== memberId) return;
    studentState.data.fitness = fitness;
    renderFitness();
    showToast(created ? 'Treino concluído!' : 'Treino já registrado hoje.');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    studentState.completingWorkout = false;
    renderWorkouts();
  }
});

document.getElementById('stFitnessAliasForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const memberId = studentState.data?.member?.id;
  if (!memberId || button.disabled) return;
  const alias = document.getElementById('stFitnessAlias').value.trim();
  button.disabled = true;
  try {
    const fitness = await api('/api/student/me/fitness/ranking', { method: 'PUT', body: JSON.stringify({ alias }) });
    if (studentState.data?.member?.id !== memberId) return;
    studentState.data.fitness = fitness;
    renderFitness();
    showToast(alias ? 'Participação no ranking salva.' : 'Participação no ranking removida.');
  } catch (err) {
    showToast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('stWorkoutPills').addEventListener('click', (e) => {
  const pill = e.target.closest('[data-workout-id]');
  if (!pill) return;
  const nextId = Number(pill.dataset.workoutId);
  if (nextId !== Number(studentState.selectedWorkoutId)) {
    clearAllRestTimers();
  }
  studentState.selectedWorkoutId = nextId;
  renderWorkouts();
  document.querySelector(`[data-workout-id="${studentState.selectedWorkoutId}"]`)?.focus({ preventScroll: true });
});

document.getElementById('stExercisesGrid').addEventListener('click', async (e) => {
  const cancelLoadBtn = e.target.closest('[data-cancel-load-ex]');
  if (cancelLoadBtn) {
    const exerciseId = Number(cancelLoadBtn.dataset.cancelLoadEx);
    const editor = document.querySelector(`[data-load-editor-ex="${exerciseId}"]`);
    if (editor) {
      editor.classList.add('hidden');
      editor.innerHTML = '';
    }
    return;
  }
  const loadBtn = e.target.closest('[data-edit-load-ex]');
  if (loadBtn) {
    const exerciseId = Number(loadBtn.dataset.editLoadEx);
    const current = (studentState.data?.workouts || []).find((w) => Number(w.id) === Number(studentState.selectedWorkoutId));
    const ex = (current?.exercises || []).find((item) => Number(item.id) === exerciseId);
    const editor = document.querySelector(`[data-load-editor-ex="${exerciseId}"]`);
    if (!ex || !editor) return;
    editor.innerHTML = `<form class="exercise-load-inline" data-save-load-ex="${exerciseId}">
      <input type="text" inputmode="decimal" maxlength="24" placeholder="Carga (ex: 20kg)" value="${esc(ex.load_kg || '')}" aria-label="Carga em ${esc(ex.exercise_name)}" />
      <button type="submit" class="btn btn-primary btn-sm" aria-label="Salvar carga">Salvar</button>
      <button type="button" class="btn btn-secondary btn-sm" data-cancel-load-ex="${exerciseId}" aria-label="Cancelar edição">Cancelar</button>
    </form>`;
    editor.classList.remove('hidden');
    const input = editor.querySelector('input');
    input?.focus();
    input?.select();
    return;
  }
  const restBtn = e.target.closest('[data-rest-ex]');
  if (restBtn) {
    startRestTimer(Number(restBtn.dataset.restEx), Number(restBtn.dataset.restSec));
    return;
  }
  const doneBtn = e.target.closest('[data-done-ex]');
  if (doneBtn) {
    const exerciseId = Number(doneBtn.dataset.doneEx);
    toggleExerciseDone(exerciseId);
    document.querySelector(`[data-done-ex="${exerciseId}"]`)?.focus({ preventScroll: true });
    return;
  }
  const openBtn = e.target.closest('[data-open-ex]');
  if (openBtn) {
    openExerciseModal(Number(openBtn.dataset.openEx));
  }
});

document.getElementById('stExercisesGrid').addEventListener('submit', async (e) => {
  const form = e.target.closest('.exercise-load-inline');
  if (!form) return;
  e.preventDefault();
  const exerciseId = Number(form.dataset.saveLoadEx);
  const input = form.querySelector('input');
  const saveBtn = form.querySelector('button[type="submit"]');
  const current = (studentState.data?.workouts || []).find((w) => Number(w.id) === Number(studentState.selectedWorkoutId));
  const ex = (current?.exercises || []).find((item) => Number(item.id) === exerciseId);
  const editor = form.closest('.exercise-load-editor');
  const loadBtn = document.querySelector(`[data-edit-load-ex="${exerciseId}"]`);
  if (!ex || !editor) return;
  const nextLoad = (input?.value || '').trim();
  await withBusyButton(saveBtn, async () => {
    try {
      const updated = await api(`/api/student/me/exercises/${exerciseId}/load`, {
        method: 'PUT',
        body: JSON.stringify({ load_kg: nextLoad }),
      });
      ex.load_kg = updated.load_kg;
      if (loadBtn) loadBtn.textContent = `${updated.load_kg || '+ Anotar'} ✎`;
      editor.classList.add('hidden');
      editor.innerHTML = '';
      showToast('Carga anotada no treino!');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnResetWorkoutCheck')?.addEventListener('click', (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Confirmar limpeza?';
    clearTimeout(btn._confirmTimer);
    btn._confirmTimer = setTimeout(() => {
      delete btn.dataset.confirm;
      btn.textContent = 'Limpar dia';
    }, 4000);
    return;
  }
  clearTimeout(btn._confirmTimer);
  delete btn.dataset.confirm;
  btn.textContent = 'Limpar dia';
  localStorage.removeItem(doneStorageKey());
  renderWorkouts();
  showToast('Marcações do dia reiniciadas.');
});

document.getElementById('btnNextPendingExercise')?.addEventListener('click', () => {
  const current = (studentState.data?.workouts || []).find((w) => Number(w.id) === Number(studentState.selectedWorkoutId));
  const exercises = current?.exercises || [];
  const doneMap = getTodayDoneMap();
  const nextEx = exercises.find((ex) => !doneMap[ex.id]);
  if (!nextEx) return;
  const card = document.querySelector(`[data-card-ex="${nextEx.id}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.querySelector(`[data-done-ex="${nextEx.id}"]`)?.focus({ preventScroll: true });
});

document.getElementById('btnRestMinus15')?.addEventListener('click', () => adjustActiveRestTimer(-15));
document.getElementById('btnRestPlus15')?.addEventListener('click', () => adjustActiveRestTimer(15));
document.getElementById('btnRestSkip')?.addEventListener('click', () => {
  const exId = studentState.activeRestExerciseId;
  if (exId && studentState.restTimers[exId]) {
    startRestTimer(exId, studentState.restTimers[exId].defaultSec || 60);
    showToast('Descanso pulado.');
  }
});

document.getElementById('stGoalSelect')?.addEventListener('change', async (e) => {
  const goal = Number(e.target.value);
  try {
    const fitness = await api('/api/student/me/fitness/goal', {
      method: 'PUT',
      body: JSON.stringify({ goal }),
    });
    if (studentState.data) {
      studentState.data.fitness = fitness;
      renderFitness();
    }
    showToast(`Meta semanal atualizada para ${goal}x por semana!`);
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('stContactForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  await withBusyButton(btn, async () => {
    try {
      const res = await api('/api/student/me/contact', {
        method: 'PUT',
        body: JSON.stringify({
          phone: document.getElementById('stContactPhone').value.trim(),
          email: document.getElementById('stContactEmail').value.trim(),
          emergency_contact: document.getElementById('stContactEmergency').value.trim(),
        }),
      });
      if (studentState.data?.member && res?.member) {
        Object.assign(studentState.data.member, res.member);
        renderPortal();
      }
      showToast('Dados de contato atualizados!');
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('btnStCopyStaticPix')?.addEventListener('click', async () => {
  const key = studentState.data?.pixRecipientKey;
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    showToast('Chave Pix copiada!');
  } catch {
    showToast(`Chave Pix: ${key}`);
  }
});

document.getElementById('btnCloseStExModal').addEventListener('click', () => {
  document.getElementById('stExerciseModal').close();
});

document.getElementById('stExerciseModal').addEventListener('close', () => {
  const preview = document.getElementById('stExModalAnim');
  const video = preview.querySelector('video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  preview.replaceChildren();
});

document.getElementById('btnExTogglePause').addEventListener('click', () => {
  studentState.modalPaused = !studentState.modalPaused;
  renderModalAnimation();
});

document.getElementById('stExerciseModal').addEventListener('click', (e) => {
  const sp = e.target.closest('[data-ex-speed]');
  if (!sp) return;
  studentState.modalSpeed = Number(sp.dataset.exSpeed || 1);
  renderModalAnimation();
});

document.getElementById('btnStChoosePhoto').addEventListener('click', () => {
  document.getElementById('stPhotoInput').click();
});

document.getElementById('stPhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 480);
    await api('/api/student/me/photo', {
      method: 'PUT',
      body: JSON.stringify({ profile_photo: dataUrl }),
    });
    showToast('Foto de perfil atualizada!');
    await loadStudentPortal();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    e.target.value = '';
  }
});

document.getElementById('btnStRemovePhoto').addEventListener('click', async (e) => {
  await withBusyButton(e.currentTarget, async () => {
    try {
      await api('/api/student/me/photo', {
        method: 'PUT',
        body: JSON.stringify({ profile_photo: null }),
      });
      showToast('Foto de perfil removida.');
      await loadStudentPortal();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('stPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
  await withBusyButton(submitBtn, async () => {
    try {
      await api('/api/student/me/password', {
        method: 'PUT',
        body: JSON.stringify({
          current_password: document.getElementById('stCurrentPassword').value,
          new_password: document.getElementById('stNewPassword').value,
        }),
      });
      e.target.reset();
      showToast('Senha do portal salva!');
      await loadStudentPortal();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

function startPortalPixPolling(chargeId) {
  stopPortalPixPolling();
  let attempts = 0;
  studentState.pixPollTimer = setInterval(async () => {
    attempts += 1;
    if (attempts > 60 || Number(studentState.activePixChargeId) !== Number(chargeId)) {
      stopPortalPixPolling();
      return;
    }
    try {
      const res = await api(`/api/student/me/pix/${chargeId}/check`, { method: 'POST' });
      if (res.paid || res.status === 'paid') {
        stopPortalPixPolling();
        document.getElementById('stPixBox')?.classList.add('hidden');
        showToast('Pagamento confirmado! Matrícula renovada.');
        await loadStudentPortal();
      } else if (res.status === 'expired' || res.status === 'cancelled') {
        stopPortalPixPolling();
        document.getElementById('stPixInfo').textContent = 'Pix expirado ou cancelado. Gere um novo código para pagar.';
      }
    } catch {}
  }, 5000);
}

window.addEventListener('pagehide', stopPortalPixPolling);

document.getElementById('btnStCheckout').addEventListener('click', (event) => withBusyButton(event.currentTarget, async () => {
  if (!validateStudentPaymentSelection()) return;
  try {
    const memberId = studentState.data?.member?.id;
    const plan_id = Number(document.getElementById('stPayPlan').value) || null;
    const charge = await api('/api/student/me/checkout', { method: 'POST', body: JSON.stringify({ plan_id }) });
    if (!memberId || studentState.data?.member?.id !== memberId) return;
    const url = sanitizeHttpUrl(charge.payment_url);
    if (!url) throw new Error('Link de pagamento inválido.');
    const box = document.getElementById('stCheckoutBox');
    box.dataset.chargeId = charge.id;
    document.getElementById('stCheckoutAmount').textContent = `Valor a pagar ${fmtMoney(charge.amount_cents)}`;
    document.getElementById('stCheckoutLink').href = url;
    box.classList.remove('hidden');
  } catch (err) {
    showToast(err.message, true);
  }
}, 'Abrindo...'));

document.getElementById('btnStCheckCheckout').addEventListener('click', (event) => withBusyButton(event.currentTarget, async () => {
  const box = document.getElementById('stCheckoutBox');
  if (!box.dataset.chargeId) return;
  try {
    const result = await api(`/api/student/me/pix/${Number(box.dataset.chargeId)}/check`, { method: 'POST' });
    if (!result.paid) {
      showToast('O Mercado Pago ainda está aguardando a confirmação.');
      return;
    }
    box.classList.add('hidden');
    delete box.dataset.chargeId;
    await loadStudentPortal();
    showToast('Pagamento confirmado!');
  } catch (err) {
    showToast(err.message, true);
  }
}, 'Verificando...'));

document.getElementById('btnStGeneratePix').addEventListener('click', async (e) => {
  if (!validateStudentPaymentSelection()) return;
  await withBusyButton(e.currentTarget, async () => {
    try {
      const planId = Number(document.getElementById('stPayPlan').value) || null;
      const charge = await api('/api/student/me/pix', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId }),
      });
      studentState.activePixChargeId = charge.id;
      document.getElementById('stPixBox').classList.remove('hidden');
      document.getElementById('stPixInfo').textContent = `Valor: ${fmtMoney(charge.amount_cents)} · Aguardando pagamento (verificação automática ativa)`;
      document.getElementById('stPixCode').value = charge.qr_code || charge.qr_code_text || '';
      const qrImg = document.getElementById('stPixQr');
      const qrSrc = sanitizeQrImageSrc(charge.qr_base64 || charge.qr_code_base64);
      if (qrSrc) {
        qrImg.src = qrSrc;
        qrImg.classList.remove('hidden');
      } else {
        qrImg.src = '';
        qrImg.classList.add('hidden');
      }
      if (charge.id) startPortalPixPolling(charge.id);
      document.getElementById('stPixBox')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast('Pix gerado! Assim que você pagar, confirmaremos automaticamente.');
    } catch (err) {
      showToast(err.message, true);
    }
  }, 'Gerando Pix...');
});

document.getElementById('btnStCopyPix').addEventListener('click', async () => {
  const input = document.getElementById('stPixCode');
  if (!input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    showToast('Código Pix copiado!');
  } catch {
    input.focus();
    input.select();
    showToast('Código Pix selecionado. Toque em Copiar.');
  }
});

document.getElementById('btnStCheckPix').addEventListener('click', async (e) => {
  if (!studentState.activePixChargeId) return;
  await withBusyButton(e.currentTarget, async () => {
    try {
      const res = await api(`/api/student/me/pix/${studentState.activePixChargeId}/check`, { method: 'POST' });
      if (res.paid || res.status === 'paid') {
        stopPortalPixPolling();
        showToast('Pagamento confirmado! Matrícula renovada.');
        document.getElementById('stPixBox').classList.add('hidden');
        await loadStudentPortal();
      } else {
        showToast(`Status atual do Pix: ${res.status || 'pendente'}`);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }, 'Verificando...');
});

document.getElementById('btnStSubscribeCard').addEventListener('click', async (e) => {
  if (!validateStudentPaymentSelection()) return;
  await withBusyButton(e.currentTarget, async () => {
    try {
      const planId = Number(document.getElementById('stPayPlan').value) || null;
      const payerEmail = document.getElementById('stPayEmail').value.trim() || null;
      const sub = await api('/api/student/me/subscription', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId, payer_email: payerEmail }),
      });
      const safeHref = sanitizeHttpUrl(sub.init_point);
      if (!safeHref) throw new Error('Link de checkout inválido.');
      document.getElementById('stSubBox').classList.remove('hidden');
      document.getElementById('stSubInfo').textContent = `Plano: ${sub.reason || 'Assinatura'} · Valor: ${fmtMoney(sub.amount_cents)}`;
      document.getElementById('stSubLink').href = safeHref;
      showToast('Link de assinatura criado!');
    } catch (err) {
      showToast(err.message, true);
    }
  }, 'Gerando link...');
});

loadStudentPortal().catch((err) => showToast(err.message, true));

document.getElementById('stBookingForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  await withBusyButton(btn, async () => {
    try {
      const classId = Number(document.getElementById('stBookingClass').value);
      const bookingDate = document.getElementById('stBookingDate').value;
      const weeks = Number(document.getElementById('stBookingWeeks')?.value || 1);
      if (!classId) throw new Error('Selecione uma turma.');
      if (weeks > 1) {
        const res = await api('/api/student/bookings/recurring', {
          method: 'POST',
          body: JSON.stringify({ class_id: classId, start_date: bookingDate, weeks }),
        });
        const count = res.created?.length || 0;
        showToast(`${count} ${count === 1 ? 'aula reservada' : 'aulas reservadas'} para as próximas semanas!`);
      } else {
        const res = await api('/api/student/bookings', {
          method: 'POST',
          body: JSON.stringify({ class_id: classId, booking_date: bookingDate }),
        });
        showToast(res.status === 'waitlist' ? 'Turma lotada: você entrou na lista de espera.' : 'Vaga reservada com sucesso!');
      }
      await loadStudentExtras();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

// Alternância de tema Claro/Escuro no Portal do Aluno
(() => {
  const root = document.documentElement;
  const toggleBtn = document.getElementById('btnStThemeToggle');
  const applyTheme = (theme) => {
    const next = theme === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    const label = next === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro';
    toggleBtn?.setAttribute('aria-label', label);
    toggleBtn?.setAttribute('title', label);
    const themeColor = next === 'dark' ? '#07080b' : '#f5f5f7';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  };
  try {
    const saved = localStorage.getItem('oxigenio_student_theme');
    applyTheme(saved === 'dark' ? 'dark' : 'light');
  } catch {}
  toggleBtn?.addEventListener('click', () => {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('oxigenio_student_theme', next); } catch {}
  });
})();

document.getElementById('stBookingsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel-booking]');
  if (!btn) return;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Confirmar?';
    clearTimeout(btn._confirmTimer);
    btn._confirmTimer = setTimeout(() => {
      delete btn.dataset.confirm;
      btn.textContent = 'Cancelar';
    }, 4000);
    return;
  }
  clearTimeout(btn._confirmTimer);
  delete btn.dataset.confirm;
  btn.textContent = 'Cancelar';
  const id = Number(btn.dataset.cancelBooking);
  await withBusyButton(btn, async () => {
    try {
      await api(`/api/student/bookings/${id}`, { method: 'DELETE' });
      showToast('Reserva cancelada.');
      await loadStudentExtras();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

document.getElementById('stContractForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  await withBusyButton(btn, async () => {
    try {
      const signature = document.getElementById('stContractSignature').value.trim();
      await api('/api/student/contract', {
        method: 'POST',
        body: JSON.stringify({ signature }),
      });
      showToast('PAR-Q e contrato assinados com sucesso!');
      await loadStudentPortal();
    } catch (err) {
      showToast(err.message, true);
    }
  });
});

if ('serviceWorker' in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  const showUpdateBanner = () => {
    document.getElementById('stSwUpdateBanner')?.classList.remove('hidden');
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showUpdateBanner();
    hadController = true;
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      });
    });
  }).catch(() => {});
  document.getElementById('btnReloadSwUpdate')?.addEventListener('click', () => {
    window.location.reload();
  });
}

// Estado offline/online reativo
(() => {
  const banner = document.getElementById('stOfflineBanner');
  const syncNetwork = () => {
    if (!banner) return;
    banner.classList.toggle('hidden', navigator.onLine);
  };
  window.addEventListener('online', () => {
    syncNetwork();
    loadStudentPortal().catch(() => {});
  });
  window.addEventListener('offline', syncNetwork);
  document.getElementById('btnRetryOffline')?.addEventListener('click', () => {
    loadStudentPortal().catch((err) => showToast(err.message, true));
  });
  syncNetwork();
})();

// Tutorial de primeiro acesso (recolhido por padrão para compactar o login mobile)
(() => {
  const guide = document.getElementById('stFirstAccessGuide');
  if (guide) {
    guide.open = false;
  }

  document.getElementById('btnGoToPassword')?.addEventListener('click', () => {
    switchStudentTab('profile');
    document.getElementById('stNewPassword')?.focus();
  });

  document.getElementById('btnDismissFirstAccess')?.addEventListener('click', () => {
    document.getElementById('stFirstAccessBanner')?.classList.add('hidden');
    try { sessionStorage.setItem('oxigenio_dismiss_first_access', '1'); } catch {}
  });
})();

// Botão "Transformar em app" (PWA)
(() => {
  let deferredInstallPrompt = null;
  const loginInstallWrap = document.getElementById('stLoginInstallWrap');
  const btnLoginInstall = document.getElementById('btnLoginInstallApp');
  const btnHeaderInstall = document.getElementById('btnInstallApp');
  const installModal = document.getElementById('stInstallModal');
  const btnCloseModal = document.getElementById('btnCloseStInstallModal');
  const iosSteps = document.getElementById('stInstallStepsIos');
  const androidSteps = document.getElementById('stInstallStepsAndroid');

  function isRunningAsApp() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
  }

  function isIosDevice() {
    const ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function syncInstallButtons() {
    const installed = isRunningAsApp();
    loginInstallWrap?.classList.toggle('hidden', installed);
    btnHeaderInstall?.classList.toggle('hidden', installed);
  }

  function openManualInstallModal() {
    if (!installModal) return;
    const ios = isIosDevice();
    iosSteps?.classList.toggle('hidden', !ios);
    androidSteps?.classList.toggle('hidden', ios);
    if (typeof installModal.showModal === 'function') {
      installModal.showModal();
    } else {
      installModal.setAttribute('open', '');
    }
  }

  function closeManualInstallModal() {
    if (!installModal) return;
    if (typeof installModal.close === 'function') {
      installModal.close();
    } else {
      installModal.removeAttribute('open');
    }
  }

  async function handleInstallClick() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
          showToast('Portal adicionado à tela inicial!');
          deferredInstallPrompt = null;
          loginInstallWrap?.classList.add('hidden');
          btnHeaderInstall?.classList.add('hidden');
          return;
        }
      } catch {}
      deferredInstallPrompt = null;
    }
    openManualInstallModal();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    syncInstallButtons();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    loginInstallWrap?.classList.add('hidden');
    btnHeaderInstall?.classList.add('hidden');
    closeManualInstallModal();
    showToast('App instalado com sucesso!');
  });

  btnLoginInstall?.addEventListener('click', handleInstallClick);
  btnHeaderInstall?.addEventListener('click', handleInstallClick);
  btnCloseModal?.addEventListener('click', closeManualInstallModal);
  installModal?.addEventListener('click', (e) => {
    if (e.target === installModal) closeManualInstallModal();
  });

  syncInstallButtons();
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle-password]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.togglePassword);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Ocultar' : 'Mostrar';
});
