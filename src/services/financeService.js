function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function localDateIso(offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentMonthIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthDateRange(month) {
  const clean = String(month || '').trim();
  const match = clean.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw httpError('Mês inválido. Use o formato YYYY-MM.');
  }
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) {
    throw httpError('Mês inválido. Use o formato YYYY-MM.');
  }
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  return {
    month: clean,
    start: `${match[1]}-${match[2]}-01`,
    nextStart: `${String(nextYear).padStart(4, '0')}-${String(nextMon).padStart(2, '0')}-01`,
  };
}

function isValidIsoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function formatMoneyBr(cents) {
  return ((Number(cents) || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatDateBr(iso) {
  if (!iso) return '-';
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(iso);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export class FinanceService {
  constructor(store) {
    this.store = store;
  }

  listExpenses({ status, month } = {}) {
    const clauses = [];
    const params = [];

    if (status) {
      clauses.push('status = ?');
      params.push(String(status).trim());
    }
    if (month) {
      const { start, nextStart } = monthDateRange(month);
      clauses.push('due_date >= ? AND due_date < ?');
      params.push(start, nextStart);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.store.all(
      `SELECT * FROM expenses ${where} ORDER BY due_date ASC, id DESC`,
      params,
    );
  }

  createExpense({ description, category = 'geral', amount_cents, due_date, notes = null }) {
    const cleanDescription = String(description || '').trim();
    if (!cleanDescription) {
      throw httpError('Descrição da despesa é obrigatória.');
    }

    const amount = Number(amount_cents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw httpError('Valor da despesa deve ser um inteiro positivo em centavos.');
    }

    const cleanDueDate = String(due_date || '').trim();
    if (!isValidIsoDate(cleanDueDate)) {
      throw httpError('Data de vencimento inválida. Use YYYY-MM-DD.');
    }

    const cleanCategory = String(category || 'geral').trim() || 'geral';
    const cleanNotes = notes != null && String(notes).trim() ? String(notes).trim() : null;

    const res = this.store.run(
      `INSERT INTO expenses (description, category, amount_cents, due_date, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [cleanDescription, cleanCategory, amount, cleanDueDate, cleanNotes],
    );
    return this.store.get('SELECT * FROM expenses WHERE id = ?', [res.lastInsertRowid]);
  }

  markExpensePaid(id, paymentMethod = null) {
    const existing = this.store.get('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!existing) {
      throw httpError('Despesa não encontrada.', 404);
    }

    const method = paymentMethod != null && String(paymentMethod).trim()
      ? String(paymentMethod).trim()
      : existing.payment_method;

    this.store.transaction(() => {
      this.store.run(
        `UPDATE expenses
         SET status = 'paid',
             paid_at = COALESCE(paid_at, datetime('now', 'localtime')),
             payment_method = ?
         WHERE id = ?`,
        [method, id],
      );

      if (existing.status !== 'paid') {
        const openCash = this.store.get("SELECT id FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
        if (openCash) {
          this.store.run(
            'INSERT INTO cash_movements (session_id, type, amount_cents, method, description) VALUES (?, ?, ?, ?, ?)',
            [openCash.id, 'out', existing.amount_cents, method || 'cash', `Despesa: ${existing.description}`],
          );
        }
      }
    });
    return this.store.get('SELECT * FROM expenses WHERE id = ?', [id]);
  }

  deleteExpense(id) {
    const existing = this.store.get('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!existing) {
      throw httpError('Despesa não encontrada.', 404);
    }
    if (existing.status === 'paid') {
      throw httpError('Não é possível excluir uma despesa já paga.', 409);
    }
    this.store.run('DELETE FROM expenses WHERE id = ?', [id]);
    return { deleted: true, id: existing.id };
  }

  getDreSummary(month = currentMonthIso()) {
    const { month: targetMonth, start, nextStart } = monthDateRange(month || currentMonthIso());

    const paymentsRow = this.store.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM payments
       WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`,
      [start, nextStart],
    );
    const paymentsCents = Number(paymentsRow?.total_cents ?? 0);

    const salesRow = this.store.get(
      `SELECT COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales
       WHERE sold_at >= ? AND sold_at < ?`,
      [start, nextStart],
    );
    const salesCents = Number(salesRow?.total_cents ?? 0);

    const expenseRows = this.store.all(
      `SELECT
         category,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid_cents,
         COALESCE(SUM(CASE WHEN status != 'paid' THEN amount_cents ELSE 0 END), 0) AS pending_cents,
         COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM expenses
       WHERE due_date >= ? AND due_date < ?
       GROUP BY category
       ORDER BY total_cents DESC, category ASC`,
      [start, nextStart],
    );

    let totalPaidExpensesCents = 0;
    let totalPendingExpensesCents = 0;
    const expensesByCategory = expenseRows.map((row) => {
      const paidCents = Number(row.paid_cents ?? 0);
      const pendingCents = Number(row.pending_cents ?? 0);
      totalPaidExpensesCents += paidCents;
      totalPendingExpensesCents += pendingCents;
      return {
        category: row.category,
        paid_cents: paidCents,
        pending_cents: pendingCents,
        total_cents: Number(row.total_cents ?? 0),
      };
    });

    const commissionsRow = this.store.get(
      `SELECT COALESCE(SUM(amount_cents), 0) AS paid_cents
       FROM commissions
       WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?`,
      [start, nextStart],
    );
    const paidCommissionsCents = Number(commissionsRow?.paid_cents ?? 0);

    const totalRevenueCents = paymentsCents + salesCents;
    const paidWithCommissionsCents = totalPaidExpensesCents + paidCommissionsCents;
    const totalExpensesCents = paidWithCommissionsCents + totalPendingExpensesCents;

    return {
      month: targetMonth,
      revenues: {
        payments_cents: paymentsCents,
        sales_cents: salesCents,
        pos_sales_cents: salesCents,
        total_cents: totalRevenueCents,
      },
      expenses: {
        paid_cents: paidWithCommissionsCents,
        pending_cents: totalPendingExpensesCents,
        commissions_paid_cents: paidCommissionsCents,
        total_cents: totalExpensesCents,
        by_category: expensesByCategory,
      },
      net_profit_cents: totalRevenueCents - paidWithCommissionsCents,
      projected_net_profit_cents: totalRevenueCents - totalExpensesCents,
    };
  }

  listCommissions({ staffId, status } = {}) {
    const clauses = [];
    const params = [];

    if (staffId != null && staffId !== '') {
      clauses.push('staff_id = ?');
      params.push(Number(staffId));
    }
    if (status) {
      clauses.push('status = ?');
      params.push(String(status).trim());
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.store.all(
      `SELECT * FROM commissions ${where} ORDER BY created_at DESC, id DESC`,
      params,
    );
  }

  createCommission({
    staff_id = null,
    staff_name,
    source_type,
    source_id = null,
    description = null,
    amount_cents,
  }) {
    const cleanStaffName = String(staff_name || '').trim();
    if (!cleanStaffName) {
      throw httpError('Nome do colaborador é obrigatório.');
    }

    const cleanSourceType = String(source_type || '').trim();
    if (!cleanSourceType) {
      throw httpError('Tipo de origem da comissão é obrigatório.');
    }

    const amount = Number(amount_cents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw httpError('Valor da comissão deve ser um inteiro positivo em centavos.');
    }

    const parsedStaffId = staff_id != null && staff_id !== '' ? Number(staff_id) : null;
    const parsedSourceId = source_id != null && source_id !== '' ? Number(source_id) : null;
    const cleanDescription =
      description != null && String(description).trim() ? String(description).trim() : null;

    const res = this.store.run(
      `INSERT INTO commissions (staff_id, staff_name, source_type, source_id, description, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [parsedStaffId, cleanStaffName, cleanSourceType, parsedSourceId, cleanDescription, amount],
    );
    return this.store.get('SELECT * FROM commissions WHERE id = ?', [res.lastInsertRowid]);
  }

  markCommissionPaid(id) {
    const existing = this.store.get('SELECT * FROM commissions WHERE id = ?', [id]);
    if (!existing) {
      throw httpError('Comissão não encontrada.', 404);
    }

    this.store.transaction(() => {
      this.store.run(
        `UPDATE commissions
         SET status = 'paid',
             paid_at = COALESCE(paid_at, datetime('now', 'localtime'))
         WHERE id = ?`,
        [id],
      );

      if (existing.status !== 'paid') {
        const openCash = this.store.get("SELECT id FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1");
        if (openCash) {
          const desc = existing.description
            ? `Comissão: ${existing.staff_name} (${existing.description})`
            : `Comissão: ${existing.staff_name}`;
          this.store.run(
            'INSERT INTO cash_movements (session_id, type, amount_cents, method, description) VALUES (?, ?, ?, ?, ?)',
            [openCash.id, 'out', existing.amount_cents, 'cash', desc],
          );
        }
      }
    });
    return this.store.get('SELECT * FROM commissions WHERE id = ?', [id]);
  }

  runAutoCollection(whatsappService, now = new Date()) {
    if (!whatsappService || typeof whatsappService.enqueueMessage !== 'function') {
      throw httpError('Serviço de WhatsApp indisponível.', 503);
    }

    const todayIso = localDateIso(0, now);
    const minOverdueIso = localDateIso(-5, now);
    const maxDueSoonIso = localDateIso(3, now);
    const gymName = this.store.getSettings().gym_name || 'Academia Oxigênio';

    const candidates = this.store.all(
      `SELECT m.id, m.name, m.phone, m.status, m.valid_until,
              p.name AS plan_name, p.price_cents AS plan_price_cents
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       WHERE m.status IN ('active', 'overdue', 'blocked')
         AND COALESCE(m.is_visitor, 0) = 0
         AND m.phone IS NOT NULL
         AND TRIM(m.phone) != ''
         AND m.valid_until IS NOT NULL
         AND m.valid_until >= ?
         AND m.valid_until <= ?
       ORDER BY m.valid_until ASC, m.id ASC`,
      [minOverdueIso, maxDueSoonIso],
    );

    let queued = 0;
    let skipped = 0;

    this.store.transaction(() => {
      for (const member of candidates) {
        const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
        const dueBr = formatDateBr(member.valid_until);
        const planLabel = member.plan_name ? ` (${member.plan_name})` : '';
        const priceLabel = member.plan_price_cents ? ` no valor de ${formatMoneyBr(member.plan_price_cents)}` : '';
        const isOverdue = String(member.valid_until) < todayIso;

        const message = isOverdue
          ? `Olá ${firstName}! Notamos que sua mensalidade${planLabel}${priceLabel} na ${gymName} venceu em ${dueBr}. Regularize seu pagamento para manter seu acesso liberado.`
          : `Olá ${firstName}! Lembrete: sua mensalidade${planLabel}${priceLabel} na ${gymName} vence em ${dueBr}. Qualquer dúvida estamos à disposição!`;

        const row = whatsappService.enqueueMessage({
          memberId: member.id,
          phone: member.phone,
          kind: 'auto_collection',
          refKey: `auto_collection:${todayIso}`,
          message,
        });

        if (row) {
          queued += 1;
        } else {
          skipped += 1;
        }
      }
    });

    if (queued > 0 && typeof whatsappService.processQueue === 'function') {
      Promise.resolve(whatsappService.processQueue()).catch(() => {});
    }

    return {
      total: candidates.length,
      queued,
      skipped,
      date: todayIso,
    };
  }
}
