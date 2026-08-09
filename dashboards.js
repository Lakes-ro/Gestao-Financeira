let chartDonut = null;
let chartBar   = null;

function initDashboards() {
  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'dashboards') renderDashboards();
  });
  renderDashboards();
}

async function renderDashboards() {
  const grid = document.getElementById('dashboards-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  if (!allClientes.length) {
    grid.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado.</p>';
    return;
  }

  const clienteIds = allClientes.map(c => c.id);
  const riscos     = await calcularRiscosPorCliente(clienteIds);

  grid.innerHTML = allClientes.map(c => {
    const risco = riscos[c.id] || classificarRisco([]);
    return `
    <div class="card">
      <div class="card-header-row">
        <div>
          <p class="card-name">${c.nome}</p>
          <p class="card-sub">${c.email || 'Sem email'}</p>
        </div>
        <span class="risk-badge ${risco.classe}" title="Classificação de risco financeiro">${risco.emoji} ${risco.label}</span>
      </div>
      <div class="card-actions" style="margin-top:auto;">
        <button class="btn-card ver-dashboard" data-id="${c.id}" data-nome="${c.nome}">
          📊 Ver Dashboard
        </button>
      </div>
    </div>
  `;
  }).join('');

  grid.querySelectorAll('.btn-card.ver-dashboard').forEach(btn => {
    btn.addEventListener('click', () => abrirDashboard(btn.dataset.id, btn.dataset.nome));
  });
}

async function calcularRiscosPorCliente(clienteIds) {
  const riscos = {};
  clienteIds.forEach(id => { riscos[id] = classificarRisco([]); });

  if (!clienteIds.length) return riscos;

  const { data, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, client_id, categorias(grupo)')
    .in('client_id', clienteIds);

  if (error) {
    console.error('❌ calcularRiscosPorCliente:', error.message);
    return riscos;
  }

  const porCliente = {};
  (data || []).forEach(t => {
    if (!porCliente[t.client_id]) porCliente[t.client_id] = [];
    porCliente[t.client_id].push(t);
  });

  clienteIds.forEach(id => {
    riscos[id] = classificarRisco(porCliente[id] || []);
  });

  return riscos;
}

function classificarRisco(transacoes) {
  // Transferências internas não são receita nem despesa de verdade —
  // excluídas antes de qualquer cálculo (mesma regra do resto do app).
  const semTransferencias = transacoes.filter(t => t.categorias?.grupo !== 'transferencia');

  if (!semTransferencias.length) {
    return { classe: 'cinza', emoji: '⚪', label: 'Sem dados' };
  }

  let totalReceita = 0, totalDespesa = 0;

  semTransferencias.forEach(t => {
    const valor = Math.abs(parseFloat(t.valor) || 0);
    if (t.tipo === 'receita') totalReceita += valor;
    else                      totalDespesa += valor;
  });

  const saldo        = totalReceita - totalDespesa;
  const taxaPoupanca  = totalReceita > 0 ? (saldo / totalReceita) * 100 : 0;

  if (saldo < 0)           return { classe: 'vermelho', emoji: '🔴', label: 'Risco Alto' };
  if (taxaPoupanca < 10)   return { classe: 'amarelo',  emoji: '🟡', label: 'Atenção'    };
  return                          { classe: 'verde',    emoji: '🟢', label: 'Saudável'   };
}

async function abrirDashboard(clienteId, nome) {
  document.getElementById('modal-dashboard-title').textContent = `📊 Dashboard: ${nome}`;
  ['kpi-sobrevivencia','kpi-estilo','kpi-investimentos','kpi-poupanca'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '...';
  });
  openModal('modal-dashboard');

  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  if (chartBar)   { chartBar.destroy();   chartBar   = null; }

  const { data: transacoes, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, descricao, data_competencia, categorias(nome, grupo)')
    .eq('client_id', clienteId)
    .order('data_competencia', { ascending: false });

  if (error) { showToast('Erro ao carregar dados: ' + error.message, 'error'); return; }
  calcularEExibir(transacoes || []);
}

function calcularEExibir(transacoes) {
  // Transferências internas (grupo 'transferencia') não são receita
  // nem despesa de verdade — dinheiro só mudou de lugar. Filtradas
  // FORA antes de qualquer cálculo, para não inflar nem distorcer
  // nenhuma métrica abaixo (mesma regra do dashboard.js do cliente).
  const semTransferencias = transacoes.filter(t => t.categorias?.grupo !== 'transferencia');

  const receitas = semTransferencias.filter(t => t.tipo === 'receita');
  const despesas = semTransferencias.filter(t => t.tipo === 'despesa');

  const totalReceita = receitas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const totalDespesa = despesas.reduce((s, t) => s + Math.abs(t.valor), 0);

  const custoSobrevivencia = despesas
    .filter(t => t.categorias?.grupo === 'essencial')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const aportesInvestimento = despesas
    .filter(t => t.categorias?.grupo === 'investimento')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  // Dívidas e Financiamentos: isolado do Custo Essencial e do Estilo
  // de Vida — pagar um empréstimo não é a mesma coisa que sobrevivência
  // nem lazer, e misturar os dois distorce as duas métricas.
  const custoDivida = despesas
    .filter(t => t.categorias?.grupo === 'divida')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const estiloDeVida = Math.max(0, totalDespesa - custoSobrevivencia - aportesInvestimento - custoDivida);
  const saldo        = totalReceita - totalDespesa;
  const taxaPoupanca  = totalReceita > 0 ? Math.max(0, (saldo / totalReceita) * 100) : 0;

  document.getElementById('kpi-sobrevivencia').textContent  = formatCurrency(custoSobrevivencia);
  document.getElementById('kpi-estilo').textContent         = formatCurrency(estiloDeVida);
  document.getElementById('kpi-investimentos').textContent  = formatCurrency(aportesInvestimento);
  document.getElementById('kpi-dividas').textContent         = formatCurrency(custoDivida);
  document.getElementById('kpi-poupanca').textContent       = taxaPoupanca.toFixed(1) + '%';

  renderDonut(custoSobrevivencia, estiloDeVida, aportesInvestimento);

  const categoriaMap = {};
  despesas.forEach(t => {
    const cat = t.categorias?.nome || 'Sem Categoria';
    categoriaMap[cat] = (categoriaMap[cat] || 0) + Math.abs(t.valor);
  });
  const topCats = Object.entries(categoriaMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  renderBarChart(topCats);

  renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, custoDivida, semTransferencias.length);
}

function renderDonut(essencial, estiloVida, investimento) {
  const ctx = document.getElementById('chart-donut');
  if (!ctx) return;
  chartDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Essencial', 'Estilo de Vida', 'Investimentos'],
      datasets: [{ data: [essencial || 0.001, estiloVida || 0.001, investimento || 0.001],
        backgroundColor: ['#ff6384', '#f5d623', '#00f5a0'], borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6b9e84', font: { size: 11 }, padding: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => ` ${formatCurrency(ctx.parsed)}` } }
      }
    }
  });
}

function renderBarChart(topCats) {
  const ctx = document.getElementById('chart-bar');
  if (!ctx) return;
  chartBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topCats.map(([cat]) => cat),
      datasets: [{ label: 'Valor (R$)', data: topCats.map(([,val]) => val),
        backgroundColor: '#4263eb', borderRadius: 4, borderSkipped: false }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#6b9e84', font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ` ${formatCurrency(ctx.parsed.x)}` } }
      },
      scales: {
        x: { ticks: { color: '#3d6352', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#6b9e84', font: { size: 11 } }, grid: { display: false } }
      }
    }
  });
}

function renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, custoDivida, totalTransacoes) {
  const grid = document.getElementById('analise-grid');
  if (!grid) return;
  const saldo        = totalReceita - totalDespesa;
  const taxaEconomia = totalReceita > 0 ? ((saldo / totalReceita) * 100).toFixed(1) : 0;

  const items = [
    { label: 'Renda Total',       value: formatCurrency(totalReceita),        color: '#00f5a0' },
    { label: 'Custo Essencial',   value: formatCurrency(custoSobrevivencia),  color: '#f5d623' },
    { label: 'Estilo de Vida',    value: formatCurrency(estiloDeVida),        color: '#ff6384' },
    { label: 'Investimentos',     value: formatCurrency(aportesInvestimento), color: '#00f5a0' },
    { label: 'Dívidas',           value: formatCurrency(custoDivida),         color: '#ff9f40' },
    { label: 'Despesa Total',     value: formatCurrency(totalDespesa),        color: '#ff4d6d' },
    { label: 'Saldo',             value: formatCurrency(saldo),               color: saldo >= 0 ? '#00f5a0' : '#ff4d6d' },
    { label: 'Taxa de Poupança',  value: taxaEconomia + '%',                  color: '#7b96ff' },
    { label: 'Transações',        value: totalTransacoes,                     color: '#6b9e84' },
  ];

  grid.innerHTML = items.map(item => `
    <div class="analise-item">
      <span class="analise-item-label">${item.label}</span>
      <span class="analise-item-value" style="color:${item.color}">${item.value}</span>
    </div>
  `).join('');
}

console.log('✅ dashboards.js carregado');
