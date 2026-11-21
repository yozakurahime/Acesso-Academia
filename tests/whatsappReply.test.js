import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { createApiRouter } from '../src/routes/api.js';
import { WhatsappService } from '../src/services/whatsappService.js';

test('resposta do chat informa configuração ausente e erro Meta sem expor token', async (context) => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ whatsapp_provider: 'meta_cloud' });
  let requests = 0;
  let recorded = 0;
  let accepted = false;
  const whatsappService = new WhatsappService(store, {
    fetchFn: async () => {
      requests++;
      return {
        ok: accepted,
        status: accepted ? 200 : 401,
        json: async () => accepted
          ? { messages: [{ id: 'wamid.test' }] }
          : { error: { code: 190, message: 'Invalid OAuth access token: secret-test-token' } },
      };
    },
    onBotMessage: {
      markHumanTakeover: () => {},
      recordChatMessage: () => { recorded++; },
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, whatsappService }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  context.after(() => server.close());
  const send = () => fetch(`http://127.0.0.1:${server.address().port}/api/whatsapp/chats/556284211039/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'teste' }),
  });
  const missing = await send();
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Phone Number ID e o Access Token/);
  assert.equal(requests, 0);
  store.updateSettings({
    whatsapp_meta_phone_number_id: '123456789',
    whatsapp_meta_access_token: 'secret-test-token',
  });
  const rejected = await send();
  assert.equal(rejected.status, 422);
  const failure = await rejected.json();
  assert.match(failure.error, /WhatsApp Meta \(190\): Invalid OAuth/);
  assert.ok(!failure.error.includes('secret-test-token'));
  assert.equal(recorded, 0);
  accepted = true;
  const success = await send();
  assert.equal(success.status, 200);
  assert.equal((await success.json()).ok, true);
  assert.equal(recorded, 1);
});
