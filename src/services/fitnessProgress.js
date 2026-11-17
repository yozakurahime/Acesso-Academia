const gymDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });

export function fitnessToday() {
  return gymDate.format(new Date());
}

function addDays(date, days) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function weekStart(date) {
  return addDays(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));
}

function hasFourWeekStreak(store, memberId, date, goal) {
  const qualifyingWeeks = store.all(`SELECT date(substr(l.occurred_at, 1, 10), 'weekday 0', '-6 days') AS week
    FROM access_logs l WHERE l.member_id = ? AND ${VISIT_FILTER} AND l.occurred_at < ?
    GROUP BY week HAVING COUNT(DISTINCT substr(l.occurred_at, 1, 10)) >= ? ORDER BY week`,
  [memberId, addDays(date, 1), goal]);
  return qualifyingWeeks.some(({ week }, i) => i >= 3 && qualifyingWeeks[i - 3].week === addDays(week, -21));
}

// Only a successful FaceID entry counts. Imported and manual events do not represent confirmed visits.
const VISIT_FILTER = "l.event_code = 7 AND l.event_label = 'Acesso autorizado (FaceID)'";

export function weeklyVisits(store, memberId, date = fitnessToday()) {
  return store.all(`SELECT DISTINCT substr(occurred_at, 1, 10) AS day FROM access_logs l
    WHERE member_id = ? AND ${VISIT_FILTER} AND occurred_at >= ? AND occurred_at < ? ORDER BY 1`,
  [memberId, weekStart(date), addDays(date, 1)]).map((row) => row.day);
}

export function weeklyGoal(store, memberId) {
  return store.get('SELECT weekly_goal FROM student_fitness_preferences WHERE member_id = ?', [memberId])?.weekly_goal ?? 3;
}

export function fitnessRanking(store, date = fitnessToday(), limit = 10) {
  return store.all(`SELECT f.ranking_alias AS alias, COUNT(DISTINCT substr(l.occurred_at, 1, 10)) AS visits
    FROM student_fitness_preferences f JOIN members m ON m.id = f.member_id
    JOIN access_logs l ON l.member_id = f.member_id
    WHERE f.ranking_alias IS NOT NULL AND m.access_role = 'student' AND m.status = 'active'
      AND ${VISIT_FILTER} AND l.occurred_at >= ? AND l.occurred_at < ?
    GROUP BY f.member_id ORDER BY visits DESC, f.ranking_alias COLLATE NOCASE, f.member_id LIMIT ?`,
  [weekStart(date), addDays(date, 1), limit]);
}

function shortRankingName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Aluno';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

export function consecutiveDaysRanking(store, date = fitnessToday(), limit = 5) {
  const lookbackStart = addDays(date, -90);
  const nextDay = addDays(date, 1);
  const rows = store.all(
    `SELECT m.id AS member_id, m.name AS member_name, f.ranking_alias AS ranking_alias,
            substr(l.occurred_at, 1, 10) AS visit_day
     FROM access_logs l
     JOIN members m ON m.id = l.member_id
     LEFT JOIN student_fitness_preferences f ON f.member_id = m.id
     WHERE m.access_role = 'student' AND m.status = 'active'
       AND ${VISIT_FILTER}
       AND l.occurred_at >= ? AND l.occurred_at < ?
     GROUP BY m.id, visit_day
     ORDER BY m.id ASC, visit_day DESC`,
    [lookbackStart, nextDay],
  );

  const byMember = new Map();
  for (const row of rows) {
    let entry = byMember.get(row.member_id);
    if (!entry) {
      entry = {
        memberId: row.member_id,
        alias: (row.ranking_alias && String(row.ranking_alias).trim()) || shortRankingName(row.member_name),
        days: new Set(),
      };
      byMember.set(row.member_id, entry);
    }
    if (row.visit_day) entry.days.add(row.visit_day);
  }

  const yesterday = addDays(date, -1);
  const ranked = [];
  for (const entry of byMember.values()) {
    let cursor = entry.days.has(date) ? date : (entry.days.has(yesterday) ? yesterday : null);
    if (!cursor) continue;
    let streak = 0;
    while (entry.days.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    if (streak > 0) {
      ranked.push({
        memberId: entry.memberId,
        alias: entry.alias,
        streak,
        totalVisits: entry.days.size,
      });
    }
  }

  ranked.sort((a, b) =>
    b.streak - a.streak ||
    b.totalVisits - a.totalVisits ||
    a.alias.localeCompare(b.alias, 'pt-BR', { sensitivity: 'base' }) ||
    a.memberId - b.memberId,
  );

  return ranked.slice(0, limit);
}

export function monthlyFitnessChallenge(store, date = fitnessToday()) {
  const completed = store.get('SELECT COUNT(DISTINCT member_id || \':\' || completed_on) AS count FROM student_workout_completions WHERE completed_on BETWEEN ? AND ?',
    [date.slice(0, 7) + '-01', date]).count;
  return { completed, target: 500 };
}

export function receptionFitnessSummary(store, date = fitnessToday()) {
  const start = weekStart(date);
  const nearGoal = store.all(`SELECT m.id, m.name, COUNT(DISTINCT substr(l.occurred_at, 1, 10)) AS visits,
      COALESCE(f.weekly_goal, 3) AS goal
    FROM access_logs l JOIN members m ON m.id = l.member_id
    LEFT JOIN student_fitness_preferences f ON f.member_id = m.id
    WHERE m.access_role = 'student' AND m.status = 'active' AND ${VISIT_FILTER} AND l.occurred_at >= ? AND l.occurred_at < ?
    GROUP BY m.id HAVING visits = goal - 1 ORDER BY m.name, m.id LIMIT 8`, [start, addDays(date, 1)]);
  const returning = store.all(`SELECT m.id, m.name FROM access_logs l JOIN members m ON m.id = l.member_id
    WHERE m.access_role = 'student' AND ${VISIT_FILTER} AND l.occurred_at >= ? AND l.occurred_at < ?
    GROUP BY m.id HAVING substr((
      SELECT MAX(l2.occurred_at) FROM access_logs l2 WHERE l2.member_id = m.id
        AND ${VISIT_FILTER.replaceAll('l.', 'l2.')} AND l2.occurred_at < ?
    ), 1, 10) <= ? ORDER BY m.name, m.id LIMIT 8`, [date, addDays(date, 1), date, addDays(date, -14)]);
  return { nearGoal, returning };
}

export function studentFitnessProgress(store, memberId, date = fitnessToday()) {
  const start = weekStart(date);
  const goal = weeklyGoal(store, memberId);
  const visits = weeklyVisits(store, memberId, date);
  const completed = store.all('SELECT workout_id, completed_on FROM student_workout_completions WHERE member_id = ? AND completed_on BETWEEN ? AND ?',
    [memberId, start, date]);
  const firstWorkout = store.get('SELECT 1 FROM student_workout_completions WHERE member_id = ? LIMIT 1', [memberId]);
  return {
    date, start, end: addDays(start, 6), goal, visits,
    alias: store.get('SELECT ranking_alias FROM student_fitness_preferences WHERE member_id = ?', [memberId])?.ranking_alias ?? '',
    workoutsThisWeek: completed.length,
    completedToday: completed.filter((row) => row.completed_on === date).map((row) => row.workout_id),
    achievements: [
      { name: 'Primeiro treino', description: 'Conclua um treino no portal.', earned: Boolean(firstWorkout) },
      { name: 'Meta da semana', description: 'Alcance sua meta de visitas nesta semana.', earned: visits.length >= goal },
      { name: 'Quatro semanas de consistência', description: 'Cumpra sua meta em quatro semanas seguidas.', earned: hasFourWeekStreak(store, memberId, date, goal) },
    ],
    ranking: fitnessRanking(store, date),
    challenge: monthlyFitnessChallenge(store, date),
  };
}

export function saveFitnessPreferences(store, memberId, { goal, alias } = {}) {
  if (!store.get("SELECT id FROM members WHERE id = ? AND access_role = 'student'", [memberId])) throw new Error('Aluno não encontrado.');
  if (goal !== undefined && (!Number.isInteger(goal) || goal < 1 || goal > 7)) throw new Error('Escolha uma meta de 1 a 7 visitas.');
  if (alias !== undefined && (typeof alias !== 'string' || alias.trim().length > 24 || /[\p{C}]/u.test(alias))) {
    throw new Error('Informe um apelido de até 24 caracteres.');
  }
  store.run(`INSERT INTO student_fitness_preferences (member_id, weekly_goal, ranking_alias) VALUES (?, ?, ?)
    ON CONFLICT(member_id) DO UPDATE SET
      weekly_goal = CASE WHEN ? THEN excluded.weekly_goal ELSE weekly_goal END,
      ranking_alias = CASE WHEN ? THEN excluded.ranking_alias ELSE ranking_alias END`,
  [memberId, goal ?? 3, alias?.trim() || null, Number(goal !== undefined), Number(alias !== undefined)]);
}

export function completeFitnessWorkout(store, memberId, workoutId, date = fitnessToday()) {
  const workout = store.get(`SELECT w.id FROM workouts w JOIN members m ON m.id = w.member_id
    WHERE w.id = ? AND w.member_id = ? AND w.active = 1 AND m.access_role = 'student'
      AND EXISTS (SELECT 1 FROM workout_exercises e WHERE e.workout_id = w.id)`, [workoutId, memberId]);
  if (!workout) throw new Error('Treino não encontrado ou sem exercícios.');
  return store.run('INSERT OR IGNORE INTO student_workout_completions (member_id, workout_id, completed_on) VALUES (?, ?, ?)',
    [memberId, workout.id, date]).changes === 1;
}
