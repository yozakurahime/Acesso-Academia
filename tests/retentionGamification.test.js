import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { studentFitnessProgress } from '../src/services/fitnessProgress.js';

test('studentFitnessProgress tracks monthly visits, streak, totalVisits and new medals', async () => {
  const store = await DatabaseStore.create(null);
  const access = new AccessService(store);
  const member = await access.createMember({ name: 'Ana Atleta', document: '52998224725', phone: '62999992222' });

  for (let i = 0; i < 8; i += 1) {
    const day = String(10 + i).padStart(2, '0');
    store.run(
      "INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'Acesso autorizado (FaceID)', ?)",
      [member.id, `2026-11-${day} 08:00:00`],
    );
  }

  const progress = studentFitnessProgress(store, member.id, '2026-11-17');
  assert.equal(progress.monthVisits.length, 8);
  assert.equal(progress.currentStreak, 8);
  assert.equal(progress.totalVisits, 8);
  const sevenDayMedal = progress.achievements.find((a) => a.name === '7 dias seguidos');
  assert.equal(sevenDayMedal?.earned, true);
});

test('getChurnRiskMembers identifies active student with sharp attendance drop', async () => {
  const store = await DatabaseStore.create(null);
  const access = new AccessService(store);
  const plan = access.createPlan({ name: 'Mensal', duration_days: 30, price_cents: 10000 });
  const member = await access.createMember({
    name: 'Pedro Sumido',
    document: '52998224725',
    phone: '62999993333',
    plan_id: plan.id,
    valid_until: '2026-12-10',
  });
  store.run("UPDATE members SET status = 'active' WHERE id = ?", [member.id]);

  for (const d of ['2026-10-22', '2026-10-24', '2026-10-26', '2026-10-28']) {
    store.run(
      "INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'Acesso autorizado (FaceID)', ?)",
      [member.id, `${d} 18:00:00`],
    );
  }

  const risks = access.getChurnRiskMembers({ refToday: '2026-11-17' });
  assert.equal(risks.length, 1);
  assert.equal(risks[0].id, member.id);
  assert.equal(risks[0].prev_visits, 4);
  assert.equal(risks[0].recent_visits, 0);
  assert.equal(risks[0].risk_level, 'high');
});
