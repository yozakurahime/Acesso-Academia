const display = document.getElementById('display');
const mainCard = display?.querySelector('.turnstile-main-card');
const statusLabel = document.getElementById('displayStatus');
const title = document.getElementById('displayTitle');
const message = document.getElementById('displayMessage');
const icon = document.getElementById('displayIcon');
const heroWrap = document.getElementById('displayHeroWrap');
const avatarImg = document.getElementById('displayAvatar');
const preview = document.getElementById('displayPreview');
const fullscreen = document.getElementById('fullscreen');
const progressWrap = document.getElementById('displayProgressWrap');
const progress = document.getElementById('displayProgress');
const goalDots = document.getElementById('displayGoalDots');
const planAlert = document.getElementById('displayPlanAlert');
const displayBadges = document.getElementById('displayBadges');
const workoutCard = document.getElementById('displayWorkoutCard');
const workoutTitle = document.getElementById('displayWorkoutTitle');
const workoutMeta = document.getElementById('displayWorkoutMeta');
const idleWidgets = display?.querySelector('.turnstile-idle-widgets');
const ranking = document.getElementById('displayRanking');
const rankingTitle = document.getElementById('displayRankingTitle');
const rankingList = document.getElementById('displayRankingList');
const confettiLayer = document.getElementById('confettiLayer');
const noticeBox = document.getElementById('displayNotice');
const noticeTextEl = document.getElementById('displayNoticeText');
const noticeCounterEl = document.getElementById('displayNoticeCounter');
const occupancyBadge = document.getElementById('displayOccupancy');
const birthdayBanner = document.getElementById('displayBirthday');
const weatherBadge = document.getElementById('displayWeather');
const portalQrBox = document.getElementById('displayPortalQr');
const quoteBox = document.getElementById('displayQuote');
const quoteTextEl = document.getElementById('displayQuoteText');
const clockEl = document.getElementById('displayClock');
const dateEl = document.getElementById('displayDate');
const gymNameEl = document.getElementById('displayGymName');
const timerBar = document.getElementById('displayTimerBar');
const timerFill = document.getElementById('displayTimerFill');
const faceMirrorOverlay = document.getElementById('faceMirrorOverlay');
const faceMirrorTitle = document.getElementById('faceMirrorTitle');
const faceMirrorSubtitle = document.getElementById('faceMirrorSubtitle');
const faceMirrorImg = document.getElementById('faceMirrorImg');
let faceMirrorHideTimer = null;
let faceMirrorChannelActiveAt = 0;

function updateFaceMirror(mirror) {
  if (!faceMirrorOverlay || !faceMirrorImg) return;
  const validFrame = typeof mirror?.frame === 'string' && mirror.frame.startsWith('data:image/');
  if (!mirror || !mirror.active || !validFrame) {
    clearTimeout(faceMirrorHideTimer);
    faceMirrorOverlay.hidden = true;
    faceMirrorImg.removeAttribute('src');
    return;
  }
  const firstName = mirror.memberName ? String(mirror.memberName).trim().split(/\s+/)[0] : '';
  if (faceMirrorTitle) {
    faceMirrorTitle.textContent = mirror.captured
      ? (firstName ? `Foto capturada, ${firstName}!` : 'Foto capturada!')
      : (firstName ? `Olhe para a câmera, ${firstName}` : 'Olhe para a câmera');
  }
  if (faceMirrorSubtitle) {
    faceMirrorSubtitle.textContent = mirror.captured
      ? 'Aguarde a recepção confirmar o cadastro.'
      : 'Centralize seu rosto na moldura';
  }
  faceMirrorImg.src = mirror.frame;
  faceMirrorOverlay.hidden = false;
  clearTimeout(faceMirrorHideTimer);
  faceMirrorHideTimer = setTimeout(() => {
    faceMirrorOverlay.hidden = true;
    faceMirrorImg.removeAttribute('src');
  }, 15000);
}

if (typeof window.BroadcastChannel === 'function') {
  const mirrorCh = new BroadcastChannel('oxigenio_face_mirror');
  mirrorCh.addEventListener('message', (ev) => {
    faceMirrorChannelActiveAt = ev.data?.active ? Date.now() : 0;
    updateFaceMirror(ev.data);
  });
}

let lastView;
let resetTimer;
let pollDisplayTimer;
let pollRankingTimer;
let pollDisplayController = null;
let offlineFailures = 0;
let wakeLock = null;
let idleOccupancy = null;
let noticeList = [];
let noticeIndex = 0;
let noticeFadeTimer = null;
let deniedLockUntil = 0;
let audioCtx = null;
const MIN_DENIED_DISPLAY_MS = 4200;
const isSoundMuted = (() => {
  const param = new URLSearchParams(window.location.search).get('mute');
  return param === '1' || param === 'true';
})();

function getAudioContext() {
  if (isSoundMuted) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctx();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playToneSequence(notes) {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const baseTime = ctx.currentTime + 0.01;
    notes.forEach(({ freq, start, duration, type = 'sine', gain = 0.14 }) => {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, baseTime + start);
      amp.gain.setValueAtTime(0.0001, baseTime + start);
      amp.gain.exponentialRampToValueAtTime(gain, baseTime + start + 0.015);
      amp.gain.exponentialRampToValueAtTime(0.0001, baseTime + start + duration);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(baseTime + start);
      osc.stop(baseTime + start + duration + 0.02);
    });
  } catch {
    // Ignora falhas de autoplay sem bloquear a UI.
  }
}

function playFeedbackSound(state) {
  if (isSoundMuted) return;
  if (state === 'allowed') {
    playToneSequence([
      { freq: 523.25, start: 0, duration: 0.09, type: 'sine', gain: 0.14 },
      { freq: 659.25, start: 0.08, duration: 0.15, type: 'sine', gain: 0.16 },
    ]);
  } else if (state === 'denied' || state === 'error') {
    playToneSequence([
      { freq: 260, start: 0, duration: 0.14, type: 'triangle', gain: 0.18 },
      { freq: 185, start: 0.14, duration: 0.22, type: 'triangle', gain: 0.20 },
    ]);
  } else if (state === 'unrecognized') {
    playToneSequence([
      { freq: 440, start: 0, duration: 0.08, type: 'sine', gain: 0.12 },
      { freq: 392, start: 0.09, duration: 0.11, type: 'sine', gain: 0.12 },
    ]);
  }
}

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}

let confettiTimer = null;
const CONFETTI_COLORS = ['#ff6a00', '#ff9d42', '#34d399', '#38bdf8', '#fde68a', '#fb7185'];

function launchConfetti() {
  if (!confettiLayer) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  clearTimeout(confettiTimer);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 32; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'turnstile-confetti-piece';
    const sx = 12 + Math.random() * 76;
    const sy = 10 + Math.random() * 20;
    const tx = Math.round((Math.random() - 0.5) * 260);
    const ty = Math.round(220 + Math.random() * 320);
    const rot = Math.round((Math.random() - 0.5) * 720);
    const dur = Math.round(1100 + Math.random() * 600);
    const delay = Math.round(Math.random() * 180);
    piece.style.setProperty('--sx', `${sx}%`);
    piece.style.setProperty('--sy', `${sy}%`);
    piece.style.setProperty('--tx', `${tx}px`);
    piece.style.setProperty('--ty', `${ty}px`);
    piece.style.setProperty('--rot', `${rot}deg`);
    piece.style.setProperty('--dur', `${dur}ms`);
    piece.style.setProperty('--delay', `${delay}ms`);
    piece.style.setProperty('--color', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
    frag.appendChild(piece);
  }
  confettiLayer.replaceChildren(frag);
  confettiTimer = setTimeout(() => {
    confettiLayer.replaceChildren();
  }, 1950);
}

const screens = {
  idle: ['◎', 'Controle de acesso', 'Olhe para o leitor facial', 'Aguarde a confirmação para passar.'],
  allowed: ['✓', 'Acesso liberado', 'Pode passar', 'Bom treino!'],
  denied: ['×', 'Acesso negado', 'Procure a recepção', 'Nossa equipe pode ajudar.'],
  unrecognized: ['↻', 'Face não reconhecida', 'Tente novamente', 'Olhe de frente para o leitor.'],
  error: ['!', 'Falha na catraca', 'Procure a recepção', 'Nossa equipe pode ajudar.'],
  offline: ['!', 'Conexão indisponível', 'Aguarde um instante', 'Se precisar de ajuda, procure a recepção.'],
};

function renderOccupancyBadge(occObj) {
  if (!occupancyBadge) return;
  const source = occObj ?? idleOccupancy;
  if (source == null) {
    occupancyBadge.hidden = true;
    return;
  }
  const count = typeof source === 'object' ? source.count : source;
  const maxCap = typeof source === 'object' ? source.maxCapacity : null;
  if (count == null) {
    occupancyBadge.hidden = true;
    return;
  }
  occupancyBadge.hidden = false;
  occupancyBadge.textContent = maxCap ? `Na academia: ${count} / ${maxCap}` : `Na academia: ${count}`;
  occupancyBadge.className = 'turnstile-occ-badge';
  if (maxCap && count >= maxCap) occupancyBadge.classList.add('badge-blocked');
  else if (maxCap && count >= maxCap * 0.8) occupancyBadge.classList.add('badge-pending');
  else occupancyBadge.classList.add('badge-active');
}

function animateTimerBar(remainingMs, totalMs) {
  if (!timerBar || !timerFill) return;
  if (!remainingMs || remainingMs <= 0) {
    timerBar.hidden = true;
    return;
  }
  const maxMs = Math.max(remainingMs, Number(totalMs || remainingMs));
  const startRatio = Math.min(1, Math.max(0, remainingMs / maxMs));
  timerBar.hidden = false;
  timerFill.style.transition = 'none';
  timerFill.style.transform = `scaleX(${startRatio})`;
  void timerFill.offsetWidth;
  timerFill.style.transition = `transform ${remainingMs}ms linear`;
  timerFill.style.transform = 'scaleX(0)';
}

function formatTurnstileMessages(state, event, defaults) {
  const [defaultStatus, defaultTitle, defaultMsg] = defaults;
  if (state === 'idle') {
    return {
      status: `${getTimeGreeting()} · ${defaultStatus}`,
      title: defaultTitle,
      message: defaultMsg,
    };
  }
  if (state === 'denied') {
    if (/^Aguarde a liberação na recepção/i.test(event?.reason || '')) {
      return {
        status: 'Check-in diário',
        title: event?.firstName || 'Aguarde um instante',
        message: `${event.reason} · Faça o check-in diário e aguarde a confirmação da recepção.`,
      };
    }
    return {
      status: 'Acesso bloqueado',
      title: event?.firstName || defaultTitle,
      message: event?.reason ? `${event.reason} · Procure a recepção.` : defaultMsg,
    };
  }
  if (state !== 'allowed') {
    return { status: defaultStatus, title: defaultTitle, message: defaultMsg };
  }

  const greeting = getTimeGreeting();
  const role = event?.accessRole || 'student';
  const isExit = event?.direction === 'exit';

  if (!event?.firstName) {
    return {
      status: 'Liberação manual · Acesso liberado',
      title: 'Pode passar',
      message: `${greeting}! Catraca liberada pela recepção.`,
    };
  }
  if (role === 'instructor') {
    return {
      status: isExit ? 'Professor · Saída liberada' : 'Professor · Acesso liberado',
      title: `${greeting}, Prof. ${event.firstName}`,
      message: isExit ? 'Até logo, professor! Bom descanso.' : 'Bom trabalho e ótima aula hoje!',
    };
  }
  if (role === 'staff' || role === 'user') {
    return {
      status: isExit ? 'Equipe · Saída liberada' : 'Equipe · Acesso liberado',
      title: `${greeting}, ${event.firstName}`,
      message: isExit ? 'Até logo! Bom descanso.' : 'Bom trabalho hoje na academia!',
    };
  }
  if (event?.isVisitor) {
    return {
      status: isExit ? 'Visitante · Saída liberada' : 'Visitante · Acesso liberado',
      title: `Bem-vindo, ${event.firstName}`,
      message: isExit ? 'Obrigado pela visita! Volte sempre.' : 'Aproveite a Academia Oxigênio! Bom treino.',
    };
  }
  let studentMsg = `${greeting}! Pode passar, bom treino!`;
  if (event?.isBirthday) {
    studentMsg = 'Feliz aniversário! Hoje é seu dia especial. Bom treino!';
  } else if (isExit) {
    studentMsg = 'Treino concluído! Até a próxima!';
  } else if (event?.progress?.visits && event?.progress?.goal && event.progress.visits >= event.progress.goal) {
    studentMsg = 'Meta da semana batida! Bom treino!';
  } else if (event?.returning) {
    studentMsg = 'Que bom te ver de volta! Bom treino!';
  } else if (event?.progress?.visits === 1) {
    studentMsg = 'Primeiro treino da semana! Bora pra cima!';
  }
  return {
    status: isExit ? 'Aluno · Saída liberada' : 'Aluno · Acesso liberado',
    title: event.firstName,
    message: studentMsg,
  };
}

function resolveDisplayRole(state, event) {
  if (state !== 'allowed') return '';
  if (!event?.firstName) return 'manual';
  const role = event?.accessRole || 'student';
  if (role === 'instructor') return 'instructor';
  if (role === 'staff' || role === 'user') return 'staff';
  if (event?.isVisitor) return 'visitor';
  return 'student';
}

function triggerCardEnterAnimation() {
  if (!mainCard) return;
  mainCard.classList.remove('is-entering');
  void mainCard.offsetWidth;
  mainCard.classList.add('is-entering');
}

function formatValidUntilBr(validUntil) {
  const m = String(validUntil || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function renderTurnstileTitle(titleEl, titleText, state, event) {
  if (!titleEl) return;
  titleEl.textContent = titleText || '';
  const dueBr = state === 'allowed' ? formatValidUntilBr(event?.validUntil) : '';
  const role = event?.accessRole || 'student';
  const showDue = Boolean(dueBr) && (role === 'student' || Boolean(event?.isVisitor));
  if (!showDue) return;

  const badge = document.createElement('span');
  const days = typeof event?.daysRemaining === 'number' ? event.daysRemaining : null;
  const isWarning = Boolean(event?.inGrace) || (days !== null && days <= 5);
  badge.className = `turnstile-due-pill${isWarning ? ' is-warning' : ''}`;
  if (event?.inGrace || (days !== null && days < 0)) {
    badge.textContent = `Venceu em ${dueBr}`;
  } else if (days === 0) {
    badge.textContent = `Vence hoje · ${dueBr}`;
  } else {
    badge.textContent = `Vence em ${dueBr}`;
  }
  titleEl.appendChild(document.createTextNode(' '));
  titleEl.appendChild(badge);
}

function render(state, event) {
  const view = event ? `${state}:${event.id}` : state;
  if (lastView === view) return;
  const isNewEvent = Boolean(event && lastView !== view);
  lastView = view;
  clearTimeout(resetTimer);
  if (state !== 'denied') deniedLockUntil = 0;

  const [symbol, statusText, titleText, messageText] = screens[state];
  const copy = formatTurnstileMessages(state, event, [statusText, titleText, messageText]);
  display.dataset.state = state;
  document.body.dataset.state = state;
  const displayRole = resolveDisplayRole(state, event);
  if (displayRole) {
    display.dataset.role = displayRole;
    document.body.dataset.role = displayRole;
  } else {
    delete display.dataset.role;
    delete document.body.dataset.role;
  }
  icon.textContent = symbol;
  preview.hidden = !event?.preview;
  statusLabel.textContent = copy.status;
  renderTurnstileTitle(title, copy.title, state, event);
  message.textContent = copy.message;
  triggerCardEnterAnimation();
  if (isNewEvent) {
    playFeedbackSound(state);
  }

  // Foto do aluno (FaceID ou foto de perfil)
  if (avatarImg && heroWrap) {
    const showPhoto = (state === 'allowed' || state === 'denied') && typeof event?.photo === 'string' && event.photo.startsWith('data:image/');
    if (showPhoto) {
      avatarImg.src = event.photo;
      avatarImg.hidden = false;
      heroWrap.classList.add('has-avatar');
    } else {
      avatarImg.removeAttribute('src');
      avatarImg.hidden = true;
      heroWrap.classList.remove('has-avatar');
    }
  }

  // Alerta de carência / vencimento próximo no estado liberado
  if (planAlert) {
    if (state === 'allowed' && event?.inGrace) {
      planAlert.textContent = 'Sua matrícula está no prazo de tolerância. Renove na recepção.';
      planAlert.hidden = false;
    } else if (state === 'allowed' && typeof event?.daysRemaining === 'number' && event.daysRemaining === 0) {
      planAlert.textContent = 'Sua matrícula vence hoje. Renove no Portal do Aluno ou na recepção.';
      planAlert.hidden = false;
    } else if (state === 'allowed' && typeof event?.daysRemaining === 'number' && event.daysRemaining > 0 && event.daysRemaining <= 5) {
      planAlert.textContent = `Sua matrícula vence em ${event.daysRemaining} ${event.daysRemaining === 1 ? 'dia' : 'dias'}`;
      planAlert.hidden = false;
    } else {
      planAlert.textContent = '';
      planAlert.hidden = true;
    }
  }

  // Badges motivacionais (streak >= 2 e retorno após 14+ dias)
  if (displayBadges) {
    displayBadges.replaceChildren();
    if (state === 'allowed') {
      const streakVal = Number(event?.streak || 0);
      if (streakVal >= 2) {
        const streakPill = document.createElement('span');
        streakPill.className = 'turnstile-streak-pill';
        streakPill.textContent = `🔥 ${streakVal} dias seguidos`;
        displayBadges.appendChild(streakPill);
      }
      if (event?.returning) {
        const retPill = document.createElement('span');
        retPill.className = 'turnstile-returning-pill';
        retPill.textContent = '👋 Que bom te ver de volta!';
        displayBadges.appendChild(retPill);
      }
    }
    displayBadges.hidden = displayBadges.childElementCount === 0;
  }

  // Confetes leves somente em marcos reais
  if (isNewEvent && state === 'allowed') {
    const streakVal = Number(event?.streak || 0);
    const goalMet = Boolean(event?.progress?.visits && event?.progress?.goal && event.progress.visits >= event.progress.goal);
    const streakMilestone = streakVal > 0 && (streakVal % 7 === 0 || streakVal % 15 === 0 || streakVal % 30 === 0);
    if (event?.isBirthday || goalMet || streakMilestone) {
      launchConfetti();
    }
  }

  // Progresso da meta semanal + bolinhas visuais
  const goal = state === 'allowed' ? event?.progress : null;
  progress.hidden = !goal;
  progress.textContent = goal
    ? (goal.visits >= goal.goal ? 'Meta semanal atingida!' : `${goal.visits} de ${goal.goal} visitas nesta semana`)
    : '';
  if (goalDots) {
    if (goal && Number(goal.goal) > 0 && Number(goal.goal) <= 7) {
      const totalDots = Number(goal.goal);
      const filledDots = Math.min(totalDots, Number(goal.visits || 0));
      goalDots.innerHTML = Array.from({ length: totalDots }, (_, idx) =>
        `<span class="turnstile-goal-dot ${idx < filledDots ? 'is-filled' : ''}"></span>`
      ).join('');
      goalDots.hidden = false;
    } else {
      goalDots.innerHTML = '';
      goalDots.hidden = true;
    }
  }

  if (progressWrap) {
    progressWrap.classList.toggle('is-empty', progress.hidden && (!goalDots || goalDots.hidden));
  }

  // Ficha do dia do aluno
  if (workoutCard && workoutTitle && workoutMeta) {
    const wk = state === 'allowed' ? event?.workoutSummary : null;
    if (wk?.title) {
      workoutTitle.textContent = wk.title;
      const metaParts = [
        wk.goal ? wk.goal : null,
        wk.exerciseCount ? `${wk.exerciseCount} ${wk.exerciseCount === 1 ? 'exercício' : 'exercícios'}` : null,
      ].filter(Boolean);
      workoutMeta.textContent = metaParts.length ? `· ${metaParts.join(' · ')}` : '';
      workoutCard.hidden = false;
    } else {
      workoutCard.hidden = true;
    }
  }

  if (birthdayBanner) {
    const showBirthday = state === 'allowed' && Boolean(event?.isBirthday);
    birthdayBanner.hidden = !showBirthday;
    birthdayBanner.classList.toggle('hidden', !showBirthday);
  }

  renderOccupancyBadge(event?.occupancyInfo ?? event?.occupancy);
  updateIdleWidgetsVisibility();

  const rawRemainingMs = Number(event?.remainingMs);
  const effectiveRemainingMs = (isNewEvent && state === 'denied')
    ? Math.max(Number.isFinite(rawRemainingMs) ? rawRemainingMs : 0, MIN_DENIED_DISPLAY_MS)
    : rawRemainingMs;

  if (isNewEvent && state === 'denied') {
    deniedLockUntil = Date.now() + effectiveRemainingMs;
  }

  if (isNewEvent) {
    animateTimerBar(effectiveRemainingMs, Math.max(Number(event?.totalMs || 0), effectiveRemainingMs));
  } else if (!event && timerBar) {
    timerBar.hidden = true;
  }

  if (event && effectiveRemainingMs > 0) {
    resetTimer = setTimeout(() => {
      deniedLockUntil = 0;
      render('idle');
    }, effectiveRemainingMs);
  }
}

function renderNotice(advance = false) {
  if (!noticeTextEl) return;
  clearTimeout(noticeFadeTimer);
  if (!noticeList.length) {
    noticeTextEl.textContent = '';
    if (noticeCounterEl) noticeCounterEl.hidden = true;
    return;
  }
  if (advance && noticeList.length > 1) {
    noticeIndex = (noticeIndex + 1) % noticeList.length;
    noticeTextEl.classList.add('is-fading');
    noticeFadeTimer = setTimeout(() => {
      const idx = noticeIndex % noticeList.length;
      noticeTextEl.textContent = noticeList[idx];
      if (noticeCounterEl) {
        noticeCounterEl.hidden = noticeList.length <= 1;
        noticeCounterEl.textContent = `${idx + 1}/${noticeList.length}`;
      }
      noticeTextEl.classList.remove('is-fading');
    }, 280);
    return;
  }
  const idx = noticeIndex % noticeList.length;
  noticeTextEl.classList.remove('is-fading');
  noticeTextEl.textContent = noticeList[idx];
  if (noticeCounterEl) {
    noticeCounterEl.hidden = noticeList.length <= 1;
    noticeCounterEl.textContent = `${idx + 1}/${noticeList.length}`;
  }
}

function updateIdleWidgetsVisibility() {
  const isIdle = display.dataset.state === 'idle' && preview.hidden;
  ranking.hidden = !isIdle || !rankingList.childElementCount;
  if (noticeBox) {
    noticeBox.hidden = !isIdle || !noticeList.length;
  }
  if (portalQrBox) portalQrBox.hidden = !isIdle;
  if (quoteBox) quoteBox.hidden = !isIdle;
  if (idleWidgets) {
    const hasNotice = Boolean(noticeBox && !noticeBox.hidden);
    const hasVisibleWidget = Boolean(
      !ranking.hidden
      || hasNotice
      || (portalQrBox && !portalQrBox.hidden)
      || (quoteBox && !quoteBox.hidden)
    );
    idleWidgets.classList.toggle('no-notice', !hasNotice);
    idleWidgets.classList.toggle('is-empty', !hasVisibleWidget);
  }
}

const DAILY_QUOTES = [
  'Disciplina é fazer hoje o que você prometeu a si mesmo ontem.',
  'O treino de hoje é a energia e a saúde do seu amanhã.',
  'Constância vence intensidade: apareça e dê o seu melhor.',
  'Cada série concluída te deixa mais forte do que quando entrou.',
  'Não espere motivação — comece o treino que a motivação vem.',
  'Seu único limite é desistir antes de tentar mais uma repetição.',
  'Pequenos passos todos os dias constroem grandes resultados.',
  'Cuide do seu corpo: é o único lugar onde você vive todos os dias.',
  'A força não vem da vitória, vem do esforço que você não pula.',
  'Mais um dia pago! Foco no movimento, na respiração e no seu ritmo.',
];

let quoteIndex = Math.floor(Date.now() / 86_400_000) % DAILY_QUOTES.length;
let quoteFadeTimer = null;
function renderDailyQuote(advance = false) {
  if (!quoteTextEl) return;
  clearTimeout(quoteFadeTimer);
  if (!advance) {
    quoteTextEl.classList.remove('is-fading');
    quoteTextEl.textContent = `“${DAILY_QUOTES[quoteIndex]}”`;
    return;
  }
  quoteIndex = (quoteIndex + 1) % DAILY_QUOTES.length;
  quoteTextEl.classList.add('is-fading');
  quoteFadeTimer = setTimeout(() => {
    quoteTextEl.textContent = `“${DAILY_QUOTES[quoteIndex]}”`;
    quoteTextEl.classList.remove('is-fading');
  }, 280);
}

function weatherIconForCode(code) {
  const n = Number(code);
  if (n === 0) return '☀️';
  if (n <= 3) return '⛅';
  if (n === 45 || n === 48) return '🌫️';
  if (n <= 67 || (n >= 80 && n <= 82)) return '🌧️';
  if (n >= 95) return '⛈️';
  return '🌤️';
}

async function refreshWeather() {
  if (!weatherBadge || document.hidden) return;
  try {
    const res = await fetchWithTimeout(
      'https://api.open-meteo.com/v1/forecast?latitude=-16.6869&longitude=-49.2648&current=temperature_2m,weather_code&timezone=America%2FSao_Paulo',
      4000,
    );
    if (!res.ok) return;
    const data = await res.json();
    const temp = data?.current?.temperature_2m;
    if (temp == null || Number.isNaN(Number(temp))) return;
    const iconChar = weatherIconForCode(data?.current?.weather_code);
    weatherBadge.textContent = `${iconChar} ${Math.round(Number(temp))}°C`;
    weatherBadge.hidden = false;
  } catch {
    // Offline ou sem resposta externa: mantém oculto sem afetar a catraca.
  }
}

async function fetchWithTimeout(url, ms = 3000, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

let rankingState = { streakRanking: [], ranking: [] };
let rankingMode = 'streak';
let rankingSwitchTimer = null;

function buildRankingEntries(rawList) {
  return rawList.slice(0, 5).map((entry, index) => {
    const item = document.createElement('li');
    if (index === 0) item.classList.add('is-top1');
    else if (index === 1) item.classList.add('is-top2');
    else if (index === 2) item.classList.add('is-top3');
    const position = document.createElement('span');
    const name = document.createElement('strong');
    const count = document.createElement('span');
    position.className = 'turnstile-rank-position';
    position.textContent = index === 0 ? '🥇 1º' : index === 1 ? '🥈 2º' : index === 2 ? '🥉 3º' : `${index + 1}º`;
    name.textContent = entry.alias;
    count.className = 'turnstile-rank-streak';
    if (typeof entry.streak === 'number') {
      count.textContent = `${entry.streak} ${entry.streak === 1 ? 'dia seguido' : 'dias seguidos'}`;
    } else {
      const visits = Number(entry.visits || 0);
      count.textContent = `${visits} ${visits === 1 ? 'visita' : 'visitas'}`;
    }
    item.append(position, name, count);
    return item;
  });
}

function renderRankingView(animate = false) {
  const hasStreak = rankingState.streakRanking.length > 0;
  const hasWeek = rankingState.ranking.length > 0;
  if (!hasStreak && !hasWeek) {
    rankingList.replaceChildren();
    updateIdleWidgetsVisibility();
    return;
  }
  const useStreak = (rankingMode === 'streak' && hasStreak) || !hasWeek;
  const targetTitle = useStreak ? '🔥 Top 5 · Dias seguidos' : '🏆 Top 5 · Semana';
  const targetList = useStreak ? rankingState.streakRanking : rankingState.ranking;

  const applyUpdate = () => {
    if (rankingTitle) rankingTitle.textContent = targetTitle;
    rankingList.replaceChildren(...buildRankingEntries(targetList));
    updateIdleWidgetsVisibility();
  };

  if (animate && ranking) {
    clearTimeout(rankingSwitchTimer);
    ranking.classList.add('is-switching');
    rankingSwitchTimer = setTimeout(() => {
      applyUpdate();
      ranking.classList.remove('is-switching');
    }, 220);
  } else {
    applyUpdate();
  }
}

function rotateRankingMode() {
  if (document.hidden || display?.dataset.state !== 'idle') return;
  if (rankingState.streakRanking.length > 0 && rankingState.ranking.length > 0) {
    rankingMode = rankingMode === 'streak' ? 'week' : 'streak';
    renderRankingView(true);
  }
}

async function pollRanking() {
  if (document.hidden) return;
  try {
    let data;
    if (window.oxigenioDemo) {
      data = await window.oxigenioDemo.request('/api/turnstile/ranking');
    } else {
      const response = await fetchWithTimeout('/api/turnstile/ranking?rich=1', 3000);
      if (!response.ok) throw new Error('Ranking indisponível');
      data = await response.json();
    }
    if (data?.gymName && gymNameEl) {
      gymNameEl.textContent = data.gymName;
    }
    if (data?.occupancy) {
      idleOccupancy = data.occupancy;
      if (display.dataset.state === 'idle') renderOccupancyBadge(idleOccupancy);
    }
    if (Array.isArray(data?.notices)) {
      const nextNotices = data.notices.map((n) => String(n || '').trim()).filter(Boolean);
      const changed = nextNotices.length !== noticeList.length || nextNotices.some((n, i) => n !== noticeList[i]);
      noticeList = nextNotices;
      if (changed) {
        if (noticeIndex >= noticeList.length) noticeIndex = 0;
        renderNotice(false);
      }
    }
    rankingState = {
      streakRanking: Array.isArray(data?.streakRanking) ? data.streakRanking : [],
      ranking: Array.isArray(data?.ranking) ? data.ranking : [],
    };
    renderRankingView(false);
  } catch {
    rankingState = { streakRanking: [], ranking: [] };
    rankingList.replaceChildren();
  } finally {
    updateIdleWidgetsVisibility();
    if (!document.hidden) {
      clearTimeout(pollRankingTimer);
      pollRankingTimer = setTimeout(pollRanking, 15000);
    }
  }
}

function updateClock() {
  const now = new Date();
  if (clockEl) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const colon = document.createElement('span');
    colon.className = 'turnstile-clock-colon';
    colon.setAttribute('aria-hidden', 'true');
    colon.textContent = ':';
    clockEl.replaceChildren(document.createTextNode(hh), colon, document.createTextNode(mm));
  }
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    });
  }
}

async function pollDisplay() {
  if (document.hidden) return;
  if (pollDisplayController) {
    pollDisplayController.abort();
  }
  const controller = new AbortController();
  pollDisplayController = controller;
  try {
    let event;
    if (window.oxigenioDemo) {
      event = await window.oxigenioDemo.request('/api/turnstile/display');
    } else {
      const response = await fetchWithTimeout('/api/turnstile/display?rich=1', 3000, controller.signal);
      if (!response.ok) throw new Error('Tela indisponível');
      event = await response.json();
    }
    if (controller.signal.aborted) return;
    offlineFailures = 0;
    if (event?.outcome === 'face_mirror') {
      if (Date.now() - faceMirrorChannelActiveAt > 1500) updateFaceMirror(event);
      if (Date.now() >= deniedLockUntil) render('idle');
    } else if (event && Object.hasOwn(screens, event.outcome)) {
      updateFaceMirror(null);
      if (event.outcome === 'idle' && Date.now() < deniedLockUntil) {
        return;
      }
      render(event.outcome, event);
    } else {
      if (Date.now() - faceMirrorChannelActiveAt > 1500) updateFaceMirror(null);
      if (Date.now() >= deniedLockUntil) render('idle');
    }
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') return;
    offlineFailures += 1;
    if (offlineFailures >= 3) render('offline');
  } finally {
    if (pollDisplayController === controller) {
      pollDisplayController = null;
      if (!document.hidden) {
        clearTimeout(pollDisplayTimer);
        pollDisplayTimer = setTimeout(pollDisplay, 650);
      }
    }
  }
}

async function requestKioskWakeLock() {
  if (!('wakeLock' in navigator) || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollDisplayTimer);
    clearTimeout(pollRankingTimer);
    if (pollDisplayController) {
      pollDisplayController.abort();
      pollDisplayController = null;
    }
    return;
  }
  clearTimeout(pollDisplayTimer);
  clearTimeout(pollRankingTimer);
  pollDisplay();
  pollRanking();
  updateClock();
  requestKioskWakeLock();
});

if (document.fullscreenEnabled && fullscreen) {
  const syncFullscreenButton = () => {
    const isFullscreen = Boolean(document.fullscreenElement);
    fullscreen.hidden = isFullscreen;
    fullscreen.textContent = isFullscreen ? 'Sair da tela cheia' : 'Tela cheia';
  };
  syncFullscreenButton();
  fullscreen.addEventListener('click', async () => {
    getAudioContext();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      fullscreen.textContent = 'Use F11 para tela cheia';
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
}

window.addEventListener('pointerdown', () => getAudioContext(), { once: true, passive: true });

updateClock();
setInterval(updateClock, 1000);
renderDailyQuote(false);
setInterval(() => renderDailyQuote(true), 45000);
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);
requestKioskWakeLock();
pollDisplay();
pollRanking();
setInterval(rotateRankingMode, 16000);
setInterval(() => renderNotice(true), 12000);
