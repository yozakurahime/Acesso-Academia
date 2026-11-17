(function (global) {
  const EXERCISE_CATALOG = [
    { key: 'supino_reto', name: 'Supino Reto com Barra', muscle_group: 'Peito', equipment: 'Banco reto + Barra', tips: 'Mantenha os pés firmes no chão, escápulas retraídas e desça a barra até próximo ao meio do peito antes de empurrar.' },
    { key: 'supino_inclinado', name: 'Supino Inclinado com Halteres', muscle_group: 'Peito', equipment: 'Banco inclinado + Halteres', tips: 'Banco a 30°–45°. Controle a descida abrindo os cotovelos a ~45° e suba unindo os halteres no topo.' },
    { key: 'crucifixo', name: 'Crucifixo / Peck Deck', muscle_group: 'Peito', equipment: 'Halteres ou Máquina', tips: 'Mantenha os cotovelos levemente flexionados durante todo o arco do movimento, focando na abertura e contração do peitoral.' },
    { key: 'flexao', name: 'Flexão de Braço', muscle_group: 'Peito', equipment: 'Peso corporal', tips: 'Corpo alinhado da cabeça aos calcanhares, abdômen contraído. Desça até o peito quase tocar o solo e empurre.' },
    { key: 'puxada_frente', name: 'Puxada Frontal na Polia', muscle_group: 'Costas', equipment: 'Polia alta', tips: 'Peito aberto, puxe a barra em direção à parte superior do peito levando os cotovelos para baixo e para trás.' },
    { key: 'remada_baixa', name: 'Remada Baixa / Curvada', muscle_group: 'Costas', equipment: 'Polia baixa ou Barra', tips: 'Coluna neutra e abdômen firme. Puxe o pegador em direção ao umbigo apertando as escápulas.' },
    { key: 'barra_fixa', name: 'Barra Fixa / Graviton', muscle_group: 'Costas', equipment: 'Barra fixa', tips: 'Segure na largura dos ombros ou mais aberto. Suba o queixo acima da barra e desça controlando.' },
    { key: 'agachamento', name: 'Agachamento Livre', muscle_group: 'Pernas', equipment: 'Barra / Peso corporal', tips: 'Pés na largura dos ombros, joelhos alinhados com as pontas dos pés, coluna reta. Desça até pelo menos 90°.' },
    { key: 'leg_press', name: 'Leg Press 45°', muscle_group: 'Pernas', equipment: 'Máquina Leg Press', tips: 'Apoie bem lombar e quadril no encosto. Desça os joelhos em direção ao peito sem tirar o quadril do banco e empurre sem travar os joelhos.' },
    { key: 'cadeira_extensora', name: 'Cadeira Extensora', muscle_group: 'Pernas', equipment: 'Máquina Extensora', tips: 'Ajuste o apoio no tornozelo, estenda os joelhos contraindo o quadríceps no topo e desça devagar.' },
    { key: 'mesa_flexora', name: 'Mesa Flexora', muscle_group: 'Pernas', equipment: 'Máquina Flexora', tips: 'Mantenha o quadril apoiado no banco e flexione os joelhos trazendo o rolo em direção aos glúteos.' },
    { key: 'panturrilha', name: 'Panturrilha em Pé', muscle_group: 'Pernas', equipment: 'Step / Máquina', tips: 'Suba na ponta dos pés com máxima amplitude, segure 1s no topo e desça alongando bem o calcanhar.' },
    { key: 'desenvolvimento', name: 'Desenvolvimento com Halteres', muscle_group: 'Ombros', equipment: 'Banco + Halteres', tips: 'Empurre os halteres acima da cabeça sem arquear excessivamente a lombar e desça até a linha das orelhas.' },
    { key: 'elevacao_lateral', name: 'Elevação Lateral', muscle_group: 'Ombros', equipment: 'Halteres', tips: 'Eleve os braços lateralmente até a altura dos ombros com os cotovelos levemente flexionados e controle a descida.' },
    { key: 'rosca_direta', name: 'Rosca Direta', muscle_group: 'Bíceps', equipment: 'Barra ou Halteres', tips: 'Cotovelos fixos ao lado do tronco. Suba a carga contraindo o bíceps e desça devagar sem balançar o corpo.' },
    { key: 'triceps_pulley', name: 'Tríceps Pulley / Corda', muscle_group: 'Tríceps', equipment: 'Polia alta', tips: 'Cotovelos colados ao tronco. Estenda totalmente o antebraço para baixo e controle o retorno até 90°.' },
    { key: 'triceps_testa', name: 'Tríceps Testa', muscle_group: 'Tríceps', equipment: 'Banco + Barra W / Halteres', tips: 'Braços apontados para o teto; flexione apenas os cotovelos levando a barra em direção à testa e estenda.' },
    { key: 'abdominal_supra', name: 'Abdominal Supra', muscle_group: 'Abdômen', equipment: 'Colchonete', tips: 'Tire apenas as escápulas do chão contraindo o abdômen, soltando o ar na subida sem puxar o pescoço.' },
    { key: 'prancha', name: 'Prancha Isométrica', muscle_group: 'Abdômen', equipment: 'Colchonete', tips: 'Apoie os antebraços, contraia abdômen e glúteos mantendo o corpo reto como uma tábua durante todo o tempo.' },
    { key: 'esteira_corrida', name: 'Esteira / Corrida', muscle_group: 'Cardio', equipment: 'Esteira', tips: 'Postura ereta, olhar à frente e passada cadenciada mantendo o ritmo cardíaco na zona alvo.' },
    { key: 'bicicleta', name: 'Bicicleta Ergométrica', muscle_group: 'Cardio', equipment: 'Bike ergométrica', tips: 'Ajuste o banco na altura do quadril e mantenha cadência constante com joelhos alinhados.' },
    { key: 'avanco', name: 'Afundo Estacionário', muscle_group: 'Pernas', equipment: 'Peso corporal', tips: 'Mantenha os pés plantados. Flexione os joelhos com controle e volte à posição inicial. Troque de lado ao terminar.' },
    { key: 'ponte_gluteos', name: 'Ponte de Glúteos', muscle_group: 'Glúteos', equipment: 'Colchonete', tips: 'Com os pés no chão, eleve o quadril sem arquear a lombar e retorne com controle.' },
    { key: 'levantamento_romeno', name: 'Levantamento Romeno com Halteres', muscle_group: 'Posteriores', equipment: 'Halteres', tips: 'Leve o quadril para trás com os joelhos levemente flexionados e mantenha a carga próxima das pernas.' },
    { key: 'rosca_martelo', name: 'Rosca Martelo', muscle_group: 'Bíceps', equipment: 'Halteres', tips: 'Mantenha as palmas voltadas uma para a outra e os cotovelos próximos ao corpo durante a flexão.' },
    { key: 'polichinelo', name: 'Polichinelo', muscle_group: 'Cardio', equipment: 'Peso corporal', tips: 'Abra braços e pernas juntos e volte à posição inicial. Aterrisse suavemente.' },
    { key: 'escalador', name: 'Escalador', muscle_group: 'Abdômen', equipment: 'Peso corporal', tips: 'Com as mãos firmes no chão e o tronco estável, alterne o joelho que se aproxima do peito.' },
    { key: 'custom', name: 'Exercício Personalizado', muscle_group: 'Geral', equipment: 'Livre', tips: 'Siga a orientação registrada pelo professor.' },
  ];

  // Cada pose usa os mesmos segmentos, na mesma ordem, para que as articulações se movam juntas.
  const movements = {
    avanco: [
      'M100 45 L100 88 M100 57 L88 75 L96 85 M100 88 L126 104 L135 135 M100 88 L74 103 L64 135 M93 35 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M102 66 L102 108 M102 78 L89 92 L98 104 M102 108 L134 108 L135 135 M102 108 L83 129 L64 135 M95 56 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
    ponte_gluteos: [
      'M59 124 L104 128 M66 124 L80 132 L105 133 M104 128 L136 101 L149 135 M104 128 L135 105 L146 135 M45 121 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M59 124 L103 102 M66 122 L80 132 L105 133 M103 102 L136 94 L149 135 M103 102 L135 98 L146 135 M45 121 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
    levantamento_romeno: [
      'M104 47 L102 89 M104 53 L111 71 L112 89 M102 89 L105 110 L104 134 M102 89 L99 110 L98 134 M97 37 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M124 74 L91 87 M124 75 L120 93 L118 112 M91 87 L105 110 L104 134 M91 87 L99 110 L98 134 M127 68 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
    rosca_martelo: [
      'M98 48 L98 95 M99 56 L102 77 L106 96 M98 95 L92 114 L91 134 M98 95 L106 114 L107 134 M91 38 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M98 48 L98 95 M99 56 L102 77 L116 60 M98 95 L92 114 L91 134 M98 95 L106 114 L107 134 M91 38 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
    polichinelo: [
      'M100 48 L100 91 M100 55 L89 69 L87 87 M100 55 L111 69 L113 87 M100 91 L95 113 L94 134 M100 91 L105 113 L106 134 M93 38 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M100 42 L100 85 M100 49 L84 39 L76 22 M100 49 L116 39 L124 22 M100 85 L86 108 L72 134 M100 85 L114 108 L128 134 M93 32 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
    escalador: [
      'M64 87 L113 98 M66 90 L64 112 L65 135 M113 98 L132 115 L152 134 M113 98 L100 104 L111 126 M49 79 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
      'M64 87 L113 98 M66 90 L64 112 L65 135 M113 98 L100 104 L111 126 M113 98 L132 115 L152 134 M49 79 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0',
    ],
  };

  const WORKOUT_EXAMPLES = [
    { key: 'corpo_inteiro', title: 'Corpo inteiro', goal: 'Força geral', rows: [['agachamento', '10'], ['flexao', '8'], ['remada_baixa', '10'], ['prancha', '20 s']] },
    { key: 'pernas_gluteos', title: 'Pernas e glúteos', goal: 'Força de membros inferiores', rows: [['avanco', '8 por lado'], ['ponte_gluteos', '12'], ['levantamento_romeno', '10'], ['panturrilha', '12']] },
    { key: 'superiores', title: 'Membros superiores', goal: 'Peito, costas e braços', rows: [['supino_reto', '10'], ['puxada_frente', '10'], ['elevacao_lateral', '10'], ['rosca_martelo', '10']] },
  ].map(({ rows, ...example }) => ({
    ...example,
    notes: 'Ajuste séries, carga e descanso à orientação do professor.',
    exercises: rows.map(([key, reps]) => {
      const { name, muscle_group } = findExercise(key);
      return { exercise_key: key, exercise_name: name, muscle_group, sets: 2, reps, rest_seconds: 60 };
    }),
  }));

  let stylesInjected = false;
  function ensureExerciseStyles() {
    if (stylesInjected || typeof document === 'undefined') return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'exercise-anim-styles';
    style.textContent = `
      .ex-anim-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 4 / 3;
        background: radial-gradient(circle at 50% 35%, #1e293b 0%, #0b1220 100%);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 12px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .ex-anim-wrap.size-sm { max-width: 150px; }
      .ex-anim-wrap.size-md { max-width: 240px; }
      .ex-anim-wrap.size-lg { max-width: 380px; }
      .ex-anim-svg { width: 100%; height: 100%; display: block; }
      .ex-anim-wrap.is-paused * { animation-play-state: paused !important; }
      .ex-anim-placeholder { color: #e2e8f0; text-align: center; padding: 6px; font-size: 12px; }
      @media (prefers-reduced-motion: reduce) {
        .ex-anim-wrap:not(.allow-motion) * { animation-play-state: paused !important; }
      }

      .ex-bar-updown { animation: exBarUpDown var(--ex-dur, 2.2s) ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
      .ex-arms-press { animation: exArmsPress var(--ex-dur, 2.2s) ease-in-out infinite; transform-box: fill-box; transform-origin: bottom center; }
      .ex-fly-l { animation: exFlyL var(--ex-dur, 2.4s) ease-in-out infinite; transform-box: fill-box; transform-origin: right center; }
      .ex-fly-r { animation: exFlyR var(--ex-dur, 2.4s) ease-in-out infinite; transform-box: fill-box; transform-origin: left center; }
      .ex-pushup-body { animation: exPushup var(--ex-dur, 2.2s) ease-in-out infinite; transform-box: fill-box; transform-origin: right bottom; }
      .ex-pull-down { animation: exPullDown var(--ex-dur, 2.2s) ease-in-out infinite; }
      .ex-row-pull { animation: exRowPull var(--ex-dur, 2.2s) ease-in-out infinite; }
      .ex-pullup-body { animation: exPullupBody var(--ex-dur, 2.4s) ease-in-out infinite; }
      .ex-squat-body { animation: exSquat var(--ex-dur, 2.4s) ease-in-out infinite; transform-box: fill-box; transform-origin: bottom center; }
      .ex-legpress-sled { animation: exLegPress var(--ex-dur, 2.4s) ease-in-out infinite; }
      .ex-kick-leg { animation: exKickLeg var(--ex-dur, 2.2s) ease-in-out infinite; transform-origin: 96px 104px; }
      .ex-curl-leg { animation: exCurlLeg var(--ex-dur, 2.2s) ease-in-out infinite; transform-origin: 120px 108px; }
      .ex-calf-raise { animation: exCalfRaise var(--ex-dur, 2s) ease-in-out infinite; }
      .ex-lat-l { animation: exLatL var(--ex-dur, 2.2s) ease-in-out infinite; transform-origin: 88px 66px; }
      .ex-lat-r { animation: exLatR var(--ex-dur, 2.2s) ease-in-out infinite; transform-origin: 112px 66px; }
      .ex-bicep-curl { animation: exBicepCurl var(--ex-dur, 2s) ease-in-out infinite; transform-origin: 108px 78px; }
      .ex-tricep-push { animation: exTricepPush var(--ex-dur, 2s) ease-in-out infinite; transform-origin: 108px 74px; }
      .ex-tricep-testa { animation: exTricepTesta var(--ex-dur, 2s) ease-in-out infinite; transform-origin: 78px 82px; }
      .ex-crunch { animation: exCrunch var(--ex-dur, 2.2s) ease-in-out infinite; transform-origin: 115px 124px; }
      .ex-plank-pulse { animation: exPlankPulse var(--ex-dur, 1.8s) ease-in-out infinite; }
      .ex-run-leg-a { animation: exRunA var(--ex-dur, 1s) ease-in-out infinite; transform-origin: 100px 92px; }
      .ex-run-leg-b { animation: exRunB var(--ex-dur, 1s) ease-in-out infinite; transform-origin: 100px 92px; }
      .ex-bike-pedal { animation: exSpin var(--ex-dur, 1.2s) linear infinite; transform-origin: 112px 116px; }

      @keyframes exBarUpDown { 0%, 100% { transform: translateY(18px); } 50% { transform: translateY(-8px); } }
      @keyframes exArmsPress { 0%, 100% { transform: scaleY(0.55); } 50% { transform: scaleY(1.1); } }
      @keyframes exFlyL { 0%, 100% { transform: rotate(-42deg); } 50% { transform: rotate(8deg); } }
      @keyframes exFlyR { 0%, 100% { transform: rotate(42deg); } 50% { transform: rotate(-8deg); } }
      @keyframes exPushup { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(14px) rotate(-10deg); } }
      @keyframes exPullDown { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(34px); } }
      @keyframes exRowPull { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(26px); } }
      @keyframes exPullupBody { 0%, 100% { transform: translateY(24px); } 50% { transform: translateY(0px); } }
      @keyframes exSquat { 0%, 100% { transform: translateY(0) scaleY(1); } 50% { transform: translateY(22px) scaleY(0.76); } }
      @keyframes exLegPress { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(22px, -18px); } }
      @keyframes exKickLeg { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-72deg); } }
      @keyframes exCurlLeg { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-75deg); } }
      @keyframes exCalfRaise { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-12px); } }
      @keyframes exLatL { 0%, 100% { transform: rotate(65deg); } 50% { transform: rotate(0deg); } }
      @keyframes exLatR { 0%, 100% { transform: rotate(-65deg); } 50% { transform: rotate(0deg); } }
      @keyframes exBicepCurl { 0%, 100% { transform: rotate(55deg); } 50% { transform: rotate(-55deg); } }
      @keyframes exTricepPush { 0%, 100% { transform: rotate(-55deg); } 50% { transform: rotate(25deg); } }
      @keyframes exTricepTesta { 0%, 100% { transform: rotate(-70deg); } 50% { transform: rotate(5deg); } }
      @keyframes exCrunch { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(34deg); } }
      @keyframes exPlankPulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
      @keyframes exRunA { 0%, 100% { transform: rotate(-28deg); } 50% { transform: rotate(28deg); } }
      @keyframes exRunB { 0%, 100% { transform: rotate(28deg); } 50% { transform: rotate(-28deg); } }
      @keyframes exSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
    for (const [key, [start, end]] of Object.entries(movements)) {
      style.textContent += `@keyframes exercise-${key} {0%,100% {d:path("${start}")} 50% {d:path("${end}")}}
        .motion-${key} {animation:exercise-${key} var(--ex-dur) ease-in-out infinite;}`;
    }
    document.head.appendChild(style);
  }

  function svgScene(key) {
    const floor = '<line x1="16" y1="136" x2="184" y2="136" stroke="#334155" stroke-width="3" stroke-linecap="round"/>';
    if (Object.hasOwn(movements, key)) {
      return `${floor}<path class="motion-${key}" d="${movements[key][0]}" fill="none" stroke="#fdba74" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    switch (key) {
      case 'supino_reto':
      case 'supino_inclinado': {
        const tilt = key === 'supino_inclinado' ? 'transform="rotate(-22 100 108)"' : '';
        return `${floor}
          <g ${tilt}>
            <rect x="48" y="106" width="104" height="9" rx="4" fill="#475569"/>
            <line x1="62" y1="115" x2="62" y2="136" stroke="#475569" stroke-width="4"/>
            <line x1="138" y1="115" x2="138" y2="136" stroke="#475569" stroke-width="4"/>
            <circle cx="66" cy="96" r="8" fill="#e2e8f0"/>
            <line x1="74" y1="100" x2="128" y2="100" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
            <line x1="128" y1="100" x2="152" y2="118" stroke="#cbd5e1" stroke-width="6" stroke-linecap="round"/>
            <g class="ex-bar-updown">
              <line x1="58" y1="74" x2="142" y2="74" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
              <rect x="52" y="62" width="7" height="24" rx="2" fill="#22c55e"/>
              <rect x="141" y="62" width="7" height="24" rx="2" fill="#22c55e"/>
              <line x1="88" y1="74" x2="88" y2="98" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
              <line x1="112" y1="74" x2="112" y2="98" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            </g>
          </g>`;
      }
      case 'crucifixo':
        return `${floor}
          <circle cx="100" cy="42" r="9" fill="#e2e8f0"/>
          <rect x="92" y="54" width="16" height="44" rx="7" fill="#cbd5e1"/>
          <line x1="94" y1="96" x2="88" y2="135" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="106" y1="96" x2="112" y2="135" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <g class="ex-fly-l">
            <line x1="92" y1="64" x2="52" y2="64" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
            <circle cx="48" cy="64" r="5" fill="#22c55e"/>
          </g>
          <g class="ex-fly-r">
            <line x1="108" y1="64" x2="148" y2="64" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
            <circle cx="152" cy="64" r="5" fill="#22c55e"/>
          </g>`;
      case 'flexao':
        return `${floor}
          <g class="ex-pushup-body">
            <circle cx="60" cy="96" r="8" fill="#e2e8f0"/>
            <line x1="68" y1="102" x2="146" y2="128" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
            <line x1="74" y1="105" x2="72" y2="134" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
          </g>`;
      case 'puxada_frente':
        return `${floor}
          <line x1="100" y1="14" x2="100" y2="42" stroke="#64748b" stroke-width="2" stroke-dasharray="3 2"/>
          <rect x="78" y="106" width="44" height="7" rx="3" fill="#475569"/>
          <circle cx="100" cy="62" r="8" fill="#e2e8f0"/>
          <line x1="100" y1="72" x2="100" y2="106" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="100" y1="106" x2="122" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <g class="ex-pull-down">
            <line x1="64" y1="34" x2="136" y2="34" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
            <line x1="70" y1="34" x2="94" y2="74" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/>
            <line x1="130" y1="34" x2="106" y2="74" stroke="#22c55e" stroke-width="4" stroke-linecap="round"/>
          </g>`;
      case 'remada_baixa':
        return `${floor}
          <rect x="34" y="54" width="12" height="82" rx="3" fill="#475569"/>
          <circle cx="132" cy="68" r="8" fill="#e2e8f0"/>
          <line x1="130" y1="78" x2="126" y2="118" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="126" y1="118" x2="72" y2="126" stroke="#94a3b8" stroke-width="7" stroke-linecap="round"/>
          <g class="ex-row-pull">
            <line x1="46" y1="88" x2="94" y2="88" stroke="#64748b" stroke-width="2"/>
            <rect x="92" y="81" width="6" height="14" rx="2" fill="#22c55e"/>
            <line x1="96" y1="88" x2="128" y2="84" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
          </g>`;
      case 'barra_fixa':
        return `${floor}
          <line x1="48" y1="22" x2="152" y2="22" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>
          <g class="ex-pullup-body">
            <circle cx="100" cy="44" r="8" fill="#e2e8f0"/>
            <line x1="100" y1="54" x2="100" y2="92" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
            <line x1="100" y1="92" x2="94" y2="118" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
            <line x1="100" y1="92" x2="106" y2="118" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
            <line x1="74" y1="22" x2="95" y2="56" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <line x1="126" y1="22" x2="105" y2="56" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
          </g>`;
      case 'agachamento':
        return `${floor}
          <g class="ex-squat-body">
            <circle cx="100" cy="36" r="8" fill="#e2e8f0"/>
            <line x1="60" y1="48" x2="140" y2="48" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>
            <rect x="54" y="38" width="7" height="20" rx="2" fill="#22c55e"/>
            <rect x="139" y="38" width="7" height="20" rx="2" fill="#22c55e"/>
            <line x1="100" y1="46" x2="100" y2="88" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
            <line x1="100" y1="88" x2="86" y2="134" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
            <line x1="100" y1="88" x2="114" y2="134" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
          </g>`;
      case 'leg_press':
        return `${floor}
          <line x1="56" y1="114" x2="88" y2="96" stroke="#475569" stroke-width="8" stroke-linecap="round"/>
          <circle cx="62" cy="86" r="8" fill="#e2e8f0"/>
          <line x1="68" y1="94" x2="90" y2="112" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <g class="ex-legpress-sled">
            <line x1="122" y1="68" x2="144" y2="94" stroke="#22c55e" stroke-width="7" stroke-linecap="round"/>
            <line x1="90" y1="112" x2="132" y2="82" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
          </g>`;
      case 'cadeira_extensora':
        return `${floor}
          <rect x="66" y="72" width="8" height="40" rx="3" fill="#475569"/>
          <rect x="66" y="102" width="38" height="8" rx="3" fill="#475569"/>
          <circle cx="76" cy="58" r="8" fill="#e2e8f0"/>
          <line x1="76" y1="68" x2="76" y2="102" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <line x1="76" y1="102" x2="96" y2="104" stroke="#cbd5e1" stroke-width="7" stroke-linecap="round"/>
          <g class="ex-kick-leg">
            <line x1="96" y1="104" x2="96" y2="134" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
            <circle cx="96" cy="132" r="5" fill="#22c55e"/>
          </g>`;
      case 'mesa_flexora':
        return `${floor}
          <rect x="52" y="106" width="84" height="8" rx="3" fill="#475569"/>
          <circle cx="60" cy="94" r="8" fill="#e2e8f0"/>
          <line x1="68" y1="100" x2="120" y2="106" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <g class="ex-curl-leg">
            <line x1="120" y1="108" x2="152" y2="108" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>
            <circle cx="152" cy="108" r="5" fill="#22c55e"/>
          </g>`;
      case 'panturrilha':
        return `${floor}
          <rect x="82" y="128" width="36" height="8" rx="2" fill="#475569"/>
          <g class="ex-calf-raise">
            <circle cx="100" cy="36" r="8" fill="#e2e8f0"/>
            <line x1="100" y1="46" x2="100" y2="86" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
            <line x1="100" y1="86" x2="100" y2="128" stroke="#38bdf8" stroke-width="7" stroke-linecap="round"/>
          </g>`;
      case 'desenvolvimento':
        return `${floor}
          <rect x="82" y="106" width="36" height="8" rx="3" fill="#475569"/>
          <circle cx="100" cy="60" r="8" fill="#e2e8f0"/>
          <line x1="100" y1="70" x2="100" y2="106" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <g class="ex-bar-updown">
            <line x1="78" y1="44" x2="78" y2="74" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <line x1="122" y1="44" x2="122" y2="74" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <rect x="68" y="38" width="18" height="6" rx="2" fill="#22c55e"/>
            <rect x="114" y="38" width="18" height="6" rx="2" fill="#22c55e"/>
          </g>`;
      case 'elevacao_lateral':
        return `${floor}
          <circle cx="100" cy="40" r="8" fill="#e2e8f0"/>
          <line x1="100" y1="50" x2="100" y2="92" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="100" y1="92" x2="92" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="100" y1="92" x2="108" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <g class="ex-lat-l">
            <line x1="92" y1="62" x2="54" y2="62" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <circle cx="52" cy="62" r="5" fill="#22c55e"/>
          </g>
          <g class="ex-lat-r">
            <line x1="108" y1="62" x2="146" y2="62" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <circle cx="148" cy="62" r="5" fill="#22c55e"/>
          </g>`;
      case 'rosca_direta':
        return `${floor}
          <circle cx="96" cy="40" r="8" fill="#e2e8f0"/>
          <line x1="96" y1="50" x2="96" y2="92" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="96" y1="92" x2="90" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="96" y1="92" x2="104" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="102" y1="56" x2="108" y2="78" stroke="#cbd5e1" stroke-width="5" stroke-linecap="round"/>
          <g class="ex-bicep-curl">
            <line x1="108" y1="78" x2="136" y2="78" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <circle cx="138" cy="78" r="6" fill="#22c55e"/>
          </g>`;
      case 'triceps_pulley':
        return `${floor}
          <line x1="138" y1="20" x2="138" y2="76" stroke="#64748b" stroke-width="2" stroke-dasharray="3 2"/>
          <circle cx="94" cy="40" r="8" fill="#e2e8f0"/>
          <line x1="94" y1="50" x2="94" y2="92" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="94" y1="92" x2="88" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="94" y1="92" x2="102" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <line x1="98" y1="56" x2="108" y2="74" stroke="#cbd5e1" stroke-width="5" stroke-linecap="round"/>
          <g class="ex-tricep-push">
            <line x1="108" y1="74" x2="134" y2="74" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <circle cx="136" cy="74" r="5" fill="#22c55e"/>
          </g>`;
      case 'triceps_testa':
        return `${floor}
          <rect x="48" y="106" width="96" height="8" rx="3" fill="#475569"/>
          <circle cx="64" cy="96" r="8" fill="#e2e8f0"/>
          <line x1="72" y1="100" x2="128" y2="100" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <line x1="78" y1="100" x2="78" y2="82" stroke="#cbd5e1" stroke-width="5" stroke-linecap="round"/>
          <g class="ex-tricep-testa">
            <line x1="78" y1="82" x2="78" y2="54" stroke="#38bdf8" stroke-width="5" stroke-linecap="round"/>
            <circle cx="78" cy="52" r="5" fill="#22c55e"/>
          </g>`;
      case 'abdominal_supra':
        return `${floor}
          <line x1="115" y1="124" x2="152" y2="104" stroke="#94a3b8" stroke-width="7" stroke-linecap="round"/>
          <line x1="152" y1="104" x2="164" y2="134" stroke="#94a3b8" stroke-width="6" stroke-linecap="round"/>
          <g class="ex-crunch">
            <line x1="72" y1="124" x2="115" y2="124" stroke="#38bdf8" stroke-width="8" stroke-linecap="round"/>
            <circle cx="62" cy="120" r="8" fill="#e2e8f0"/>
          </g>`;
      case 'prancha':
        return `${floor}
          <circle cx="58" cy="100" r="8" fill="#e2e8f0"/>
          <line x1="66" y1="106" x2="146" y2="124" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <line x1="72" y1="108" x2="70" y2="134" stroke="#cbd5e1" stroke-width="5" stroke-linecap="round"/>
          <rect x="86" y="96" width="44" height="6" rx="3" fill="#22c55e" class="ex-plank-pulse"/>`;
      case 'esteira_corrida':
        return `${floor}
          <line x1="60" y1="128" x2="140" y2="128" stroke="#475569" stroke-width="7" stroke-linecap="round"/>
          <circle cx="100" cy="44" r="8" fill="#e2e8f0"/>
          <line x1="100" y1="54" x2="100" y2="92" stroke="#e2e8f0" stroke-width="9" stroke-linecap="round"/>
          <line x1="100" y1="92" x2="88" y2="124" stroke="#38bdf8" stroke-width="6" stroke-linecap="round" class="ex-run-leg-a"/>
          <line x1="100" y1="92" x2="112" y2="124" stroke="#22c55e" stroke-width="6" stroke-linecap="round" class="ex-run-leg-b"/>`;
      case 'bicicleta':
        return `${floor}
          <circle cx="64" cy="116" r="16" fill="none" stroke="#475569" stroke-width="4"/>
          <circle cx="136" cy="116" r="16" fill="none" stroke="#475569" stroke-width="4"/>
          <line x1="76" y1="116" x2="112" y2="116" stroke="#64748b" stroke-width="4"/>
          <circle cx="104" cy="54" r="8" fill="#e2e8f0"/>
          <line x1="100" y1="64" x2="90" y2="96" stroke="#e2e8f0" stroke-width="8" stroke-linecap="round"/>
          <g class="ex-bike-pedal">
            <circle cx="112" cy="116" r="10" fill="none" stroke="#38bdf8" stroke-width="3"/>
            <circle cx="122" cy="116" r="3" fill="#22c55e"/>
          </g>`;
      default:
        return `${floor}
          <g class="ex-squat-body">
            <circle cx="100" cy="44" r="9" fill="#e2e8f0"/>
            <line x1="100" y1="55" x2="100" y2="94" stroke="#38bdf8" stroke-width="9" stroke-linecap="round"/>
            <line x1="80" y1="66" x2="120" y2="66" stroke="#22c55e" stroke-width="5" stroke-linecap="round"/>
            <line x1="100" y1="94" x2="88" y2="134" stroke="#cbd5e1" stroke-width="6" stroke-linecap="round"/>
            <line x1="100" y1="94" x2="112" y2="134" stroke="#cbd5e1" stroke-width="6" stroke-linecap="round"/>
          </g>`;
    }
  }

  function renderExerciseAnimation(key, { size = 'md', speed = 1, paused = false, allowMotion = false } = {}) {
    ensureExerciseStyles();
    size = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
    if (findExercise(key).key === 'custom') return `<div class="ex-anim-wrap size-${size}"><span class="ex-anim-placeholder">Sem animação</span></div>`;
    const dur = Math.max(0.5, 2.2 / Number(speed || 1)).toFixed(2) + 's';
    return `<div class="ex-anim-wrap size-${size} ${paused ? 'is-paused' : ''} ${allowMotion ? 'allow-motion' : ''}" style="--ex-dur:${dur}">
      <svg class="ex-anim-svg" viewBox="0 0 200 150" aria-hidden="true">${svgScene(key)}</svg>
    </div>`;
  }

  function findExercise(key) {
    return EXERCISE_CATALOG.find((e) => e.key === key) || EXERCISE_CATALOG[EXERCISE_CATALOG.length - 1];
  }

  global.EXERCISE_LIBRARY = {
    EXERCISE_CATALOG,
    WORKOUT_EXAMPLES,
    renderExerciseAnimation,
    findExercise,
  };
})(typeof window !== 'undefined' ? window : globalThis);
