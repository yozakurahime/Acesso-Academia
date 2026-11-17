import '../../public/exercises.js';

const baseExercises = globalThis.EXERCISE_LIBRARY.EXERCISE_CATALOG.filter(({ key }) => key !== 'custom');
const variants = [
  ['Peso corporal', 'Pernas', 'Agachamento com Peso Corporal|Agachamento Sumô sem Carga|Agachamento Isométrico na Parede|Agachamento Unilateral Assistido|Afundo Reverso|Afundo Lateral|Afundo Caminhando sem Carga|Passada Cruzada|Elevação de Panturrilhas no Solo|Salto Vertical|Agachamento com Salto'],
  ['Peso corporal', 'Peito', 'Flexão com Joelhos Apoiados|Flexão Diamante|Flexão Aberta|Flexão com Toque no Ombro|Flexão Archer|Flexão Pike'],
  ['Peso corporal', 'Abdômen', 'Prancha Lateral|Prancha Alta|Prancha com Toque no Ombro|Dead Bug|Bird Dog|Abdominal Bicicleta|Abdominal Reverso|Abdominal Canivete|Abdominal Oblíquo|Hollow Hold|Elevação de Pernas no Solo|Tesoura Abdominal|Flexão Lateral do Tronco no Solo'],
  ['Peso corporal', 'Glúteos', 'Ponte de Glúteos Unilateral|Abdução de Quadril Deitado|Extensão de Quadril em Quatro Apoios|Abdução de Quadril em Quatro Apoios'],
  ['Peso corporal', 'Cardio', 'Burpee|Marcha Estacionária|Corrida Estacionária|Elevação de Joelhos|Saltos Laterais|Skater Jump'],
  ['Peso corporal', 'Mobilidade', 'Gato e Vaca|Rotação Torácica de Lado|Mobilidade de Tornozelo na Parede|Rotação de Quadril 90/90|Alongamento de Flexores do Quadril|Alongamento de Panturrilha na Parede|Alongamento de Posteriores Sentado|Alongamento de Peitoral na Parede|Rotação de Tronco em Quatro Apoios'],
  ['Barra', 'Peito', 'Supino Inclinado com Barra|Supino Declinado com Barra|Supino com Pegada Fechada'],
  ['Barra', 'Pernas', 'Agachamento Costas com Barra|Agachamento Frontal com Barra|Agachamento Zercher|Afundo com Barra|Agachamento Búlgaro com Barra'],
  ['Barra', 'Posteriores', 'Levantamento Terra Convencional|Levantamento Terra Sumô|Levantamento Terra Romeno com Barra|Good Morning com Barra'],
  ['Barra', 'Costas', 'Remada Curvada com Barra|Remada Pendlay|Remada Cavalinho'],
  ['Barra', 'Ombros', 'Desenvolvimento Militar com Barra|Push Press com Barra|Remada Alta com Barra'],
  ['Barra', 'Glúteos', 'Hip Thrust com Barra|Ponte de Glúteos com Barra'],
  ['Barra', 'Bíceps', 'Rosca Direta com Barra Reta|Rosca Direta com Barra W|Rosca Inversa com Barra'],
  ['Barra', 'Tríceps', 'Tríceps Testa com Barra W'],
  ['Barra fixa', 'Costas', 'Barra Fixa Pronada|Barra Fixa Supinada|Barra Fixa Neutra|Remada Invertida|Depressão Escapular na Barra'],
  ['Barra fixa', 'Abdômen', 'Elevação de Joelhos na Barra|Elevação de Pernas na Barra'],
  ['Halteres', 'Peito', 'Supino Reto com Halteres|Supino Declinado com Halteres|Crucifixo Reto com Halteres|Crucifixo Inclinado com Halteres|Pullover com Halter'],
  ['Halteres', 'Costas', 'Remada Unilateral com Halter|Remada com Halteres no Banco Inclinado|Remada Curvada com Halteres'],
  ['Halteres', 'Ombros', 'Desenvolvimento Arnold|Elevação Frontal com Halteres|Crucifixo Inverso com Halteres|Encolhimento com Halteres'],
  ['Halteres', 'Pernas', 'Agachamento Goblet com Halter|Afundo com Halteres|Agachamento Búlgaro com Halteres|Subida no Banco com Halteres|Panturrilha em Pé com Halteres'],
  ['Halteres', 'Posteriores', 'Levantamento Romeno Unilateral com Halteres'],
  ['Halteres', 'Bíceps', 'Rosca Alternada com Halteres|Rosca Concentrada|Rosca no Banco Inclinado|Rosca Scott com Halter'],
  ['Halteres', 'Tríceps', 'Tríceps Francês com Halter|Tríceps Coice com Halter|Tríceps Testa com Halteres'],
  ['Halteres', 'Abdômen', 'Caminhada do Fazendeiro com Halteres|Caminhada Unilateral com Halter'],
  ['Máquina', 'Peito', 'Supino Horizontal na Máquina|Supino Inclinado na Máquina|Crucifixo no Peck Deck'],
  ['Máquina', 'Costas', 'Remada Articulada na Máquina|Puxada Articulada na Máquina|Barra Fixa Assistida no Graviton'],
  ['Máquina', 'Pernas', 'Leg Press Horizontal|Leg Press 45° Unilateral|Agachamento Hack|Agachamento no Smith|Cadeira Extensora Unilateral|Cadeira Adutora|Cadeira Abdutora|Panturrilha Sentada na Máquina|Panturrilha no Leg Press'],
  ['Máquina', 'Posteriores', 'Cadeira Flexora|Flexão de Joelhos em Pé na Máquina|Mesa Flexora Unilateral'],
  ['Máquina', 'Glúteos', 'Hip Thrust na Máquina|Coice na Máquina|Hip Thrust no Smith'],
  ['Máquina', 'Ombros', 'Desenvolvimento na Máquina|Elevação Lateral na Máquina|Crucifixo Inverso no Peck Deck'],
  ['Máquina', 'Braços', 'Rosca Scott na Máquina|Tríceps na Máquina|Paralelas Assistidas no Graviton'],
  ['Máquina', 'Abdômen', 'Abdominal na Máquina|Rotação de Tronco na Máquina'],
  ['Polia', 'Peito', 'Crucifixo na Polia Alta|Crucifixo na Polia Baixa|Supino em Pé na Polia'],
  ['Polia', 'Costas', 'Puxada Neutra na Polia|Puxada Supinada na Polia|Remada Baixa com Triângulo|Remada Unilateral na Polia|Pulldown de Braços Estendidos'],
  ['Polia', 'Ombros', 'Face Pull|Elevação Lateral na Polia|Crucifixo Inverso na Polia'],
  ['Polia', 'Braços', 'Rosca Direta na Polia|Rosca Bayesiana|Tríceps na Polia com Barra|Tríceps Unilateral na Polia|Tríceps Acima da Cabeça na Polia'],
  ['Polia', 'Glúteos', 'Coice na Polia|Abdução de Quadril na Polia|Pull Through na Polia'],
  ['Polia', 'Abdômen', 'Abdominal Ajoelhado na Polia|Pallof Press na Polia|Rotação Diagonal na Polia'],
  ['Elástico', 'Costas', 'Remada com Elástico|Puxada com Elástico|Abertura de Elástico à Frente'],
  ['Elástico', 'Ombros', 'Rotação Externa com Elástico|Rotação Interna com Elástico|Elevação Lateral com Elástico'],
  ['Elástico', 'Pernas', 'Agachamento com Miniband|Caminhada Lateral com Miniband|Caminhada Monstro com Miniband'],
  ['Elástico', 'Glúteos', 'Ponte de Glúteos com Miniband|Abdução tipo Concha com Miniband'],
  ['Elástico', 'Braços', 'Rosca Direta com Elástico|Tríceps com Elástico'],
  ['Kettlebell', 'Corpo inteiro', 'Swing com Kettlebell|Clean com Kettlebell|Snatch com Kettlebell|Levantamento Turco'],
  ['Kettlebell', 'Pernas', 'Agachamento Goblet com Kettlebell|Levantamento Terra com Kettlebell|Afundo com Kettlebell'],
  ['Banco ou step', 'Pernas', 'Subida no Step|Descida Controlada do Step|Agachamento Búlgaro sem Carga|Elevação de Panturrilha no Step'],
  ['Banco ou step', 'Peito', 'Flexão Inclinada no Banco|Flexão Declinada no Banco'],
  ['Suspensão', 'Corpo inteiro', 'Remada em Suspensão|Flexão em Suspensão|Agachamento em Suspensão|Afundo em Suspensão|Prancha em Suspensão'],
  ['Bola suíça', 'Corpo inteiro', 'Abdominal na Bola Suíça|Flexão de Joelhos na Bola Suíça|Prancha na Bola Suíça'],
  ['Aparelho de cardio', 'Cardio', 'Elíptico|Remo Ergométrico|Escada Ergométrica|Air Bike|Caminhada na Esteira|Esteira Inclinada'],
  ['Corda', 'Cardio', 'Pular Corda|Ondas Alternadas na Corda Naval|Ondas Simultâneas na Corda Naval'],
];

const normalized = (value) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const slug = (value) => normalized(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const seed = [...baseExercises, ...variants.flatMap(([equipment, muscle_group, names]) =>
  names.split('|').map((name) => ({ key: 'lib_' + slug(name), name, muscle_group, equipment })))];

export function seedExerciseCatalog(store) {
  if (seed.every(({ key }) => store.get('SELECT 1 FROM exercise_catalog WHERE key = ?', [key]))) return;
  store.transaction(() => {
    for (const { key, name, muscle_group, equipment, tips } of seed) {
      store.run(`INSERT OR IGNORE INTO exercise_catalog (key, name, muscle_group, equipment, tips, uses_equipment)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [key, name, muscle_group, equipment, tips || '', Number(!['Peso corporal', 'Colchonete'].includes(equipment))]);
    }
  });
}

export function listExerciseCatalog(store) {
  return store.all(`SELECT key, name, muscle_group, equipment, tips, uses_equipment,
    video_file IS NOT NULL AS has_video FROM exercise_catalog ORDER BY name COLLATE NOCASE`);
}

export function saveCatalogExercise(store, data, key) {
  const name = String(data?.name ?? '').trim();
  const group = String(data?.muscle_group ?? '').trim();
  const equipment = String(data?.equipment ?? '').trim();
  const tips = String(data?.tips ?? '').trim();
  const usesEquipment = data?.uses_equipment;
  if (!name || !group || name.length > 120 || group.length > 80 || equipment.length > 100 || tips.length > 1200) {
    throw new Error('Informe um nome e um grupo muscular válidos.');
  }
  if (typeof usesEquipment !== 'boolean' || (usesEquipment && !equipment)) {
    throw new Error('Indique se o exercício usa equipamento e preencha qual, quando aplicável.');
  }
  if (store.all('SELECT key, name FROM exercise_catalog').some((entry) => entry.key !== key && normalized(entry.name) === normalized(name))) {
    throw new Error('Já existe um exercício com esse nome.');
  }
  const values = [name, group, usesEquipment ? equipment : 'Peso corporal', tips, Number(usesEquipment)];
  if (key) {
    const changed = store.run(`UPDATE exercise_catalog SET name = ?, muscle_group = ?, equipment = ?, tips = ?, uses_equipment = ?
      WHERE key = ?`, [...values, key]).changes;
    if (!changed) throw new Error('Exercício não encontrado.');
  } else {
    const baseKey = 'ox_' + (slug(name).slice(0, 100) || 'exercicio');
    key = baseKey;
    for (let suffix = 2; store.get('SELECT 1 FROM exercise_catalog WHERE key = ?', [key]); suffix++) key = baseKey + '_' + suffix;
    store.run('INSERT INTO exercise_catalog (key, name, muscle_group, equipment, tips, uses_equipment) VALUES (?, ?, ?, ?, ?, ?)', [key, ...values]);
  }
  return listExerciseCatalog(store).find((entry) => entry.key === key);
}
