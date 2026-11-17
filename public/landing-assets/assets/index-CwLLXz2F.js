(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const r of document.querySelectorAll('link[rel="modulepreload"]'))i(r);new MutationObserver(r=>{for(const s of r)if(s.type==="childList")for(const n of s.addedNodes)n.tagName==="LINK"&&n.rel==="modulepreload"&&i(n)}).observe(document,{childList:!0,subtree:!0});function t(r){const s={};return r.integrity&&(s.integrity=r.integrity),r.referrerPolicy&&(s.referrerPolicy=r.referrerPolicy),r.crossOrigin==="use-credentials"?s.credentials="include":r.crossOrigin==="anonymous"?s.credentials="omit":s.credentials="same-origin",s}function i(r){if(r.ep)return;r.ep=!0;const s=t(r);fetch(r.href,s)}})();const o={academyName:"Academia Oxigenio",ctaStaffUrl:"/aluno",instagramUrl:"https://instagram.com/oxigenio2academia",mapUrl:"https://www.google.com/maps/place/Academia+Oxig%C3%AAnio/data=!4m2!3m1!1s0x0:0x7247190d43f8484d?sa=X&ved=1t:2428&ictx=111",address:"Avenida Contorno, Quadra 14, Lote 29, n 422 - Setor Jardim Colorado, Goiania - GO",openingHours:["Segunda a Sexta: 05:30 as 23:00","Sabado: 07:00 as 12:00","Feriado: 08:00 as 12:00","Domingo: Fechado"],plans:[{name:"Musculacao Completo",price:"R$ 120,00 / mes",highlight:"Plano mais procurado",details:"Inclui musculacao, capoeira e danca.",priceId:"musculacao_completo_monthly"},{name:"Hidroginastica",price:"R$ 150,00 / mes",highlight:"Piscina aquecida",details:"Seg, Qua e Sex. Recomendado para condicionamento e saude.",priceId:"hidroginastica_monthly"},{name:"Pilates",price:"R$ 120,00 / mes",highlight:"2x por semana",details:"Turmas em horarios de manha e noite.",priceId:"pilates_monthly"},{name:"Natacao Infantil e Baby",price:"R$ 140,00 / mes",highlight:"Turmas por faixa etaria",details:"Aulas de 45 min com horario fixo de frequencia.",priceId:"natacao_infantil_monthly"},{name:"Natacao Adulto",price:"R$ 140,00 / mes",highlight:"Seg e Qua",details:"Ideal para iniciantes e avancados.",priceId:"natacao_adulto_monthly"}],modalities:["Musculacao","Danca (Fit Dance)","Capoeira","Hidroginastica","Pilates","Natacao Infantil, Baby e Adulto"],faq:[{q:"Como faco a matricula?",a:'Escolha um plano e clique em "Assinar" para fazer o pagamento online com cartao de credito. Depois, basta comparecer a recepcao para finalizar com documento com foto.'},{q:"Tem taxa de matricula?",a:"Nao. A academia nao cobra taxa de matricula."},{q:"Tem fidelidade nos planos?",a:"Nao ha fidelidade. Voce pode cancelar quando quiser."},{q:"Quais formas de pagamento sao aceitas?",a:"Cartao de credito (assinatura mensal recorrente). Tambem aceitamos debito, pix e dinheiro na recepcao."}],gallery:[{title:"Musculacao orientada",image:"https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1200&q=80"},{title:"Natacao e hidroginastica",image:"https://images.unsplash.com/photo-1560090995-01632a28895b?auto=format&fit=crop&w=1200&q=80"},{title:"Pilates e mobilidade",image:"https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=1200&q=80"}]},m=`
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Academia Oxigenio</p>
      <h1>Treino, bem-estar e resultado em um ambiente que acolhe voce.</h1>
      <p class="subtitle">
        Conheca planos, modalidades e horarios. Comece sua jornada hoje com acompanhamento da equipe.
      </p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#planos">Ver planos e assinar</a>
        <a class="btn btn-ghost" href="${o.ctaStaffUrl}">Portal do Aluno</a>
      </div>
    </div>
    <div class="hero-panel">
      <h2>Horarios de funcionamento</h2>
      <ul>
        ${o.openingHours.map(a=>`<li>${a}</li>`).join("")}
      </ul>
      <p class="address">${o.address}</p>
      <a class="link" href="${o.mapUrl}" target="_blank" rel="noreferrer">Abrir no mapa</a>
    </div>
  </section>
`;function c(a){return String(a||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function u(a,e){return String(a||"").toLowerCase().replace(/[^a-z0-9_-]+/g,"_").replace(/^_+|_+$/g,"")||`plano_${e+1}`}function d(){return(Array.isArray(o.plans)?o.plans:[]).map((a,e)=>({id:u((a==null?void 0:a.priceId)||(a==null?void 0:a.id)||(a==null?void 0:a.name),e),name:String((a==null?void 0:a.name)||`Plano ${e+1}`),priceLabel:String((a==null?void 0:a.price)||(a==null?void 0:a.priceLabel)||"Consulte valores"),details:String((a==null?void 0:a.details)||""),highlight:String((a==null?void 0:a.highlight)||""),purchasable:!!String((a==null?void 0:a.priceId)||"").trim()}))}function l(a){const e=encodeURIComponent(String((a==null?void 0:a.id)||"")),t=a!=null&&a.purchasable?`<a class="btn btn-primary plan-cta" href="/painel/matricula?plano=${e}">Assinar plano</a>`:'<span class="btn btn-muted plan-cta-disabled" aria-disabled="true">Em breve</span>';return`
    <article class="card">
      <p class="chip">${c((a==null?void 0:a.highlight)||"Plano")}</p>
      <h3>${c((a==null?void 0:a.name)||"Plano")}</h3>
      <p class="price">${c((a==null?void 0:a.priceLabel)||"Consulte valores")}</p>
      <p>${c((a==null?void 0:a.details)||"")}</p>
      ${t}
    </article>
  `}const h=d().map(a=>l(a)).join(""),g=`
  <section id="planos" class="section">
    <div class="section-head">
      <h2>Planos para cada objetivo</h2>
      <p id="plans-subtitle">Escolha o plano ideal e finalize a assinatura mensal pelo cartao.</p>
    </div>
    <div id="plans-grid" class="grid plans">
      ${h}
    </div>
  </section>
`,f=`
  <section id="modalidades" class="section">
    <div class="section-head">
      <h2>Modalidades</h2>
      <p>Opcoes para condicionamento, saude e performance.</p>
    </div>
    <div class="grid two">
      <article class="card">
        <h3>Praticas disponiveis</h3>
        <ul>
          ${o.modalities.map(a=>`<li>${a}</li>`).join("")}
        </ul>
      </article>
      <article class="card">
        <h3>Matricula e suporte</h3>
        <p>
          A matricula e presencial para validar vagas e horarios. Em caso de duvidas, fale com a equipe de recepcao
          ou acesse nosso Instagram oficial.
        </p>
        <a class="link" href="${o.instagramUrl}" target="_blank" rel="noreferrer">Ir para Instagram</a>
      </article>
    </div>
  </section>
`,p=`
  <section id="estrutura" class="section">
    <div class="section-head">
      <h2>Estrutura da unidade</h2>
      <p>Imagens ilustrativas alinhadas com as modalidades oferecidas.</p>
    </div>
    <div class="gallery">
      ${o.gallery.map(a=>`
        <figure class="gallery-item">
          <img src="${a.image}" alt="${a.title}" loading="lazy" />
          <figcaption>${a.title}</figcaption>
        </figure>
      `).join("")}
    </div>
  </section>
`,b=`
  <section id="faq" class="section">
    <div class="section-head">
      <h2>Perguntas frequentes</h2>
      <p>Informacoes rapidas para facilitar sua decisao.</p>
    </div>
    <div class="faq-list">
      ${o.faq.map(a=>`
        <details class="faq-item">
          <summary>${a.q}</summary>
          <p>${a.a}</p>
        </details>
      `).join("")}
    </div>
  </section>
`,v=`
  <footer class="footer">
    <p><strong>${o.academyName}</strong> | ${o.address}</p>
    <div class="footer-actions">
      <a href="#planos">Assinar um plano</a>
      <a href="${o.ctaStaffUrl}" target="_blank" rel="noreferrer">Area de atendimento</a>
      <a href="${o.instagramUrl}" target="_blank" rel="noreferrer">Instagram</a>
    </div>
  </footer>
`;document.querySelector("#app").innerHTML=`
  <div class="page-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <strong>${o.academyName}</strong>
      </div>
      <nav>
        <a href="#planos">Planos</a>
        <a href="#modalidades">Modalidades</a>
        <a href="#estrutura">Estrutura</a>
        <a href="#faq">FAQ</a>
        <a href="/aluno">Portal do Aluno</a>
      </nav>
    </header>
    ${m}
    ${g}
    ${f}
    ${p}
    ${b}
    ${v}
  </div>
`;async function $(){const a=await fetch("/api/public/plans",{method:"GET",credentials:"same-origin"}),e=await a.json().catch(()=>({}));if(!a.ok||!(e!=null&&e.ok))throw new Error(String((e==null?void 0:e.error)||"plans_fetch_failed"));const t=Array.isArray(e==null?void 0:e.plans)?e.plans:[];return{enabled:!!(e!=null&&e.enabled),plans:t.map((i,r)=>({id:String((i==null?void 0:i.id)||`plano_${r+1}`),name:String((i==null?void 0:i.name)||`Plano ${r+1}`),priceLabel:String((i==null?void 0:i.priceLabel)||"Consulte valores"),details:String((i==null?void 0:i.details)||""),highlight:String((i==null?void 0:i.highlight)||""),purchasable:!!(i!=null&&i.purchasable)}))}}async function y(){const a=document.querySelector("#plans-grid"),e=document.querySelector("#plans-subtitle");if(a)try{const t=await $(),i=t.plans.length?t.plans:d();a.innerHTML=i.map(r=>l(r)).join(""),e&&!t.enabled&&(e.textContent="Assinaturas online temporariamente indisponiveis. Fale com a recepcao para contratar.")}catch{e&&(e.textContent="Nao foi possivel atualizar os planos agora. Exibindo tabela padrao.")}}y();
