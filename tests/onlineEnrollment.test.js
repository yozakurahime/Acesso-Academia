import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { GymService } from '../src/services/gymService.js';
import { AccessService } from '../src/services/accessService.js';

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
