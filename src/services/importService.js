import { matchesDeviceIdentity } from './controlIdClient.js';

const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

export function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&(nbsp|amp|lt|gt|quot);|&#39;/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCell(raw) {
  const val = decodeHtml(raw.replace(/<[^>]*>/g, ''));
  if (!val || val === '- - -' || val === '--' || val === '-') return '';
  return val;
}

function parseBrDate(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((str || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function periodToDays(period) {
  const p = (period || '').toLowerCase();
  if (p.includes('bimestral')) return 60;
  if (p.includes('trimestral')) return 90;
  if (p.includes('semestral')) return 180;
  if (p.includes('anual')) return 365;
  return 30;
}

function addDaysIso(isoDate, days) {
  const dt = new Date(`${isoDate}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function parseBrlToCents(str) {
  const clean = (str || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const num = Number(clean);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

/**
 * Extrai todas as tabelas HTML de um arquivo exportado do SCA.
 */
export function parseHtmlTables(html) {
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const captionMatch = /<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(tableHtml);
    const caption = captionMatch ? cleanCell(captionMatch[1]) : '';

    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cells = [];
      const cellRegex = /<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        cells.push(cleanCell(cellMatch[2]));
      }
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length > 1) {
      tables.push({ caption, headers: rows[0], rows: rows.slice(1) });
    }
  }

  return tables;
}

function localTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ImportService {
  constructor(store, controlId) {
    this.store = store;
    this.controlId = controlId;
  }

  importScaHtml(html, options = {}) {
    const tables = parseHtmlTables(html);
    if (tables.length === 0) {
      throw new Error('Nenhuma tabela valida encontrada no arquivo HTML/XLS do SCA.');
    }

    const preview = Symbol('preview');
    let result;
    try {
      return this.store.transaction(() => {
      const summary = {
        membersImported: 0,
        membersSkipped: 0,
        staffImported: 0,
        instructorsImported: 0,
        enrollmentsUpdated: 0,
        plansCreated: 0,
        modalitiesCreated: 0,
        classesImported: 0,
        chargesUpdated: 0,
        activatedMembers: 0,
        receiptsImported: 0,
        conflicts: 0,
      };

      for (const table of tables) {
        const headers = table.headers;
        const isStudents = headers.includes('CPF') || table.caption.includes('Alunos');
        const isStaff = headers.includes('Administrador') || table.caption.includes('Usuários');
        const isInstructors = headers.includes('Codigo-do-Professor') || table.caption.includes('Professores');
        const isEnrollments =
          (headers.includes('Plano') && headers.includes('Inicio')) || table.caption.includes('Matrículas');
        const isClasses =
          (headers.includes('Codigo-da-Turma') && headers.includes('Turma')) || table.caption.includes('Turmas');
        const isReceipts =
          (headers.includes('Pagamento') && headers.includes('Valor-Pago')) ||
          table.caption.includes('Recebimentos');
        const isCharges =
          !isReceipts &&
          ((headers.includes('Vencimento') && headers.includes('Nome-ou-Razao-Social')) ||
            table.caption.includes('Cobranças'));

        if (isStudents) {
          this.importStudentsTable(headers, table.rows, summary, options);
        } else if (isStaff) {
          this.importStaffTable(headers, table.rows, summary);
        } else if (isInstructors) {
          this.importInstructorsTable(headers, table.rows, summary);
        } else if (isEnrollments) {
          this.importEnrollmentsTable(headers, table.rows, summary);
        } else if (isClasses) {
          this.importClassesTable(headers, table.rows, summary);
        } else if (isReceipts) {
          this.importReceiptsTable(headers, table.rows, summary);
        } else if (isCharges) {
          this.importChargesTable(headers, table.rows, summary);
        }
      }

        if (options.preview) {
          result = summary;
          throw preview;
        }
        return summary;
      });
    } catch (err) {
      if (err === preview) return { ...result, preview: true };
      throw err;
    }
  }

  importStudentsTable(headers, rows, summary, options = {}) {
    const idx = (name) => headers.indexOf(name);
    const iName = idx('Nome-Completo');
    const iEmail = idx('E-mail');
    const iTel1 = idx('Telefone-1');
    const iTel2 = idx('Telefone-2');
    const iEnd = idx('Endereco');
    const iNum = idx('Numero');
    const iComp = idx('Complemento');
    const iBairro = idx('Bairro');
    const iCidade = idx('Cidade');
    const iEstado = idx('Estado');
    const iCpf = idx('CPF');

    const today = localTodayIso();
    const markActive = Boolean(options.markStudentsActive || options.exclusiveActiveList);
    const activeIds = new Set();

    const rollForwardValidUntil = (currentValidUntil, durationDays) => {
      const step = Math.max(Number(durationDays) || 30, 1);
      let candidate = currentValidUntil || addDaysIso(today, step);
      let guard = 0;
      while (candidate < today && guard < 120) {
        candidate = addDaysIso(candidate, step);
        guard += 1;
      }
      return candidate >= today ? candidate : addDaysIso(today, step);
    };

    for (const row of rows) {
      const name = row[iName] || '';
      if (!name || /^(erro|teste|teste1|apagar|excluir|ffff|hmghgj|j,hbalbvavjds|jhmhgcdkh|wethteyj|rtete|fulano)$/i.test(name)) {
        summary.membersSkipped += 1;
        continue;
      }

      const cpf = iCpf >= 0 ? row[iCpf] : '';
      const phone = (iTel1 >= 0 && row[iTel1]) || (iTel2 >= 0 && row[iTel2]) || '';
      const email = iEmail >= 0 ? row[iEmail] : '';

      const addressParts = [
        iEnd >= 0 ? row[iEnd] : '',
        iNum >= 0 ? row[iNum] : '',
        iComp >= 0 ? row[iComp] : '',
        iBairro >= 0 ? row[iBairro] : '',
        iCidade >= 0 ? row[iCidade] : '',
        iEstado >= 0 ? row[iEstado] : '',
      ].filter((p) => p && !['Any', 'S.N', 'N', 'Sn', 'Na'].includes(p));
      const address = addressParts.join(', ');

      const candidates = cpf
        ? this.store.all("SELECT id, status, valid_until, plan_id FROM members WHERE access_role = 'student' AND document = ?", [cpf])
        : this.store.all("SELECT id, status, valid_until, plan_id FROM members WHERE access_role = 'student' AND lower(name) = lower(?)", [name]);
      if (candidates.length > 1) {
        summary.conflicts += 1;
        summary.membersSkipped += 1;
        continue;
      }
      const existing = candidates[0];

      if (existing) {
        activeIds.add(existing.id);
        if (markActive) {
          const plan = existing.plan_id
            ? this.store.get('SELECT duration_days FROM plans WHERE id = ?', [existing.plan_id])
            : null;
          const nextValidUntil =
            existing.valid_until && existing.valid_until >= today
              ? existing.valid_until
              : rollForwardValidUntil(existing.valid_until, plan?.duration_days || 30);
          if (existing.status !== 'active' || existing.valid_until !== nextValidUntil) {
            this.store.run(
              `UPDATE members SET status = 'active', valid_until = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
              [nextValidUntil, existing.id],
            );
            summary.activatedMembers += 1;
          }
        }
        summary.membersSkipped += 1;
        continue;
      }

      const initialStatus = markActive ? 'active' : 'pending';
      const initialValidUntil = markActive ? addDaysIso(today, 30) : null;
      const res = this.store.run(
        `INSERT INTO members (name, document, phone, email, address, status, valid_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, cpf || null, phone || null, email || null, address || null, initialStatus, initialValidUntil],
      );
      activeIds.add(res.lastInsertRowid);
      if (markActive) summary.activatedMembers += 1;
      summary.membersImported += 1;
    }

    if (options.exclusiveActiveList && activeIds.size > 0) {
      const currentActive = this.store.all(`SELECT id FROM members WHERE status = 'active' AND access_role = 'student'`);
      for (const m of currentActive) {
        if (!activeIds.has(m.id)) {
          this.store.run(
            `UPDATE members SET status = 'blocked', updated_at = datetime('now', 'localtime') WHERE id = ?`,
            [m.id],
          );
        }
      }
    }
  }

  importStaffTable(headers, rows, summary) {
    const iName = headers.indexOf('Nome-Completo');
    const iTel = headers.indexOf('Telefone-1');
    const iAdmin = headers.indexOf('Administrador');

    for (const row of rows) {
      const name = row[iName] || '';
      if (!name) continue;
      const existing = this.store.get('SELECT id FROM staff WHERE lower(name) = lower(?)', [name]);
      if (existing) continue;

      const role = row[iAdmin] === 'Sim' ? 'Administrador' : 'Atendente';
      this.store.run('INSERT INTO staff (name, role, phone) VALUES (?, ?, ?)', [
        name,
        role,
        (iTel >= 0 && row[iTel]) || null,
      ]);
      summary.staffImported += 1;
    }
  }

  importInstructorsTable(headers, rows, summary) {
    const iName = headers.indexOf('Nome-Completo');
    const iTel = headers.indexOf('Telefone-1-ou-2');

    for (const row of rows) {
      const name = row[iName] || '';
      if (!name) continue;
      const existing = this.store.get('SELECT id FROM instructors WHERE lower(name) = lower(?)', [name]);
      if (existing) continue;

      this.store.run('INSERT INTO instructors (name, phone, specialty) VALUES (?, ?, ?)', [
        name,
        (iTel >= 0 && row[iTel]) || null,
        'Musculação',
      ]);
      summary.instructorsImported += 1;
    }
  }

  importEnrollmentsTable(headers, rows, summary) {
    const iName = headers.indexOf('Nome-Completo');
    const iPlan = headers.indexOf('Plano');
    const iPeriod = headers.indexOf('Periodicidade');
    const iStart = headers.indexOf('Inicio');
    const iEnd = headers.indexOf('Fim');
    const iPrice = headers.indexOf('Valor-Cobranca') >= 0 ? headers.indexOf('Valor-Cobranca') : headers.indexOf('Valor');
    const today = localTodayIso();

    for (const row of rows) {
      const name = (row[iName] || '').trim();
      if (!name || /^(erro|teste|teste1|apagar|excluir|exemplo|rtete|academia)$/i.test(name)) {
        continue;
      }

      const rawPlanName = ((iPlan >= 0 ? row[iPlan] : '') || 'Musculação').trim();
      const period = ((iPeriod >= 0 ? row[iPeriod] : '') || 'Mensal').trim();
      const durationDays = periodToDays(period);
      const priceCents = iPrice >= 0 ? parseBrlToCents(row[iPrice]) : 0;

      const startIso = iStart >= 0 ? parseBrDate(row[iStart]) : null;
      const endIso = iEnd >= 0 ? parseBrDate(row[iEnd]) : null;
      const validUntil = endIso || (startIso ? addDaysIso(startIso, durationDays) : null);
      if (!validUntil) continue;

      // Extrai a modalidade base (ex: "Musculação Completo" -> "Musculação", combos mantem nome ou primeira modalidade)
      const modParts = rawPlanName.split('+').map((p) => p.trim()).filter(Boolean);
      let primaryModalityId = null;
      for (const part of modParts) {
        const modName = part.replace(/\s+Completo$/i, '').trim() || part;
        let mod = this.store.get('SELECT id FROM modalities WHERE lower(name) = lower(?)', [modName]);
        if (!mod) {
          const modRes = this.store.run('INSERT INTO modalities (name, description) VALUES (?, ?)', [
            modName,
            `Modalidade ${modName}`,
          ]);
          mod = { id: modRes.lastInsertRowid };
          summary.modalitiesCreated += 1;
        }
        if (!primaryModalityId) primaryModalityId = mod.id;
      }

      const fullPlanName = `${rawPlanName} (${period})`;
      let plan = this.store.get('SELECT id FROM plans WHERE lower(name) = lower(?)', [fullPlanName]);
      if (!plan) {
        const pRes = this.store.run(
          'INSERT INTO plans (name, duration_days, price_cents) VALUES (?, ?, ?)',
          [fullPlanName, durationDays, priceCents || 10000],
        );
        plan = { id: pRes.lastInsertRowid };
        summary.plansCreated += 1;
      }

      const candidates = this.store.all("SELECT id, valid_until FROM members WHERE access_role = 'student' AND lower(name) = lower(?)", [name]);
      if (candidates.length > 1) { summary.conflicts += 1; continue; }
      const member = candidates[0];
      if (!member) {
        const status = validUntil >= today ? 'active' : 'blocked';
        const mRes = this.store.run(
          `INSERT INTO members (name, modality_id, plan_id, valid_until, status) VALUES (?, ?, ?, ?, ?)`,
          [name, primaryModalityId, plan.id, validUntil, status],
        );
        summary.membersImported += 1;
        summary.enrollmentsUpdated += 1;
        continue;
      }

      if (!member.valid_until || validUntil >= member.valid_until) {
        const status = validUntil >= today ? 'active' : 'blocked';
        this.store.run(
          `UPDATE members SET modality_id = ?, plan_id = ?, valid_until = ?, status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
          [primaryModalityId, plan.id, validUntil, status, member.id],
        );
        summary.enrollmentsUpdated += 1;
      }
    }
  }

  importClassesTable(headers, rows, summary) {
    const iName = headers.indexOf('Turma');
    const iCap = headers.indexOf('Lotacao');
    const iSit = headers.indexOf('Situacao');

    for (const row of rows) {
      const fullName = (row[iName] || '').trim();
      if (!fullName) continue;

      const existing = this.store.get('SELECT id FROM classes WHERE lower(name) = lower(?)', [fullName]);
      if (existing) continue;

      const capacity = iCap >= 0 ? Number(row[iCap]) || 0 : 20;
      const active = iSit >= 0 && row[iSit] && row[iSit] !== 'A' ? 0 : 1;

      // Extrai professor apos " - " (ex: "Pilates Seg/Qua/Sex 18:00 - Bruce/Gustavo")
      let instructorId = null;
      const dashParts = fullName.split(' - ');
      const mainPart = dashParts[0].trim();
      if (dashParts.length > 1) {
        const firstProf = dashParts[1].split('/')[0].trim();
        if (firstProf) {
          const inst = this.store.get('SELECT id FROM instructors WHERE lower(name) LIKE lower(?)', [
            `%${firstProf}%`,
          ]);
          if (inst) instructorId = inst.id;
        }
      }

      // Separa modalidade do horario (ex: "Hidroginástica Seg/Qua/Sex 08:00")
      const schedMatch = /\b(Seg|Ter|Qua|Qui|Sex|S[áa]b|Dom)\b/i.exec(mainPart);
      const modName = schedMatch ? mainPart.slice(0, schedMatch.index).trim() : mainPart;
      const schedule = schedMatch ? mainPart.slice(schedMatch.index).trim() : 'Horário livre';

      let modalityId = null;
      if (modName) {
        let mod = this.store.get('SELECT id FROM modalities WHERE lower(name) = lower(?)', [modName]);
        if (!mod) {
          const modRes = this.store.run('INSERT INTO modalities (name, description) VALUES (?, ?)', [
            modName,
            `Modalidade ${modName}`,
          ]);
          mod = { id: modRes.lastInsertRowid };
          summary.modalitiesCreated += 1;
        }
        modalityId = mod.id;
      }

      this.store.run(
        'INSERT INTO classes (name, modality_id, instructor_id, schedule, capacity, active) VALUES (?, ?, ?, ?, ?, ?)',
        [fullName, modalityId, instructorId, schedule, capacity, active],
      );
      summary.classesImported += 1;
    }
  }

  importChargesTable(headers, rows, summary) {
    const iName = headers.indexOf('Nome-ou-Razao-Social');
    const iDue = headers.indexOf('Vencimento');
    if (iName < 0 || iDue < 0) return;

    const iAmount = headers.indexOf('Valor');
    const iCpf = headers.indexOf('CPF-ou-CNPJ');
    const iStatus = headers.indexOf('Situacao');

    const students = this.store.all("SELECT id, name, document FROM members WHERE access_role = 'student'");
    const byCpf = new Map();
    const byName = new Map();
    for (const s of students) {
      const docDigits = String(s.document || '').replace(/\D/g, '');
      if (docDigits) {
        if (!byCpf.has(docDigits)) byCpf.set(docDigits, []);
        byCpf.get(docDigits).push(s);
      }
      const nameKey = String(s.name || '').trim().toLowerCase();
      if (nameKey) {
        if (!byName.has(nameKey)) byName.set(nameKey, []);
        byName.get(nameKey).push(s);
      }
    }

    for (const row of rows) {
      const name = (row[iName] || '').trim();
      const dueIso = parseBrDate(row[iDue]);
      const amount = parseBrlToCents(row[iAmount]);
      if (!name || !dueIso || !Number.isSafeInteger(amount) || amount <= 0) continue;
      if (iStatus >= 0 && !/^(abert[oa]|em aberto|vencid[oa]|pendente|a vencer|atrasad[oa]|em atraso|inadimplente)$/i.test((row[iStatus] || '').trim())) {
        summary.conflicts += 1;
        continue;
      }
      const cpf = iCpf >= 0 ? String(row[iCpf] || '').replace(/\D/g, '') : '';
      let candidates = cpf ? (byCpf.get(cpf) || []) : [];
      if (candidates.length === 0) {
        candidates = byName.get(name.toLowerCase()) || [];
      }
      if (candidates.length !== 1) { summary.conflicts += 1; continue; }
      const memberId = candidates[0].id;
      const inserted = this.store.run(
        "INSERT OR IGNORE INTO membership_charges (member_id, due, amount, source) VALUES (?, ?, ?, 'import')",
        [memberId, dueIso, amount],
      );
      if (inserted.changes === 0) {
        this.store.run(
          "UPDATE membership_charges SET source = 'import' WHERE member_id = ? AND due = ? AND payment_id IS NULL",
          [memberId, dueIso],
        );
      }
      summary.chargesUpdated += inserted.changes;
    }
  }

  importReceiptsTable(headers, rows, summary) {
    const iName = headers.indexOf('Nome-ou-Razao-Social');
    const iCpf = headers.indexOf('CPF-ou-CNPJ');
    const iDue = headers.indexOf('Vencimento');
    const iPaidAt = headers.indexOf('Pagamento');
    const iPaidAmount = headers.indexOf('Valor-Pago');
    if (iName < 0 || iPaidAt < 0 || iPaidAmount < 0) return;

    const today = localTodayIso();
    const normName = (s) =>
      String(s ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    const allMembers = this.store.all("SELECT id, name, document, plan_id, status, valid_until FROM members WHERE access_role = 'student'");
    const byName = new Map();
    const byCpf = new Map();
    for (const m of allMembers) {
      const k = normName(m.name);
      if (k) byName.set(k, byName.has(k) ? null : m);
      const docDigits = String(m.document || '').replace(/\D/g, '');
      if (docDigits) byCpf.set(docDigits, byCpf.has(docDigits) ? null : m);
    }

    for (const row of rows) {
      const name = (row[iName] || '').trim();
      if (!name || /^cadastro exclu[ií]do$/i.test(name)) continue;

      const paidIso = parseBrDate(row[iPaidAt]);
      const dueIso = iDue >= 0 ? parseBrDate(row[iDue]) : null;
      const amountCents = parseBrlToCents(row[iPaidAmount]);
      if (!paidIso || amountCents <= 0) continue;

      const cpfDigits = iCpf >= 0 ? String(row[iCpf] || '').replace(/\D/g, '') : '';
      const member = cpfDigits ? byCpf.get(cpfDigits) : byName.get(normName(name));
      if (!member) { summary.conflicts += 1; continue; }

      const paidTimestamp = `${paidIso} 12:00:00`;
      const existingPay = this.store.get(
        'SELECT id FROM payments WHERE member_id = ? AND amount_cents = ? AND substr(paid_at, 1, 10) = ?',
        [member.id, amountCents, paidIso],
      );
      if (!existingPay) {
        const payment = this.store.run(
          'INSERT INTO payments (member_id, plan_id, amount_cents, method, paid_at) VALUES (?, ?, ?, ?, ?)',
          [member.id, member.plan_id || null, amountCents, 'sca', paidTimestamp],
        );
        if (dueIso) this.store.run(`UPDATE membership_charges SET payment_id = ?
          WHERE member_id = ? AND due = ? AND amount = ? AND payment_id IS NULL`,
        [payment.lastInsertRowid, member.id, dueIso, amountCents]);
        summary.receiptsImported += 1;
      }

      const plan = member.plan_id
        ? this.store.get('SELECT id, duration_days FROM plans WHERE id = ?', [member.plan_id])
        : null;
      if (!plan) continue;
      const durationDays = plan.duration_days;
      const nextValidUntil = addDaysIso(dueIso || paidIso, durationDays);

      if (!member.valid_until || nextValidUntil > member.valid_until) {
        const nextStatus = nextValidUntil >= today ? 'active' : member.status;
        this.store.run(
          `UPDATE members SET valid_until = ?, status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
          [nextValidUntil, nextStatus, member.id],
        );
        member.valid_until = nextValidUntil;
        if (nextStatus === 'active' && member.status !== 'active') {
          summary.activatedMembers += 1;
        }
        member.status = nextStatus;

        if (member.plan_id) {
          const enrollment = this.store.get('SELECT member_id FROM plan_enrollments WHERE member_id = ?', [member.id]);
          const startsOn = dueIso || paidIso;
          if (enrollment) {
            this.store.run(
              'UPDATE plan_enrollments SET plan_id = ?, starts_on = ?, ends_on = ? WHERE member_id = ?',
              [member.plan_id, startsOn, nextValidUntil, member.id],
            );
          } else {
            this.store.run(
              'INSERT INTO plan_enrollments (member_id, plan_id, starts_on, ends_on) VALUES (?, ?, ?, ?)',
              [member.id, member.plan_id, startsOn, nextValidUntil],
            );
          }
        }
        summary.enrollmentsUpdated += 1;
      }
    }
  }

  /**
   * Puxa os usuarios ja cadastrados no equipamento Control iD e vincula ao banco local.
   */
  async syncUsersFromControlId() {
    const cfg = this.controlId.getConfig();
    if (cfg.mockMode) {
      return { imported: 0, linked: 0, mock: true, message: 'Modo simulado ativo.' };
    }

    const data = await this.controlId.requestJson('/load_objects.fcgi', { object: 'users' });
    const deviceUsers = data?.users || [];
    let imported = 0;
    let linked = 0;
    let conflicts = 0;

    const normName = (s) =>
      String(s ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    this.store.transaction(() => {
      const allMembers = this.store.all('SELECT id, name, document, controlid_user_id, face_registered FROM members');
      const byName = new Map();
      const byDeviceId = new Map();
      const byDoc = new Map();
      for (const m of allMembers) {
        if (m.controlid_user_id != null) {
          const devKey = Number(m.controlid_user_id);
          if (!byDeviceId.has(devKey)) byDeviceId.set(devKey, []);
          byDeviceId.get(devKey).push(m);
        }
        if (m.document) {
          if (!byDoc.has(m.document)) byDoc.set(m.document, []);
          byDoc.get(m.document).push(m);
        }
        const key = normName(m.name);
        if (!key) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(m);
      }

      for (const u of deviceUsers) {
        const name = (u.name || '').trim();
        const reg = (u.registration || '').trim();
        if (!name && !u.id) continue;

        const current = byDeviceId.get(Number(u.id)) || [];
        for (const row of current) {
          if (!matchesDeviceIdentity(row, u) && !row.face_registered) {
            this.store.run('UPDATE members SET controlid_user_id = NULL WHERE id = ?', [row.id]);
            row.controlid_user_id = null;
          }
        }
        const remainingCurrent = current.filter((row) => row.controlid_user_id !== null);
        if (remainingCurrent.length > 1 || (remainingCurrent.length === 1 && !matchesDeviceIdentity(remainingCurrent[0], u))) {
          conflicts += 1;
          continue;
        }
        let local = remainingCurrent[0];
        if (!local && reg) {
          const matches = byDoc.get(reg) || [];
          if (matches.length > 1 || (matches.length === 1 && !matchesDeviceIdentity(matches[0], u))) { conflicts += 1; continue; }
          local = matches[0];
        }
        if (!local && name) {
          const matches = byName.get(normName(name)) || [];
          if (matches.length > 1 || (matches.length === 1 && !matchesDeviceIdentity(matches[0], u))) { conflicts += 1; continue; }
          local = matches[0];
        }

        if (local) {
          if (local.face_registered && local.controlid_user_id && Number(local.controlid_user_id) !== Number(u.id)) {
            conflicts += 1;
            continue;
          }
          this.store.run(
            'UPDATE members SET controlid_user_id = ?, face_registered = 1, last_sync_error = NULL WHERE id = ?',
            [u.id, local.id],
          );
          local.controlid_user_id = u.id;
          local.face_registered = 1;
          linked += 1;
        } else {
          this.store.run(
            `INSERT INTO members (name, document, controlid_user_id, face_registered, status)
             VALUES (?, ?, ?, 1, 'pending')`,
            [name || `Usuário ${u.id}`, reg || null, u.id],
          );
          imported += 1;
        }
      }
    });

    return { imported, linked, conflicts, totalOnDevice: deviceUsers.length };
  }
}
