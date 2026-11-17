import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { EdgeCloudHub, EdgeSyncClient } from '../src/services/edgeSyncService.js';

test('EdgeCloudHub gera snapshot seguro e EdgeSyncClient aplica no banco local', async () => {
  const cloudStore = await DatabaseStore.create(null);
  cloudStore.updateSettings({
    tolerance_days: '3',
    antipassback_minutes: '5',
    max_capacity: '60',
    gemini_api_key: 'SECRET-KEY-SHOULD-NOT-LEAK',
  });
  cloudStore.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 12000)");
  cloudStore.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id, controlid_user_id) VALUES ('Carlos Silva', '12345678901', '64999990000', 'active', '2026-12-31', 1, 101)",
  );

  const hub = new EdgeCloudHub(cloudStore);
  const snapshot = hub.getSnapshot();

  assert.ok(snapshot.plans.length >= 1);
  assert.equal(snapshot.members.length, 1);
  assert.equal(snapshot.members[0].name, 'Carlos Silva');
  assert.equal(snapshot.settings.tolerance_days, '3');
  assert.equal(snapshot.settings.gemini_api_key, undefined);

  const edgeStore = await DatabaseStore.create(null);
  const client = new EdgeSyncClient({
    store: edgeStore,
    accessService: { releaseTurnstile: async () => ({}) },
    cloudUrl: 'https://cloud.example',
    token: 'tok',
  });
  client.applySnapshot(snapshot);

  const localMember = edgeStore.get('SELECT * FROM members WHERE id = 1');
  assert.equal(localMember.name, 'Carlos Silva');
  assert.equal(localMember.controlid_user_id, 101);
  assert.equal(edgeStore.getSettings().tolerance_days, '3');
  assert.equal(edgeStore.getSettings().gemini_api_key, '');
});

test('EdgeSyncClient envia logs pendentes e EdgeCloudHub ingere de forma idempotente', async () => {
  const cloudStore = await DatabaseStore.create(null);
  const edgeStore = await DatabaseStore.create(null);
  const hub = new EdgeCloudHub(cloudStore);

  edgeStore.run(
    "INSERT INTO access_logs (controlid_user_id, member_name, event_code, event_label, occurred_at) VALUES (55, 'Maria', 7, 'Entrada liberada', '2026-11-17T18:00:00')",
  );

  const client = new EdgeSyncClient({
    store: edgeStore,
    accessService: { releaseTurnstile: async () => ({}) },
    cloudUrl: 'https://cloud.example',
    token: 'tok',
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      const result = hub.ingestLogs(body.logs);
      // Envio duplicado simulado nao pode duplicar no cloud
      const dupResult = hub.ingestLogs(body.logs);
      assert.equal(dupResult.inserted, 0);
      return { ok: true, json: async () => result };
    },
  });

  const pushed = await client.pushPendingLogs();
  assert.equal(pushed.pushed, 1);

  const cloudLogs = cloudStore.all('SELECT * FROM access_logs');
  assert.equal(cloudLogs.length, 1);
  assert.equal(cloudLogs[0].member_name, 'Maria');

  const secondPush = await client.pushPendingLogs();
  assert.equal(secondPush.pushed, 0);
});

test('EdgeCloudHub enfileira comando release e EdgeSyncClient executa e confirma ack', async () => {
  const cloudStore = await DatabaseStore.create(null);
  const edgeStore = await DatabaseStore.create(null);
  const hub = new EdgeCloudHub(cloudStore);

  const received = [];
  const unsubscribe = hub.subscribeCommands((cmd) => received.push(cmd));
  const cmd = hub.enqueueCommand('release', { direction: 'entry', turnstileId: 1 });
  assert.equal(received.length, 1);
  assert.equal(hub.getStatus().pendingCommands, 1);

  let released = null;
  let ackedId = null;
  const client = new EdgeSyncClient({
    store: edgeStore,
    accessService: {
      releaseTurnstile: async (direction, msg, opts) => {
        released = { direction, msg, opts };
        return { ok: true };
      },
    },
    cloudUrl: 'https://cloud.example',
    token: 'tok',
    fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      ackedId = body.id;
      hub.ackCommand(body.id);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await client._handleCommand(cmd);
  assert.deepEqual(released, { direction: 'entry', msg: 'LIBERADO', opts: { turnstileId: 1 } });
  assert.equal(ackedId, cmd.id);
  assert.equal(hub.getStatus().pendingCommands, 0);

  unsubscribe();
});
