import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { ToletusClient } from '../src/services/toletusClient.js';
import { DeviceService } from '../src/services/deviceService.js';
import { AccessService } from '../src/services/accessService.js';

test('DeviceService: seeds default turnstile and reader and lists allowed callback IPs', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', controlid_ip: '192.168.100.50', toletus_ip: '192.168.100.242' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const devices = new DeviceService(store, controlId, toletus);

  const turnstiles = devices.listTurnstiles();
  const readers = devices.listReaders();
  assert.ok(turnstiles.length >= 1);
  assert.ok(readers.length >= 1);
  assert.equal(readers[0].turnstile_id, turnstiles[0].id);

  const allowed = devices.getAllowedCallbackIps();
  assert.ok(allowed.has('192.168.100.50'));
});

test('DeviceService: turnstile CRUD validates release_seconds, direction and free_side', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const devices = new DeviceService(store, controlId, toletus);

  const created = devices.createTurnstile({
    name: 'Catraca Fundo',
    driver: 'toletus',
    ip: '192.168.100.243',
    port: 7878,
    release_seconds: 12,
    default_direction: 'both',
    free_side: 'exit',
    active: true,
  });

  assert.equal(created.name, 'Catraca Fundo');
  assert.equal(created.release_seconds, 12);
  assert.equal(created.default_direction, 'both');
  assert.equal(created.free_side, 'exit');

  assert.throws(() => devices.createTurnstile({ name: 'X', ip: '192.168.100.243', release_seconds: 999 }), /Tempo de liberação/);
  assert.throws(() => devices.createTurnstile({ name: 'X', ip: '192.168.100.243', default_direction: 'invalid' }), /Direção/);
  assert.throws(() => devices.createTurnstile({ name: 'X', ip: '192.168.100.243', free_side: 'invalid' }), /Lado liberado/);

  const updated = devices.updateTurnstile(created.id, { free_side: 'both', release_seconds: 8 });
  assert.equal(updated.free_side, 'both');
  assert.equal(updated.release_seconds, 8);

  const removed = devices.deleteTurnstile(created.id);
  assert.equal(removed.deleted, true);
});

test('DeviceService: applyTurnstileConfig sends Toletus 0x020A duration and 0x0202 flow control packets', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const sent = [];
  toletus.sendPacket = async (packet, override) => {
    sent.push({ packet: Buffer.from(packet), override });
    return Buffer.alloc(20);
  };

  const devices = new DeviceService(store, controlId, toletus);
  const turnstile = devices.createTurnstile({
    name: 'Catraca Teste',
    driver: 'toletus',
    ip: '10.0.0.55',
    port: 7878,
    release_seconds: 7,
    default_direction: 'entry',
    free_side: 'exit',
  });

  const res = await devices.applyTurnstileConfig(turnstile.id);
  assert.equal(res.applied, true);
  assert.equal(sent.length, 3);

  // Command 0x020A: bytes [1..2] = 0x020A LE, payload [3..6] = 7000ms UInt32LE
  assert.equal(sent[0].packet.readUInt16LE(1), 0x020A);
  assert.equal(sent[0].packet.readUInt32LE(3), 7000);
  assert.equal(sent[0].override.ip, '10.0.0.55');

  // Command 0x0202: bytes [1..2] = 0x0202 LE, payload [3] = 1 (entrada controlada, saida livre)
  assert.equal(sent[1].packet.readUInt16LE(1), 0x0202);
  assert.equal(sent[1].packet[3], 1);

  // Command 0x020F: bytes [1..2] = 0x020F LE, payload [3] = 0 (exit), payload [4] = 0 (pictogramas ligados)
  assert.equal(sent[2].packet.readUInt16LE(1), 0x020F);
  assert.equal(sent[2].packet[3], 0);
  assert.equal(sent[2].packet[4], 0);

  // free_side = 'none' -> 0x0202=3 e 0x020F=2 com pictogramas=0
  devices.updateTurnstile(turnstile.id, { free_side: 'none' });
  await devices.applyTurnstileConfig(turnstile.id);
  assert.equal(sent[4].packet.readUInt16LE(1), 0x0202);
  assert.equal(sent[4].packet[3], 3);
  assert.equal(sent[5].packet.readUInt16LE(1), 0x020F);
  assert.equal(sent[5].packet[3], 2);
  assert.equal(sent[5].packet[4], 0);
});

test('DeviceService: reader CRUD masks password and links to turnstile', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const devices = new DeviceService(store, controlId, toletus);

  const turnstile = devices.createTurnstile({
    name: 'Catraca 2',
    driver: 'toletus',
    ip: '192.168.100.244',
  });
  const reader = devices.createReader({
    name: 'Leitor Saida',
    ip: '192.168.100.60',
    port: 80,
    username: 'admin',
    password: 'secret-password',
    direction: 'exit',
    turnstile_id: turnstile.id,
  });

  assert.equal(reader.password, '******');
  assert.equal(reader.turnstile_id, turnstile.id);
  assert.equal(reader.turnstile_name, 'Catraca 2');

  const rawReader = devices.getReader(reader.id, { includeSecret: true });
  assert.equal(rawReader.password, 'secret-password');
});

test('AccessService: routes releaseTurnstile and handleFaceIdentified via linked reader and turnstile', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'false', toletus_enabled: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const calls = [];
  toletus.releaseDirection = async (direction, message, override) => {
    calls.push({ direction, message, override });
    return { released: true, direction, message };
  };

  const devices = new DeviceService(store, controlId, toletus);
  const access = new AccessService(store, controlId, toletus);

  const catraca2 = devices.createTurnstile({
    name: 'Catraca Lateral',
    driver: 'toletus',
    ip: '192.168.100.250',
    port: 7878,
    release_seconds: 10,
    default_direction: 'both',
    free_side: 'none',
  });
  devices.createReader({
    name: 'Leitor Lateral Saida',
    ip: '192.168.100.77',
    direction: 'exit',
    turnstile_id: catraca2.id,
  });

  await access.releaseTurnstile('both', 'LIBERADO', { turnstileId: catraca2.id });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].direction, 'both');
  assert.equal(calls[0].override.ip, '192.168.100.250');

  const mensal = access.listPlans().find((p) => p.name === 'Mensal');
  const member = await access.createMember({
    name: 'Aluno Teste',
    document: '52998224725',
    phone: '11999999999',
    plan_id: mensal.id,
  });
  await access.recordPayment({
    member_id: member.id,
    plan_id: mensal.id,
    method: 'pix',
  });
  store.run('UPDATE members SET controlid_user_id = ? WHERE id = ?', [9876, member.id]);
  controlId.getDeviceUser = async () => ({ id: 9876, name: 'Aluno Teste', registration: '52998224725' });

  const decision = await access.handleFaceIdentified(9876, { readerIp: '::ffff:192.168.100.77' });
  assert.equal(decision.allowed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].direction, 'exit');
  assert.equal(calls[1].override.ip, '192.168.100.250');
});

test('AccessService: caches verified device identity on turnstile pass and propagates sync to secondary active readers', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'false', toletus_enabled: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  toletus.releaseDirection = async (direction, message) => ({ released: true, direction, message });

  const syncedOnPrimary = [];
  const syncedOnSecondary = [];
  const facesOnSecondary = [];

  controlId.syncMember = async (m, allowed) => {
    syncedOnPrimary.push({ id: m.id, allowed });
    return { synced: true, controlIdUserId: m.controlid_user_id || m.id };
  };
  controlId.uploadUserFace = async () => ({ uploaded: true });
  controlId.forDevice = (reader) => ({
    syncMember: async (m, allowed) => {
      syncedOnSecondary.push({ readerIp: reader.ip, id: m.id, allowed });
      return { synced: true };
    },
    uploadUserFace: async (deviceUserId, buf) => {
      facesOnSecondary.push({ readerIp: reader.ip, deviceUserId, size: buf.length });
      return { uploaded: true };
    },
  });

  const devices = new DeviceService(store, controlId, toletus);
  devices.createReader({
    name: 'Leitor Secundario Entrada 2',
    ip: '192.168.100.88',
    port: 80,
    direction: 'entry',
    active: true,
  });

  const access = new AccessService(store, controlId, toletus);
  const member = await access.createMember({
    name: 'Carlos Cache',
    document: '52998224725',
    access_role: 'staff',
  });

  // Secondary reader received automatic member sync on createMember
  assert.equal(syncedOnPrimary.length, 1);
  assert.equal(syncedOnSecondary.length, 1);
  assert.equal(syncedOnSecondary[0].readerIp, '192.168.100.88');

  // Registering face propagates to secondary reader as well
  const fakeJpegBase64 = Buffer.from('fake-jpeg-binary').toString('base64');
  await access.registerFace(member.id, fakeJpegBase64);
  assert.equal(facesOnSecondary.length, 1);
  assert.equal(facesOnSecondary[0].readerIp, '192.168.100.88');

  let getDeviceUserCalls = 0;
  controlId.getDeviceUser = async (id) => {
    getDeviceUserCalls += 1;
    return { id, name: 'Carlos Cache', registration: '52998224725' };
  };

  // First pass calls getDeviceUser and caches positive verification
  const pass1 = await access.handleFaceIdentified(member.id);
  assert.equal(pass1.allowed, true);
  assert.equal(getDeviceUserCalls, 1);

  // Second pass within TTL uses cache without extra HTTP call to Control iD
  const pass2 = await access.handleFaceIdentified(member.id);
  assert.equal(pass2.allowed, true);
  assert.equal(getDeviceUserCalls, 1);

  // If cache expires and reader has transient network error, previously verified member still passes
  access._verifiedDeviceUsers.get(member.id).expiresAt = Date.now() - 1000;
  controlId.getDeviceUser = async () => {
    getDeviceUserCalls += 1;
    throw new Error('ETIMEDOUT');
  };
  const pass3 = await access.handleFaceIdentified(member.id);
  assert.equal(pass3.allowed, true);
  assert.equal(getDeviceUserCalls, 2);
});
