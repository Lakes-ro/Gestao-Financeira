/**
 * DASHBOARDS.JS — Módulo: Dashboards dos Clientes (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes,
 *             openModal, showToast, formatCurrency (admin.js)
 *
 * MIGRAÇÃO DE SCHEMA (auditoria via Supabase MCP — confirmado ao
 * vivo no banco, não suposição): todo este módulo usava
 * `plano_de_contas`, mas essa tabela tem RLS que só libera leitura
 * para o admin dono do `client_id` referenciado — e nunca tinha
 * sido populada. A tabela correta, com RLS liberado para leitura
 * autenticada e já populada com 18 categorias reais, é `categorias`
 * (colunas: nome, tipo, grupo — onde grupo ∈ {essencial,
 * estilo_de_vida, investimento, renda}).
 *
 * ISSO MUDA UMA REGRA DE NEGÓCIO: `categorias` não distingue renda
 * ativa de passiva (só existe o valor 'renda' para receitas) — o
 * antigo `plano_de_contas.tipo_renda` não tem equivalente aqui. Por
 * isso a classificação de risco, que dependia da cobertura de renda
 * passiva, foi REESCRITA para usar saldo + taxa de poupança (ambos
 * calculáveis com os dados reais que existem hoje). Se no futuro
 * `categorias` ganhar uma forma de marcar renda passiva, dá para
 * reintroduzir a cobertura como critério adicional.
 *
 * NOVO bucket 'investimento' (aportes/reserva/previdência) não
 * existia no modelo antigo — agora aparece como métrica própria,
 * nem essencial nem estilo de vida.
 */

let chartDonut = null;
let chartBar   = null;

function initDashboards() {
  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'dashboards') renderDashboards();
  });
  renderDashboards();
}

// ── Renderiza grid com selo de risco ──────────────────────────
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

// ── Cálculo de risco por cliente (query única, em lote) ───────
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

/**
 * Regra de classificação de risco (critério de negócio nosso, não
 * vem do banco; ajustável a qualquer momento se quiser outro corte):
 *
 *  🔴 Risco Alto → saldo (receita - despesa) negativo
 *  🟡 Atenção    → saldo positivo, mas taxa de poupança < 10%
 *  🟢 Saudável   → saldo positivo e taxa de poupança >= 10%
 *  ⚪ Sem dados  → cliente ainda sem transações lançadas
 */
function classificarRisco(transacoes) {
  if (!transacoes.length) {
    return { classe: 'cinza', emoji: '⚪', label: 'Sem dados' };
  }

  let totalReceita = 0, totalDespesa = 0;

  transacoes.forEach(t => {
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

// ── Modal: dashboard individual do cliente ────────────────────
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
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const despesas = transacoes.filter(t => t.tipo === 'despesa');

  const totalReceita = receitas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const totalDespesa = despesas.reduce((s, t) => s + Math.abs(t.valor), 0);

  const custoSobrevivencia = despesas
    .filter(t => t.categorias?.grupo === 'essencial')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const aportesInvestimento = despesas
    .filter(t => t.categorias?.grupo === 'investimento')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const estiloDeVida = Math.max(0, totalDespesa - custoSobrevivencia - aportesInvestimento);
  const saldo        = totalReceita - totalDespesa;
  const taxaPoupanca  = totalReceita > 0 ? Math.max(0, (saldo / totalReceita) * 100) : 0;

  document.getElementById('kpi-sobrevivencia').textContent  = formatCurrency(custoSobrevivencia);
  document.getElementById('kpi-estilo').textContent         = formatCurrency(estiloDeVida);
  document.getElementById('kpi-investimentos').textContent  = formatCurrency(aportesInvestimento);
  document.getElementById('kpi-poupanca').textContent       = taxaPoupanca.toFixed(1) + '%';

  renderDonut(custoSobrevivencia, estiloDeVida, aportesInvestimento);

  const categoriaMap = {};
  despesas.forEach(t => {
    const cat = t.categorias?.nome || 'Sem Categoria';
    categoriaMap[cat] = (categoriaMap[cat] || 0) + Math.abs(t.valor);
  });
  const topCats = Object.entries(categoriaMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  renderBarChart(topCats);

  renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, transacoes.length);
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

function renderAnalise(totalReceita, totalDespesa, custoSobrevivencia, estiloDeVida, aportesInvestimento, totalTransacoes) {
  const grid = document.getElementById('analise-grid');
  if (!grid) return;
  const saldo        = totalReceita - totalDespesa;
  const taxaEconomia = totalReceita > 0 ? ((saldo / totalReceita) * 100).toFixed(1) : 0;

  const items = [
    { label: 'Renda Total',       value: formatCurrency(totalReceita),        color: '#00f5a0' },
    { label: 'Custo Essencial',   value: formatCurrency(custoSobrevivencia),  color: '#f5d623' },
    { label: 'Estilo de Vida',    value: formatCurrency(estiloDeVida),        color: '#ff6384' },
    { label: 'Investimentos',     value: formatCurrency(aportesInvestimento), color: '#00f5a0' },
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