import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { GymService } from '../src/services/gymService.js';
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
