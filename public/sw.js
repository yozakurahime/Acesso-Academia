const CACHE_VERSION = 'v19';
const SHELL_CACHE = `oxigenio-aluno-shell-${CACHE_VERSION}`;
const API_CACHE = `oxigenio-aluno-api-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/js/profile-extras.js',
  '/js/finance-reports.js',
  '/js/settings-ux.js',
  '/js/chat.js',
  '/admin.css',
  '/admin-operations.css',
  '/admin-manifest.json',
  '/aluno',
  '/aluno.html',
  '/aluno.css',
  '/styles.css',
  '/aluno.js',
  '/exercises.js',
  '/oxigenio.jpg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
  '/manifest.json',
];

const SHELL_ASSET_SET = new Set(SHELL_ASSETS);
const NETWORK_FIRST_SHELL_ASSETS = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/js/profile-extras.js',
  '/js/finance-reports.js',
  '/js/settings-ux.js',
  '/js/chat.js',
  '/admin.css',
  '/admin-operations.css',
  '/aluno.css',
  '/styles.css',
  '/aluno.js',
  '/exercises.js',
]);
const STUDENT_READ_ENDPOINTS = new Set([
  '/api/student/me',
  '/api/student/me/fitness',
  '/api/student/gamification',
  '/api/student/assessments',
  '/api/student/bookings',
  '/api/student/classes',
]);
const ADMIN_READ_ENDPOINTS = new Set([
  '/api/dashboard',
  '/api/members',
  '/api/plans',
  '/api/products',
  '/api/cash/current',
  '/api/cash/history',
  '/api/staff',
  '/api/settings',
  '/api/classes',
  '/api/modalities',
  '/api/payments',
  '/api/sales',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
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

  if (STUDENT_READ_ENDPOINTS.has(url.pathname) || ADMIN_READ_ENDPOINTS.has(url.pathname)) {
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

  const isAdminNavigate =
    request.mode === 'navigate' &&
    (url.pathname === '/' || url.pathname === '/index.html');

  if (isAdminNavigate) {
    event.respondWith(networkFirstNavigate(request, url, { fallbackPath: '/index.html' }));
    return;
  }

  if (NETWORK_FIRST_SHELL_ASSETS.has(url.pathname)) {
    event.respondWith(networkFirstNavigate(request, url, { isNavigate: false }));
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

async function matchShellCache(cache, cacheKey, isNavigate, fallbackPath = '/aluno.html') {
  const cached = await cache.match(cacheKey, { ignoreSearch: true });
  if (cached) return cached;
  if (isNavigate) {
    return cache.match(fallbackPath, { ignoreSearch: true });
  }
  return null;
}

async function networkFirstNavigate(request, url, { isNavigate = true, fallbackPath = '/aluno.html' } = {}) {
  const cache = await caches.open(SHELL_CACHE);
  const cacheKey = SHELL_ASSET_SET.has(url.pathname) ? url.pathname : request;

  try {
    const response = await fetch(request);
    if (response && response.ok && SHELL_ASSET_SET.has(url.pathname)) {
      await cache.put(url.pathname, response.clone());
    }
    if (response && response.status >= 500) {
      const fallback = await matchShellCache(cache, cacheKey, isNavigate, fallbackPath);
      if (fallback) return fallback;
    }
    return response;
  } catch (err) {
    const fallback = await matchShellCache(cache, cacheKey, isNavigate, fallbackPath);
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
