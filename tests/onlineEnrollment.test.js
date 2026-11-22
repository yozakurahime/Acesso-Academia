import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { GymService } from '../src/services/gymService.js';
import { AccessService } from '../src/services/accessService.js';
import { AuthService } from '../src/services/authService.js';
import { createApiRouter } from '../src/routes/api.js';

test('class rules: Pilates 18h blocks new enrollments while keeping existing, Hidro caps 15, Natacao Adulto caps 6, Infantil is reception_only', async () => {
  const store = await DatabaseStore.create(null);
  const gym = new GymService(store);
  const access = new AccessService(store);

  const modPilates = gym.createModality({ name: 'Pilates' });
  const modHidro = gym.createModality({ name: 'Hidroginástica' });
  const modNatAdult = gym.createModality({ name: 'Natação Adulto' });
  const modNatKids = gym.createModality({ name: 'Natação Infantil' });

  const clsPilates18 = gym.createClass({ name: 'Pilates 18h', modality_id: modPilates.id, schedule: 'Seg/Qua 18:00', capacity: 10 });
  const clsHidro = gym.createClass({ name: 'Hidroginástica Manhã', modality_id: modHidro.id, schedule: '08:00', capacity: 25 });
  const clsNatAdult = gym.createClass({ name: 'Natação Adulto Noite', modality_id: modNatAdult.id, schedule: '19:00', capacity: 12 });
  const clsNatKids = gym.createClass({ name: 'Natação Infantil Tarde', modality_id: modNatKids.id, schedule: '15:00', capacity: 8 });

  assert.equal(clsPilates18.allow_new_enrollments, 0);
  assert.equal(clsHidro.capacity, 15);
  assert.equal(clsNatAdult.capacity, 6);
  assert.equal(clsNatKids.online_enrollment_mode, 'reception_only');

  const m1 = await access.createMember({ name: 'Aluno Novo', document: '52998224725', phone: '62999990001' });
  assert.throws(() => gym.enrollMemberInClass(clsPilates18.id, m1.id), /fechada para novas matriculas/i);

  // Existing enrolled student keeps working normally
  store.run('INSERT INTO class_enrollments (class_id, member_id) VALUES (?, ?)', [clsPilates18.id, m1.id]);
  const existingRes = gym.enrollMemberInClass(clsPilates18.id, m1.id);
  assert.equal(existingRes.ok, true);
});

test('POST /api/public/enroll exige turma obrigatoria para Natacao, Hidroginastica e Pilates', async () => {
  const store = await DatabaseStore.create(null);
  const gymService = new GymService(store);
  const accessService = new AccessService(store);
  const authService = new AuthService(store);

  const plan = accessService.createPlan({ name: 'Mensal Teste', duration_days: 30, price_cents: 15000, online_available: 1 });
  const modHidro = gymService.createModality({ name: 'Hidroginástica' });
  const modPilates = gymService.createModality({ name: 'Pilates' });
  const modNatAdult = gymService.createModality({ name: 'Natação Adulto' });
  const clsHidro = gymService.createClass({ name: 'Hidro 08h', modality_id: modHidro.id, schedule: '08:00', capacity: 15 });
  gymService.createClass({ name: 'Pilates 10h', modality_id: modPilates.id, schedule: '10:00', capacity: 10 });
  gymService.createClass({ name: 'Natação Adulto 19h', modality_id: modNatAdult.id, schedule: '19:00', capacity: 6 });

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, accessService, gymService, authService }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [idx, mod] of [modHidro, modPilates, modNatAdult].entries()) {
      const res = await fetch(`${baseUrl}/api/public/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Teste ${idx}`,
          phone: `6299999001${idx}`,
          modality_id: mod.id,
          plan_id: plan.id,
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /turma/i);
    }

    const okRes = await fetch(`${baseUrl}/api/public/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Aluno Hidro Valido',
        phone: '62999990099',
        document: '52998224725',
        modality_id: modHidro.id,
        class_id: clsHidro.id,
        plan_id: plan.id,
      }),
    });
    const okJson = await okRes.json();
    assert.equal(okRes.status, 201, JSON.stringify(okJson));
    assert.equal(okJson.mode, 'enrolled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
