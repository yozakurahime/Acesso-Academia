const display = document.getElementById('display');
const statusLabel = document.getElementById('displayStatus');
const title = document.getElementById('displayTitle');
const message = document.getElementById('displayMessage');
const icon = document.getElementById('displayIcon');
const heroWrap = document.getElementById('displayHeroWrap');
const avatarImg = document.getElementById('displayAvatar');
const preview = document.getElementById('displayPreview');
const fullscreen = document.getElementById('fullscreen');
const progress = document.getElementById('displayProgress');
const goalDots = document.getElementById('displayGoalDots');
const planAlert = document.getElementById('displayPlanAlert');
const workoutCard = document.getElementById('displayWorkoutCard');
const workoutTitle = document.getElementById('displayWorkoutTitle');
const workoutMeta = document.getElementById('displayWorkoutMeta');
const ranking = document.getElementById('displayRanking');
const rankingList = document.getElementById('displayRankingList');
const challengeBox = document.getElementById('displayChallenge');
const challengeCount = document.getElementById('displayChallengeCount');
const challengeFill = document.getElementById('displayChallengeFill');
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
let challengeData = null;

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
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

function render(state, event) {
  const view = event ? `${state}:${event.id}` : state;
  if (lastView === view) return;
  const isNewEvent = Boolean(event && lastView !== view);
  lastView = view;
  clearTimeout(resetTimer);

  const [symbol, statusText, titleText, messageText] = screens[state];
  display.dataset.state = state;
  icon.textContent = symbol;
  preview.hidden = !event?.preview;
  statusLabel.textContent = state === 'idle' ? `${getTimeGreeting()} · ${statusText}` : statusText;
  title.textContent = ['allowed', 'denied'].includes(state) && event?.firstName
    ? event.firstName
    : titleText;
  message.textContent = state === 'allowed'
    ? 'Pode passar. Bom treino!'
    : state === 'denied' && event?.reason ? event.reason : messageText;

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

  if (isNewEvent) {
    animateTimerBar(event.remainingMs, event.totalMs);
  } else if (!event && timerBar) {
    timerBar.hidden = true;
  }

  const remainingMs = Number(event?.remainingMs);
  if (event && remainingMs > 0) {
    resetTimer = setTimeout(() => render('idle'), remainingMs);
  }
}

function updateIdleWidgetsVisibility() {
  const isIdle = display.dataset.state === 'idle' && preview.hidden;
  ranking.hidden = !isIdle || !rankingList.childElementCount;
  if (challengeBox) {
    challengeBox.hidden = !isIdle || !challengeData || !challengeData.target;
  }
  if (portalQrBox) portalQrBox.hidden = !isIdle;
  if (quoteBox) quoteBox.hidden = !isIdle;
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
function renderDailyQuote(advance = false) {
  if (!quoteTextEl) return;
  if (advance) quoteIndex = (quoteIndex + 1) % DAILY_QUOTES.length;
  quoteTextEl.textContent = `“${DAILY_QUOTES[quoteIndex]}”`;
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
    if (data?.challenge && challengeCount && challengeFill) {
      challengeData = data.challenge;
      const pct = Math.min(100, Math.round((Number(challengeData.completed || 0) / Math.max(1, Number(challengeData.target || 1))) * 100));
      challengeCount.textContent = `${challengeData.completed} / ${challengeData.target} treinos (${pct}%)`;
      challengeFill.style.width = `${pct}%`;
    }
    const rawList = (data?.streakRanking && data.streakRanking.length) ? data.streakRanking : (data?.ranking || []);
    const entries = rawList.slice(0, 5).map((entry, index) => {
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
    rankingList.replaceChildren(...entries);
  } catch {
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
    clockEl.textContent = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
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
      render('idle');
    } else if (event && Object.hasOwn(screens, event.outcome)) {
      updateFaceMirror(null);
      render(event.outcome, event);
    } else {
      if (Date.now() - faceMirrorChannelActiveAt > 1500) updateFaceMirror(null);
      render('idle');
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

if (document.fullscreenEnabled) {
  fullscreen.hidden = false;
  fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      fullscreen.textContent = 'Use F11 para tela cheia';
    }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });
}

updateClock();
setInterval(updateClock, 1000);
renderDailyQuote(false);
setInterval(() => renderDailyQuote(true), 45000);
refreshWeather();
setInterval(refreshWeather, 30 * 60 * 1000);
requestKioskWakeLock();
pollDisplay();
pollRanking();
