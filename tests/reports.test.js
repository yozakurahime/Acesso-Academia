import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { AccessService } from '../src/services/accessService.js';

test('AccessService gera resumo financeiro mensal, projeções, alunos, cancelamentos e permanência média', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const access = new AccessService(store, controlId);

  const plan = access.listPlans().find((p) => p.price_cents === 12000) || access.listPlans()[0];
  const m1 = await access.createMember({ name: 'Ana Ativa', document: '52998224725', plan_id: plan.id });
  const m2 = await access.createMember({ name: 'Bruno Cancelado', document: '11144477735', plan_id: plan.id });

  // Registra pagamento para Ana (ativa e gera MRR)
  await access.recordPayment(
    { member_id: m1.id, plan_id: plan.id, amount_cents: plan.price_cents, method: 'pix' },
    { requireOpenCash: false },
  );

  // Registra cancelamento para Bruno com motivo
  const cancel = await access.recordCancellation({
    member_id: m2.id,
    reason: 'Falta de tempo',
    notes: 'Horário do trabalho',
  });
  assert.equal(cancel.reason, 'Falta de tempo');
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [m2.id]).status, 'blocked');

  const report = access.getAnalyticsReport();
  assert.equal(report.financial.mensalidadesCents, plan.price_cents);
  assert.equal(report.financial.paymentsCount, 1);
  assert.equal(report.financial.byMethod[0].code, 'pix');
  assert.ok(report.projections.mrrCents > 0);
  assert.equal(report.projections.series.length, 9); // 6 realizados + 3 projetados
  assert.equal(report.projections.series.filter((s) => s.projected).length, 3);
  assert.equal(report.members.active, 1);
  assert.equal(report.members.canceledInMonth, 1);
  assert.equal(report.cancellations.total, 1);
  assert.equal(report.cancellations.byReason[0].reason, 'Falta de tempo');
  assert.equal(typeof report.retention.avgMonthsOverall, 'number');
  assert.equal(report.retention.avgPaymentsPerMember, 1);
});
