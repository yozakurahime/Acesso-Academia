import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { AuthService } from '../src/services/authService.js';
import { createApiRouter } from '../src/routes/api.js';

test('AuthService configura senha, gera cookie assinado e protege rotas mantendo webhooks e catraca liberados', async () => {
  const store = await DatabaseStore.create(null);
  const auth = new AuthService(store);

  assert.equal(auth.isEnabled(), false);
  assert.throws(() => auth.configure({ enabled: true, username: 'admin', password: '' }), /Defina uma senha/);
  assert.throws(() => auth.configure({ enabled: true, username: 'admin', password: '123' }), /entre 8 e 128/);

  const cfg = auth.configure({ enabled: true, username: 'oxigenio', password: 'segredo-forte' });
  assert.equal(cfg.enabled, true);
  assert.equal(auth.isEnabled(), true);
  assert.equal(auth.authenticate('oxigenio', 'segredo-forte'), true);
  assert.equal(auth.authenticate('oxigenio', 'errada'), false);
  assert.equal(auth.authenticate('outro', 'segredo-forte'), false);

  const token = auth.signToken('oxigenio');
  assert.equal(auth.verifyToken(token)?.u, 'oxigenio');
  assert.equal(auth.verifyToken(`${token}x`), null);

  const mw = auth.middleware();
  const callMw = (path, cookie = '') =>
    new Promise((resolve) => {
      const req = { path, headers: cookie ? { cookie } : {} };
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(obj) {
          this.body = obj;
          resolve({ nextCalled: false, statusCode: this.statusCode, body: obj });
        },
      };
      mw(req, res, () => resolve({ nextCalled: true, statusCode: 200, req }));
    });

  const blocked = await callMw('/members');
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 401);
  assert.equal(blocked.body.code, 'AUTH_REQUIRED');

  const allowedWebhook = await callMw('/webhooks/asaas');
  assert.equal(allowedWebhook.nextCalled, true);

  const allowedTurnstile = await callMw('/new_user_identified.fcgi');
  assert.equal(allowedTurnstile.nextCalled, true);

  const allowedAuthed = await callMw('/members', `acesso_session=${encodeURIComponent(token)}`);
  assert.equal(allowedAuthed.nextCalled, true);
  assert.equal(allowedAuthed.req.authUser, 'oxigenio');
});

test('tela e atalho locais funcionam com login ativo e têm proteção de origem', async (t) => {
  const store = await DatabaseStore.create();
  const authService = new AuthService(store);
  authService.configure({ enabled: true, username: 'teste', password: 'senha-teste' });
  let releases = 0;
  const accessService = {
    getTurnstileDisplay: () => null,
    releaseTurnstile: async () => { releases++; return {}; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService, accessService, hotkeyToken: 'token-teste' }));
  const server = await new Promise((resolve) => {
    const result = app.listen(0, '127.0.0.1', () => resolve(result));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(base + '/turnstile/display')).status, 200);
  assert.equal((await fetch(base + '/turnstile/display', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403);
  assert.equal((await fetch(base + '/device/release', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/device/release', { method: 'POST', headers: { 'x-oxigenio-hotkey': 'token-teste' } })).status, 200);
  assert.equal(releases, 1);

  const statusUnauth = await (await fetch(base + '/auth/status')).json();
  assert.equal(statusUnauth.authenticated, false);
  assert.equal(statusUnauth.username, null);

  const loginRes = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teste', password: 'senha-teste' }),
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('set-cookie').split(';')[0];

  store.updateSettings({
    wellhub_api_key: 'wh-key',
    wellhub_webhook_secret: 'wh-sec',
    totalpass_api_token: 'tp-tok',
    totalpass_webhook_secret: 'tp-sec',
  });
  const settingsRes = await (await fetch(base + '/settings', { headers: { cookie: adminCookie } })).json();
  assert.equal(settingsRes.wellhub_api_key, '******');
  assert.equal(settingsRes.wellhub_webhook_secret, '******');
  assert.equal(settingsRes.totalpass_api_token, '******');
  assert.equal(settingsRes.totalpass_webhook_secret, '******');

  const badIpRes = await fetch(base + '/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ controlid_ip: '127.0.0.1' }),
  });
  assert.equal(badIpRes.status, 400);
});

test('AuthService suporta tempo de sessao, bloqueio por inatividade, lista de operadores e troca rapida (/api/auth/switch)', async (t) => {
  const store = await DatabaseStore.create();
  const authService = new AuthService(store);
  authService.configure({
    enabled: true,
    username: 'admin',
    password: 'senha-admin-forte',
    idleTimeoutMinutes: 15,
    sessionTtlHours: 24,
  });
  authService.createUser({ username: 'recepcao1', password: 'senha-recepcao-1', role: 'reception' });

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService }));
  const server = await new Promise((resolve) => {
    const result = app.listen(0, '127.0.0.1', () => resolve(result));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const status = await (await fetch(base + '/auth/status')).json();
  assert.equal(status.enabled, true);
  assert.equal(status.idleTimeoutMinutes, 15);
  assert.equal(status.sessionTtlHours, 24);
  assert.deepEqual(
    status.operators.map((o) => `${o.username}:${o.role}`),
    ['admin:admin', 'recepcao1:reception'],
  );

  // Login temporario (rememberSession: false) nao envia Max-Age
  const tempLogin = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'senha-admin-forte', rememberSession: false }),
  });
  assert.equal(tempLogin.status, 200);
  const setCookieHeader = tempLogin.headers.get('set-cookie') || '';
  assert.doesNotMatch(setCookieHeader, /Max-Age=/i);
  const adminCookie = setCookieHeader.split(';')[0];

  // Troca de operador com senha errada falha sem derrubar sessao atual
  const badSwitch = await fetch(base + '/auth/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'recepcao1', password: 'errada' }),
  });
  assert.equal(badSwitch.status, 401);

  // Troca de operador valida atualiza cookie e retorna novo papel
  const goodSwitch = await fetch(base + '/auth/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'recepcao1', password: 'senha-recepcao-1' }),
  });
  assert.equal(goodSwitch.status, 200);
  const switchedBody = await goodSwitch.json();
  assert.equal(switchedBody.username, 'recepcao1');
  assert.equal(switchedBody.role, 'reception');
  const receptionCookie = (goodSwitch.headers.get('set-cookie') || '').split(';')[0];

  const switchedStatus = await (await fetch(base + '/auth/status', { headers: { cookie: receptionCookie } })).json();
  assert.equal(switchedStatus.authenticated, true);
  assert.equal(switchedStatus.username, 'recepcao1');
  assert.equal(switchedStatus.role, 'reception');
});
