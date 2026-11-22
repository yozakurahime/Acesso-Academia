const CACHE_VERSION = 'v12';
const SHELL_CACHE = `oxigenio-aluno-shell-${CACHE_VERSION}`;
const API_CACHE = `oxigenio-aluno-api-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/aluno',
  '/aluno.html',
  '/aluno.css',
  '/styles.css',
  '/aluno.js',
  '/exercise-catalog.js',
  '/exercises.js',
  '/oxigenio.jpg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
  '/manifest.json',
];

const SHELL_ASSET_SET = new Set(SHELL_ASSETS);
const STUDENT_READ_ENDPOINTS = new Set([
  '/api/student/me',
  '/api/student/me/fitness',
  '/api/student/gamification',
  '/api/student/assessments',
  '/api/student/bookings',
  '/api/student/classes',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const validCaches = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('oxigenio-aluno-') && !validCaches.has(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (STUDENT_READ_ENDPOINTS.has(url.pathname)) {
    event.respondWith(networkFirstWorkouts(request));
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  const isStudentNavigate =
    request.mode === 'navigate' &&
    (url.pathname === '/aluno' || url.pathname.startsWith('/aluno/'));

  if (isStudentNavigate) {
    event.respondWith(networkFirstNavigate(request, url));
    return;
  }

const NETWORK_FIRST_SHELL_ASSETS = new Set([
  '/aluno.css',
  '/styles.css',
  '/aluno.js',
  '/exercise-catalog.js',
  '/exercises.js',
]);

  if (NETWORK_FIRST_SHELL_ASSETS.has(url.pathname)) {
    event.respondWith(networkFirstNavigate(request, url));
    return;
  }

  if (SHELL_ASSET_SET.has(url.pathname)) {
    event.respondWith(staleWhileRevalidateShell(event, request, url));
  }
});

async function networkFirstWorkouts(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Sem conexão e sem treinos salvos em cache.' }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }
}

async function matchShellCache(cache, cacheKey, isNavigate) {
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  if (cached) return cached;
  if (isNavigate) {
    return cache.match('/aluno.html', { ignoreSearch: true });
  }
  return null;
}

async function networkFirstNavigate(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const cacheKey = SHELL_ASSET_SET.has(url.pathname) ? url.pathname : request;

  try {
    const response = await fetch(request);
    if (response && response.ok && SHELL_ASSET_SET.has(url.pathname)) {
      await cache.put(url.pathname, response.clone());
    }
    if (response && response.status >= 500) {
      const fallback = await matchShellCache(cache, cacheKey, true);
      if (fallback) return fallback;
    }
    return response;
  } catch (err) {
    const fallback = await matchShellCache(cache, cacheKey, true);
    if (fallback) return fallback;
    throw err;
  }
}

async function staleWhileRevalidateShell(event, request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const cacheKey = url.search ? request : url.pathname;
  const cached = await cache.match(cacheKey, { ignoreSearch: !url.search });

  const fetchAndUpdate = fetch(request).then(async (response) => {
    if (response && response.ok) {
      await cache.put(cacheKey, response.clone());
    }
    return response;
  });

  if (cached) {
    event.waitUntil(fetchAndUpdate.catch(() => {}));
    return cached;
  }

  return fetchAndUpdate;
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_STUDENT_CACHE') {
    event.waitUntil(caches.delete(API_CACHE));
  }
});
