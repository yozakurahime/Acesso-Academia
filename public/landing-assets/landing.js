function formatBrl(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function periodUnit(days) {
  const d = Number(days || 30);
  if (d >= 360) return 'ano';
  if (d >= 175) return 'semestre';
  if (d >= 85) return 'trimestre';
  if (d >= 55) return 'bimestre';
  if (d === 1) return 'diária';
  if (d >= 25 && d <= 35) return 'mês';
  return `${d} dias`;
}

function planCategory(days) {
  const d = Number(days || 30);
  if (d <= 35) return 'mensal';
  if (d <= 120) return 'pacote';
  return 'anual';
}

function escapeText(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

(async () => {
  const grid = document.getElementById('plansGrid');
  const filterWrap = document.getElementById('plansFilter');
  if (!grid) return;

  try {
    const res = await fetch('/api/public/plans', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const plans = Array.isArray(data?.plans) ? data.plans : [];
    if (plans.length === 0) return;

    let activeFilter = 'all';

    const render = () => {
      const visible = plans.filter((p) => activeFilter === 'all' || planCategory(p.duration_days) === activeFilter);
      grid.innerHTML = visible.map((p) => {
        const cleanName = String(p.name || 'Plano').trim();
        const isFeatured = /muscula[cç][aã]o\s+completo\s*\(mensal\)/i.test(cleanName);
        const unit = periodUnit(p.duration_days);
        const priceStr = formatBrl(p.price_cents);
        const tag = isFeatured ? 'Mais procurado' : (p.duration_days >= 360 ? 'Anual' : (p.duration_days >= 55 ? `${p.duration_days} dias` : 'Mensal'));
        const waText = encodeURIComponent(`Olá! Tenho interesse no plano ${cleanName} (R$ ${priceStr}).`);
        return `
          <article class="plan-card${isFeatured ? ' featured' : ''}">
            <span class="plan-tag">${escapeText(tag)}</span>
            <h3>${escapeText(cleanName)}</h3>
            <div class="plan-price">R$ ${escapeText(priceStr)} <span>/ ${escapeText(unit)}</span></div>
            <p class="plan-desc">Sem taxa de matrícula e sem fidelidade.</p>
            <a class="btn ${isFeatured ? 'btn-primary' : 'btn-secondary'}" href="https://wa.me/5562981020169?text=${waText}" target="_blank" rel="noopener">Matricular pelo WhatsApp</a>
          </article>
        `;
      }).join('');
    };

    if (filterWrap) {
      filterWrap.hidden = false;
      filterWrap.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-plan-filter]');
        if (!btn) return;
        activeFilter = btn.dataset.planFilter || 'all';
        filterWrap.querySelectorAll('[data-plan-filter]').forEach((b) => {
          const isAct = b.dataset.planFilter === activeFilter;
          b.classList.toggle('btn-primary', isAct);
          b.classList.toggle('btn-secondary', !isAct);
        });
        render();
      });
    }

    render();
  } catch {
    // Mantém os planos estáticos de fallback caso a API falhe.
  }
})();
