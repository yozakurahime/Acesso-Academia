import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { GymService } from '../src/services/gymService.js';
import { AccessService } from '../src/services/accessService.js';
import { AuthService } from '../src/services/authService.js';
import { StudentPortalService } from '../src/services/studentPortalService.js';
import { createApiRouter } from '../src/routes/api.js';
import { fitnessToday, saveFitnessPreferences } from '../src/services/fitnessProgress.js';

const TINY_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

test('StudentPortalService autentica no 1o acesso, troca senha e atualiza foto de perfil sem alterar FaceID', async () => {
  const store = await DatabaseStore.create(null);
  const gymService = new GymService(store);
  const portal = new StudentPortalService(store, gymService);

  const res = store.run(
    "INSERT INTO members (name, document, phone, access_role, controlid_user_id, face_registered) VALUES ('João Silva', '12345678900', '(11) 98888-1234', 'student', 77, 1)",
  );
  const memberId = res.lastInsertRowid;

  const { code } = portal.issueInvite(memberId);
  assert.throws(() => portal.authenticateStudent('11988881234', '1234'), /credencial inválidos/);
  const logged = portal.authenticateStudent('11988881234', code);
  const relogged = portal.authenticateStudent('11988881234', code);
  assert.equal(relogged.id, memberId);
  assert.equal(logged.id, memberId);
  assert.equal(logged.has_portal_password, false);

  // Definir senha própria (convite antigo deixa de valer)
  portal.updatePortalPassword(memberId, { new_password: 'minha-senha' });
  assert.throws(() => portal.authenticateStudent('11988881234', code), /Senha incorreta/);
  assert.throws(() => portal.authenticateStudent('12345678900', '1234'), /Senha incorreta/);
  const loggedWithPass = portal.authenticateStudent('12345678900', 'minha-senha');
  assert.equal(loggedWithPass.has_portal_password, true);

  // Atualizar foto de perfil NÃO altera FaceID (controlid_user_id e face_registered intactos)
  portal.updateProfilePhoto(memberId, TINY_JPEG_DATA_URL);
  const dbMember = store.get('SELECT profile_photo, controlid_user_id, face_registered FROM members WHERE id = ?', [memberId]);
  assert.equal(dbMember.profile_photo, TINY_JPEG_DATA_URL);
  assert.equal(dbMember.controlid_user_id, 77);
  assert.equal(dbMember.face_registered, 1);

  assert.throws(() => portal.updateProfilePhoto(memberId, 'https://evil.example/a.png'), /Formato de imagem inválido/);
});

test('GymService gerencia treinos e exercicios animados do aluno', async () => {
  const store = await DatabaseStore.create(null);
  const gymService = new GymService(store);
  const portal = new StudentPortalService(store, gymService);

  const mRes = store.run("INSERT INTO members (name, phone, access_role) VALUES ('Maria Souza', '11977774321', 'student')");
  const memberId = mRes.lastInsertRowid;
  const inst = gymService.createInstructor({ name: 'Prof. Carlos' });

  const wk = gymService.createWorkout({
    member_id: memberId,
    title: 'Treino A — Superiores',
    goal: 'Hipertrofia',
    instructor_id: inst.id,
    notes: 'Aquecer 5 minutos',
    exercises: [
      { exercise_key: 'supino_reto', exercise_name: 'Supino Reto com Barra', muscle_group: 'Peito', sets: 4, reps: '10', rest_seconds: 90, load_kg: '40kg' },
      { exercise_key: 'triceps_pulley', exercise_name: 'Tríceps Pulley / Corda', muscle_group: 'Tríceps', sets: 3, reps: '12', rest_seconds: 60 },
    ],
  });

  assert.equal(wk.exercises.length, 2);
  assert.equal(wk.instructor_name, 'Prof. Carlos');

  const updated = gymService.updateWorkout(wk.id, {
    title: 'Treino A — Peito e Tríceps',
    exercises: [
      { exercise_key: 'flexao', exercise_name: 'Flexão de Braço', muscle_group: 'Peito', sets: 3, reps: '15', rest_seconds: 45 },
    ],
  });
  assert.equal(updated.title, 'Treino A — Peito e Tríceps');
  assert.equal(updated.exercises.length, 1);
  assert.equal(updated.exercises[0].exercise_key, 'flexao');

  const profile = portal.getStudentProfile(memberId);
  assert.equal(profile.workouts.length, 1);
  assert.equal(profile.workouts[0].exercises[0].exercise_key, 'flexao');

  const del = gymService.deleteWorkout(wk.id);
  assert.deepEqual(del, { deleted: true, id: wk.id });
  assert.equal(gymService.listWorkoutsByMember(memberId).length, 0);
});

test('Rotas /api/student funcionam com sessao propria mesmo com login admin ativo', async () => {
  const store = await DatabaseStore.create(null);
  const gymService = new GymService(store);
  const authService = new AuthService(store);
  const portalService = new StudentPortalService(store, gymService);
  authService.configure({ enabled: true, username: 'admin', password: 'admin-password' });

  const mRes = store.run("INSERT INTO members (name, phone, access_role, status) VALUES ('Pedro Portal', '11966669988', 'student', 'active')");
  const memberId = mRes.lastInsertRowid;
  const workout = gymService.createWorkout({
    member_id: memberId, title: 'Treino A', exercises: [{ exercise_key: 'flexao', exercise_name: 'Flexão' }],
  });
  const today = fitnessToday();
  for (const [code, label, time] of [
    [7, 'Acesso autorizado (FaceID)', '09:00:00'],
    [7, 'Acesso autorizado (FaceID)', '10:00:00'],
    [6, 'Acesso negado (FaceID)', '11:00:00'],
  ]) {
    store.run('INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, ?, ?, ?)',
      [memberId, code, label, today + ' ' + time]);
  }

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, gymService, authService, studentPortalService: portalService }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Sem sessão do aluno -> 401
    const unauth = await fetch(`${baseUrl}/api/student/me`);
    assert.equal(unauth.status, 401);

    // Login do aluno
    const loginRes = await fetch(`${baseUrl}/api/student/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '11966669988', secret: portalService.issueInvite(memberId).code }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    // Acesso autenticado ao perfil do aluno
    const meRes = await fetch(`${baseUrl}/api/student/me`, {
      headers: { cookie },
    });
    assert.equal(meRes.status, 200);
    const me = await meRes.json();
    assert.equal(me.member.id, memberId);
    assert.deepEqual(me.fitness.visits, [today]);
    assert.equal(me.fitness.goal, 3);
    assert.deepEqual(me.fitness.ranking, []);

    const setAlias = async (alias) => fetch(`${baseUrl}/api/student/me/fitness/ranking`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ alias }),
    });
    assert.equal((await setAlias('Peixe')).status, 200);
    const readPodium = async (headers = {}) => fetch(`${baseUrl}/api/turnstile/ranking`, { headers });
    assert.deepEqual(await (await readPodium()).json(), { ranking: [{ alias: 'Peixe', visits: 1 }] });
    assert.equal((await readPodium({ 'x-forwarded-for': '203.0.113.2' })).status, 403);
    assert.equal((await setAlias('')).status, 200);
    assert.deepEqual(await (await readPodium()).json(), { ranking: [] });

    for (const alias of ['Delta', 'Costa', 'Brisa', 'Areia']) {
      const { lastInsertRowid } = store.run("INSERT INTO members (name, status) VALUES (?, 'active')", [alias]);
      saveFitnessPreferences(store, lastInsertRowid, { alias });
      store.run("INSERT INTO access_logs (member_id, event_code, event_label, occurred_at) VALUES (?, 7, 'Acesso autorizado (FaceID)', ?)",
        [lastInsertRowid, today + ' 10:00:00']);
    }
    assert.deepEqual((await (await readPodium()).json()).ranking.map(({ alias }) => alias), ['Areia', 'Brisa', 'Costa']);

    const complete = async () => fetch(`${baseUrl}/api/student/me/workouts/${workout.id}/complete`, {
      method: 'POST', headers: { cookie },
    });
    const result = await (await complete()).json();
    assert.equal(result.created, true);
    assert.deepEqual(result.fitness.completedToday, [workout.id]);
    assert.equal(result.fitness.challenge.completed, 1);
    assert.equal(result.fitness.achievements[0].earned, true);
    const repeated = await (await complete()).json();
    assert.equal(repeated.created, false);
    assert.equal(repeated.fitness.challenge.completed, 1);

    const richRankingRes = await fetch(`${baseUrl}/api/turnstile/ranking?rich=1`);
    assert.equal(richRankingRes.status, 200);
    const richRanking = await richRankingRes.json();
    assert.deepEqual(richRanking.challenge, { completed: 1, target: 500 });
    assert.ok(Array.isArray(richRanking.ranking));
    assert.ok(Array.isArray(richRanking.streakRanking));

    // Atualiza foto de perfil pelo portal
    const photoRes = await fetch(`${baseUrl}/api/student/me/photo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ profile_photo: TINY_JPEG_DATA_URL }),
    });
    assert.equal(photoRes.status, 200);
    const photoJson = await photoRes.json();
    assert.equal(photoJson.profile_photo, TINY_JPEG_DATA_URL);

    // Aluno anota carga pessoal no exercício, ajusta meta semanal e atualiza contatos
    const exId = workout.exercises[0].id;
    const loadRes = await fetch(`${baseUrl}/api/student/me/exercises/${exId}/load`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ load_kg: '52kg' }),
    });
    assert.equal(loadRes.status, 200);
    assert.equal((await loadRes.json()).load_kg, '52kg');

    const goalRes = await fetch(`${baseUrl}/api/student/me/fitness/goal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ goal: 5 }),
    });
    assert.equal(goalRes.status, 200);
    assert.equal((await goalRes.json()).goal, 5);

    const contactRes = await fetch(`${baseUrl}/api/student/me/contact`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ phone: '11966669988', email: 'pedro@academia.com', emergency_contact: 'Ana 11999990000' }),
    });
    assert.equal(contactRes.status, 200);
    assert.equal((await contactRes.json()).member.email, 'pedro@academia.com');

    // Troca de senha invalida token anterior
    const pwdRes = await fetch(`${baseUrl}/api/student/me/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_password: 'nova-senha-segura' }),
    });
    assert.equal(pwdRes.status, 200);
    const staleRes = await fetch(`${baseUrl}/api/student/me`, { headers: { cookie } });
    assert.equal(staleRes.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('online_available filtra planos em /public/plans, /public/enrollment-options, /public/enroll e /api/student/me', async () => {
  const store = await DatabaseStore.create(null);
  const accessService = new AccessService(store);
  const gymService = new GymService(store);
  const authService = new AuthService(store);
  const studentPortalService = new StudentPortalService(store, gymService);

  const planPublic = accessService.createPlan({
    name: 'Musculação Mensal',
    duration_days: 30,
    price_cents: 12000,
    online_available: 1,
  });
  const planReceptionOnly = accessService.createPlan({
    name: 'Natação Infantil',
    duration_days: 30,
    price_cents: 18000,
    online_available: 0,
  });
  const planFree = accessService.createPlan({
    name: 'Cortesia',
    duration_days: 30,
    price_cents: 0,
    online_available: 1,
  });

  const modMusc = store.get("SELECT id FROM modalities WHERE active = 1 ORDER BY id ASC LIMIT 1");
  const mRegular = store.run(
    "INSERT INTO members (name, phone, access_role, plan_id) VALUES ('Aluno Musc', '11911110001', 'student', ?)",
    [planPublic.id],
  ).lastInsertRowid;
  const mKids = store.run(
    "INSERT INTO members (name, phone, access_role, plan_id) VALUES ('Aluno Kids', '11911110002', 'student', ?)",
    [planReceptionOnly.id],
  ).lastInsertRowid;

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, accessService, gymService, authService, studentPortalService }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const pubPlansRes = await fetch(`${baseUrl}/api/public/plans`);
    assert.equal(pubPlansRes.status, 200);
    const pubPlans = (await pubPlansRes.json()).plans;
    const pubIds = pubPlans.map((p) => p.id);
    assert.equal(pubIds.includes(planPublic.id), true);
    assert.equal(pubIds.includes(planReceptionOnly.id), false);
    assert.equal(pubIds.includes(planFree.id), false);

    const enrollOptsRes = await fetch(`${baseUrl}/api/public/enrollment-options`);
    assert.equal(enrollOptsRes.status, 200);
    const enrollOpts = await enrollOptsRes.json();
    const enrollIds = enrollOpts.plans.map((p) => p.id);
    assert.equal(enrollIds.includes(planPublic.id), true);
    assert.equal(enrollIds.includes(planReceptionOnly.id), false);
    assert.equal(enrollIds.includes(planFree.id), false);

    const blockedEnrollRes = await fetch(`${baseUrl}/api/public/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Teste Bloqueado',
        phone: '11922223333',
        modality_id: modMusc.id,
        plan_id: planReceptionOnly.id,
      }),
    });
    assert.equal(blockedEnrollRes.status, 400);

    const regularProfileIds = studentPortalService.getStudentProfile(mRegular).plans.map((p) => p.id);
    assert.equal(regularProfileIds.includes(planPublic.id), true);
    assert.equal(regularProfileIds.includes(planReceptionOnly.id), false);
    assert.equal(regularProfileIds.includes(planFree.id), false);

    const kidsProfileIds = studentPortalService.getStudentProfile(mKids).plans.map((p) => p.id);
    assert.equal(kidsProfileIds.includes(planPublic.id), true);
    assert.equal(kidsProfileIds.includes(planReceptionOnly.id), true);
    assert.equal(kidsProfileIds.includes(planFree.id), false);

    accessService.updatePlan(planReceptionOnly.id, {
      name: planReceptionOnly.name,
      duration_days: planReceptionOnly.duration_days,
      price_cents: planReceptionOnly.price_cents,
      online_available: 1,
    });
    const updatedPubPlans = (await (await fetch(`${baseUrl}/api/public/plans`)).json()).plans;
    assert.equal(updatedPubPlans.some((p) => p.id === planReceptionOnly.id), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Portal do Professor (/api/professor/*): convite, login isolado, treinos, modelos, catalogo, avaliacao e troca de senha', async () => {
  const store = await DatabaseStore.create(null);
  const accessService = new AccessService(store);
  const gymService = new GymService(store);
  const authService = new AuthService(store);
  const studentPortalService = new StudentPortalService(store, gymService);

  const prof = await accessService.createMember({
    name: 'Prof. Lucas',
    document: '52998224725',
    phone: '62999994444',
    access_role: 'instructor',
  });
  const staffMember = await accessService.createMember({
    name: 'Func. Carla',
    document: '98765432100',
    phone: '62999996666',
    access_role: 'staff',
  });
  const student = await accessService.createMember({
    name: 'Aluno Treino',
    document: '11144477735',
    phone: '62999995555',
    access_role: 'student',
  });

  const { code } = studentPortalService.issueInvite(prof.id);
  const { code: staffCode } = studentPortalService.issueInvite(staffMember.id);
  const { code: stuCode } = studentPortalService.issueInvite(student.id);

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, accessService, gymService, authService, studentPortalService }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Aluno comum nao entra no portal do professor
    const deniedRes = await fetch(`${baseUrl}/api/professor/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '62999995555', secret: stuCode }),
    });
    assert.equal(deniedRes.status, 401);

    // Funcionario (access_role='staff') tambem entra no portal do professor
    const staffLoginRes = await fetch(`${baseUrl}/api/professor/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '62999996666', secret: staffCode }),
    });
    assert.equal(staffLoginRes.status, 200);

    // Professor entra com codigo de convite de 4 digitos
    const loginRes = await fetch(`${baseUrl}/api/professor/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '62999994444', secret: code }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    // Sessao de professor nao acessa rotas exclusivas de aluno
    const stuRouteRes = await fetch(`${baseUrl}/api/student/me`, { headers: { cookie } });
    assert.equal(stuRouteRes.status, 401);

    const dashRes = await fetch(`${baseUrl}/api/professor/dashboard`, { headers: { cookie } });
    assert.equal(dashRes.status, 200);
    const dash = await dashRes.json();
    assert.equal(dash.professor.id, prof.id);
    assert.equal(dash.students.some((s) => s.id === student.id), true);

    const exRes = await fetch(`${baseUrl}/api/professor/exercise-catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Remada Curvada', muscle_group: 'Costas', uses_equipment: true, equipment: 'Barra', tips: 'Coluna neutra' }),
    });
    assert.equal(exRes.status, 201);
    const ex = await exRes.json();

    const tplRes = await fetch(`${baseUrl}/api/professor/workout-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Modelo Costas',
        goal: 'Hipertrofia',
        exercises: [{ exercise_key: ex.key, exercise_name: ex.name, muscle_group: ex.muscle_group, sets: 4, reps: '10', rest_seconds: 60 }],
      }),
    });
    assert.equal(tplRes.status, 201);

    const wkRes = await fetch(`${baseUrl}/api/professor/members/${student.id}/workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Treino B',
        goal: 'Hipertrofia',
        exercises: [{ exercise_key: ex.key, exercise_name: ex.name, muscle_group: ex.muscle_group, sets: 4, reps: '10', rest_seconds: 60 }],
      }),
    });
    assert.equal(wkRes.status, 201);

    const assessRes = await fetch(`${baseUrl}/api/professor/members/${student.id}/assessments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ weight_kg: 74.5, height_cm: 178, body_fat_pct: 15.2 }),
    });
    assert.equal(assessRes.status, 201);

    const pwdRes = await fetch(`${baseUrl}/api/professor/me/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ new_password: 'prof-senha-segura' }),
    });
    assert.equal(pwdRes.status, 200);

    // Token antigo foi invalidado
    const staleRes = await fetch(`${baseUrl}/api/professor/dashboard`, { headers: { cookie } });
    assert.equal(staleRes.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
