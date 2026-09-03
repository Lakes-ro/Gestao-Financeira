/**
 * PLANEJAMENTOS.JS — Módulo: Planejamentos (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, currentAdmin, allClientes,
 *             loadAllClientes, openModal, closeModal,
 *             showToast, formatCurrency, formatDate (admin.js)
 *
 * ═══════════════════════════════════════════════════════════════
 * CORREÇÃO CRÍTICA — `planejamentos.admin_id` NÃO EXISTE:
 * ═══════════════════════════════════════════════════════════════
 * A versão anterior filtrava/gravava `planejamentos` usando uma
 * coluna `admin_id` — confirmado ao vivo via Supabase MCP
 * (information_schema): essa coluna NUNCA existiu na tabela. A tabela
 * só tem `client_id`. Isso causava o erro 400 "column
 * planejamentos.admin_id does not exist" reportado no console, que
 * travava a aba inteira em "Carregando..." para sempre.
 *
 * A RLS de `planejamentos` (`planejamentos_admin_all`) também nunca
 * checou uma coluna admin_id — ela sempre validou via JOIN:
 *   EXISTS (SELECT 1 FROM clientes c WHERE c.id = planejamentos.client_id
 *           AND c.admin_id = auth.uid())
 * ou seja, o "dono" de um planejamento é definido por QUEM É O DONO DO
 * CLIENTE (clientes.admin_id), nunca por uma coluna direta em
 * planejamentos. A correção segue exatamente esse mesmo modelo usado
 * por metas.js: carrega os clientes do admin primeiro, e filtra
 * planejamentos por `client_id IN (clientIds)` — nunca por admin_id.
 *
 * ═══════════════════════════════════════════════════════════════
 * NOVO — RESOLVER "SOLICITAÇÕES PENDENTES":
 * ═══════════════════════════════════════════════════════════════
 * O bloco "📩 Solicitações Pendentes" já existia no HTML (admin.html)
 * mas nunca foi de fato implementado neste arquivo — ficava preso em
 * "Carregando..." também. Agora:
 *   - renderSolicitacoesPendentes() busca em `solicitacoes_planejamento`
 *     (status = 'pendente') e mostra um card por cliente com a
 *     mensagem que ele mandou (se houver).
 *   - "📋 Criar Planejamento" abre o modal já com aquele cliente
 *     pré-selecionado, e guarda o id da solicitação; ao salvar o
 *     planejamento com sucesso, a solicitação é marcada como
 *     'atendida' automaticamente.
 *   - "✕ Descartar" marca a solicitação como 'atendida' sem criar
 *     nenhum planejamento (ex: pedido duplicado, ou já resolvido por
 *     fora).
 *
 * ═══════════════════════════════════════════════════════════════
 * NOVO — ANÁLISE AUTOMÁTICA DETALHADA NO PLANEJAMENTO:
 * ═══════════════════════════════════════════════════════════════
 * carregarResumoFinanceiro() antes só calculava renda ativa/passiva/
 * total e despesa total (números soltos, sem contexto). Agora ela:
 *   1. Busca as transações já com o JOIN de categorias(nome, grupo)
 *      (antes só trazia valor/tipo) — necessário pra quebrar a
 *      despesa por grupo (essencial, estilo de vida, investimento,
 *      dívida), exatamente como dashboards.js já faz.
 *   2. Preenche um novo grid "Distribuição do Orçamento" no modal,
 *      com o valor de cada grupo.
 *   3. Gera um texto de análise BEM mais detalhado que o do
 *      dashboard — gerarAnaliseDetalhadaPlanejamento() — organizado
 *      em seções (Diagnóstico Geral, Distribuição do Orçamento,
 *      comparação com a referência 50/30/20, Maiores Gastos,
 *      Prioridades Sugeridas) e mostra num bloco de texto no modal.
 *   4. Um botão "📋 Usar como base nas Recomendações" copia esse
 *      texto gerado direto pro campo "Recomendações" — o admin edita
 *      livremente antes de salvar, o sistema só dá o ponto de
 *      partida (nunca substitui o julgamento do admin).
 */

let planejamentoSolicitacaoIdAtual = null; // solicitação sendo resolvida pelo modal aberto no momento (ou null)
let planejamentoAnaliseTextoAtual  = '';   // último texto de análise gerado (usado pelo botão "usar como base")

function initPlanejamentos() {
  document.getElementById('btn-add-planejamento')
    ?.addEventListener('click', () => abrirModalPlanejamento(null));

  document.getElementById('btn-salvar-planejamento')
    ?.addEventListener('click', salvarPlanejamento);

  document.getElementById('planejamento-cliente-select')
    ?.addEventListener('change', (e) => carregarResumoFinanceiro(e.target.value));

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'planejamentos') {
      renderSolicitacoesPendentes();
      renderPlanejamentos();
    }
  });

  renderSolicitacoesPendentes();
  renderPlanejamentos();
}

// ── Solicitações Pendentes ──────────────────────────────────────
async function renderSolicitacoesPendentes() {
  const grid = document.getElementById('solicitacoes-planejamento-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const { data, error } = await supabaseClient
    .from('solicitacoes_planejamento')
    .select('id, client_id, mensagem, status, created_at')
    .eq('status', 'pendente')
    .order('created_at', { ascending: false });

  if (error) {
    grid.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
    console.error('❌ renderSolicitacoesPendentes:', error.message);
    return;
  }

  if (!data?.length) {
    grid.innerHTML = '<p class="empty-state">Nenhuma solicitação pendente. 🎉</p>';
    return;
  }

  grid.innerHTML = data.map(s => {
    const cliente = allClientes.find(c => c.id === s.client_id);
    return `
      <div class="card card--pendente">
        <div class="card-header-row">
          <div>
            <p class="card-name">${cliente?.nome || 'Cliente desconhecido'}</p>
            <p class="card-sub">Solicitado em ${formatDate(s.created_at)}</p>
            ${s.mensagem ? `<p class="card-sub" style="margin-top:6px; font-style:italic;">"${s.mensagem}"</p>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-card confirmar btn-atender-solicitacao" data-id="${s.id}" data-client-id="${s.client_id}">📋 Criar Planejamento</button>
          <button class="btn-card deletar btn-descartar-solicitacao" data-id="${s.id}">✕ Descartar</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.btn-atender-solicitacao').forEach(btn => {
    btn.addEventListener('click', () => {
      abrirModalPlanejamento(null, {
        clientIdPreSelecionado: btn.dataset.clientId,
        solicitacaoId: btn.dataset.id
      });
    });
  });

  grid.querySelectorAll('.btn-descartar-solicitacao').forEach(btn => {
    btn.addEventListener('click', () => descartarSolicitacao(btn.dataset.id));
  });
}

async function descartarSolicitacao(id) {
  if (!confirm('Descartar esta solicitação sem criar um planejamento?')) return;

  const { error } = await supabaseClient
    .from('solicitacoes_planejamento')
    .update({ status: 'atendida' })
    .eq('id', id);

  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  showToast('Solicitação descartada.');
  renderSolicitacoesPendentes();
}

// ── Renderiza lista de planejamentos ────────────────────────────
async function renderPlanejamentos() {
  const lista = document.getElementById('planejamentos-list');
  if (!lista) return;
  lista.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const clienteIds = allClientes.map(c => c.id);
  if (!clienteIds.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado ainda.</p>';
    return;
  }

  // client_id IN (clientIds) — NUNCA filtrar por admin_id (não existe
  // nesta tabela, ver nota no cabeçalho do arquivo).
  const { data, error } = await supabaseClient
    .from('planejamentos')
    .select('id, titulo, recomendacoes, detalhes, client_id, created_at')
    .in('client_id', clienteIds)
    .order('created_at', { ascending: false });

  if (error) { showToast('Erro ao carregar: ' + error.message, 'error'); return; }

  if (!data?.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum planejamento criado.</p>';
    return;
  }

  lista.innerHTML = data.map(p => {
    const cliente = allClientes.find(c => c.id === p.client_id);
    return `
      <div class="planejamento-card">
        <div class="planejamento-info">
          <h4>${p.titulo}</h4>
          <p>Cliente: ${cliente?.nome || '—'} · Criado em ${formatDate(p.created_at)}</p>
        </div>
        <div class="planejamento-actions">
          <button class="btn-card editar"  data-id="${p.id}">✏️ Editar</button>
          <button class="btn-card deletar" data-id="${p.id}" data-titulo="${p.titulo}">🗑️ Deletar</button>
        </div>
      </div>
    `;
  }).join('');

  lista.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: p, error: err } = await supabaseClient.from('planejamentos').select('*').eq('id', btn.dataset.id).single();
      if (err) { showToast('Erro ao carregar: ' + err.message, 'error'); return; }
      if (p) abrirModalPlanejamento(p);
    });
  });

  lista.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => deletarPlanejamento(btn.dataset.id, btn.dataset.titulo));
  });
}

// ── Modal planejamento ────────────────────────────────────────
/**
 * @param {Object|null} plan - planejamento existente (edição) ou null (novo)
 * @param {Object} [opts]
 * @param {string} [opts.clientIdPreSelecionado] - cliente já escolhido (vindo de uma solicitação)
 * @param {string} [opts.solicitacaoId] - id da solicitação sendo resolvida por este planejamento
 */
async function abrirModalPlanejamento(plan, opts = {}) {
  if (!allClientes.length) await loadAllClientes();

  planejamentoSolicitacaoIdAtual = opts.solicitacaoId || null;

  document.getElementById('modal-planejamento-title').textContent =
    plan ? '✏️ Editar Planejamento' : '📋 Criar Planejamento';

  document.getElementById('planejamento-id').value            = plan?.id            || '';
  document.getElementById('planejamento-titulo').value        = plan?.titulo        || 'Planejamento mensal';
  document.getElementById('planejamento-recomendacoes').value = plan?.recomendacoes || '';
  document.getElementById('planejamento-detalhes').value      = plan?.detalhes      || '';

  const select = document.getElementById('planejamento-cliente-select');
  const clienteAlvo = plan?.client_id || opts.clientIdPreSelecionado;
  select.innerHTML = allClientes.map(c =>
    `<option value="${c.id}" ${clienteAlvo === c.id ? 'selected' : ''}>${c.nome}</option>`
  ).join('');

  resetResumo();
  const clienteId = clienteAlvo || allClientes[0]?.id;
  if (clienteId) carregarResumoFinanceiro(clienteId);

  openModal('modal-planejamento');
}

// ── Resumo financeiro do cliente + análise detalhada ────────────
async function carregarResumoFinanceiro(clienteId) {
  if (!clienteId) { resetResumo(); return; }

  const { data: transacoes, error } = await supabaseClient
    .from('transacoes')
    .select('valor, tipo, categorias(nome, grupo)')
    .eq('client_id', clienteId);

  if (error) {
    console.error('❌ carregarResumoFinanceiro:', error.message);
    resetResumo();
    return;
  }

  if (!transacoes?.length) { resetResumo(); return; }

  // Transferências internas não são receita nem despesa de verdade —
  // mesma regra usada no dashboard.js do cliente e no admin/dashboards.js.
  const semTransferencias = transacoes.filter(t => t.categorias?.grupo !== 'transferencia');

  const receitas = semTransferencias.filter(t => t.tipo === 'receita');
  const despesas = semTransferencias.filter(t => t.tipo === 'despesa');

  const totalReceita = receitas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const totalDespesa = despesas.reduce((s, t) => s + Math.abs(t.valor), 0);
  const rendaPassiva = 0;
  const rendaAtiva   = totalReceita;

  const custoEssencial = despesas
    .filter(t => t.categorias?.grupo === 'essencial')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const aportesInvestimento = despesas
    .filter(t => t.categorias?.grupo === 'investimento')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const custoDivida = despesas
    .filter(t => t.categorias?.grupo === 'divida')
    .reduce((s, t) => s + Math.abs(t.valor), 0);

  const estiloDeVida = Math.max(0, totalDespesa - custoEssencial - aportesInvestimento - custoDivida);
  const saldo         = totalReceita - totalDespesa;
  const taxaPoupanca   = totalReceita > 0 ? (saldo / totalReceita) * 100 : 0;

  // Resumo básico (grid já existente)
  document.getElementById('plan-renda-ativa').textContent   = formatCurrency(rendaAtiva);
  document.getElementById('plan-renda-passiva').textContent = formatCurrency(rendaPassiva);
  document.getElementById('plan-renda-total').textContent   = formatCurrency(totalReceita);
  document.getElementById('plan-despesa-total').textContent = formatCurrency(totalDespesa);

  const elSaldo = document.getElementById('plan-saldo');
  const elTaxa  = document.getElementById('plan-taxa-poupanca');
  if (elSaldo) {
    elSaldo.textContent = formatCurrency(saldo);
    elSaldo.className   = `summary-value ${saldo >= 0 ? 'green' : 'red'}`;
  }
  if (elTaxa) elTaxa.textContent = taxaPoupanca.toFixed(1) + '%';

  // Distribuição do orçamento (grid novo)
  const elEssencial    = document.getElementById('plan-custo-essencial');
  const elEstiloVida   = document.getElementById('plan-estilo-vida');
  const elInvestimento = document.getElementById('plan-investimentos-valor');
  const elDivida        = document.getElementById('plan-dividas-valor');
  if (elEssencial)    elEssencial.textContent    = formatCurrency(custoEssencial);
  if (elEstiloVida)   elEstiloVida.textContent   = formatCurrency(estiloDeVida);
  if (elInvestimento) elInvestimento.textContent = formatCurrency(aportesInvestimento);
  if (elDivida)         elDivida.textContent       = formatCurrency(custoDivida);

  // Maiores gastos por categoria (usado na análise em texto)
  const categoriaMap = {};
  despesas.forEach(t => {
    const cat = t.categorias?.nome || 'Sem Categoria';
    categoriaMap[cat] = (categoriaMap[cat] || 0) + Math.abs(t.valor);
  });
  const topCategorias = Object.entries(categoriaMap).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const metrics = {
    totalReceita, totalDespesa, custoEssencial, estiloDeVida,
    aportesInvestimento, custoDivida, saldo, taxaPoupanca
  };

  planejamentoAnaliseTextoAtual = gerarAnaliseDetalhadaPlanejamento(metrics, topCategorias);
  renderAnalisePlanejamento(planejamentoAnaliseTextoAtual);
}

function resetResumo() {
  ['plan-renda-ativa','plan-renda-passiva','plan-renda-total','plan-despesa-total',
   'plan-saldo','plan-custo-essencial','plan-estilo-vida','plan-investimentos-valor','plan-dividas-valor'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatCurrency(0);
  });

  const elTaxa = document.getElementById('plan-taxa-poupanca');
  if (elTaxa) elTaxa.textContent = '0%';

  planejamentoAnaliseTextoAtual = '';
  renderAnalisePlanejamento('');
}

// ══════════════════════════════════════════════════════════════
// ANÁLISE AUTOMÁTICA DETALHADA
// ══════════════════════════════════════════════════════════════
/**
 * Gera um texto multi-seção com o diagnóstico financeiro do cliente,
 * pensado pra servir como PONTO DE PARTIDA do campo "Recomendações"
 * do planejamento (não é uma recomendação de investimento específica
 * — são orientações gerais de organização orçamentária, com base
 * exclusivamente nos números já lançados pelo próprio cliente).
 */
function gerarAnaliseDetalhadaPlanejamento(m, topCategorias) {
  const percEssencial    = m.totalReceita > 0 ? (m.custoEssencial       / m.totalReceita) * 100 : 0;
  const percEstiloVida   = m.totalReceita > 0 ? (m.estiloDeVida         / m.totalReceita) * 100 : 0;
  const percInvestimento = m.totalReceita > 0 ? (m.aportesInvestimento  / m.totalReceita) * 100 : 0;
  const percDivida       = m.totalReceita > 0 ? (m.custoDivida          / m.totalReceita) * 100 : 0;

  const linhas = [];

  // ── Diagnóstico geral ──
  linhas.push('📊 DIAGNÓSTICO GERAL');
  linhas.push(
    m.saldo >= 0
      ? `A renda total do cliente é ${formatCurrency(m.totalReceita)} e as despesas somam ${formatCurrency(m.totalDespesa)}, resultando em um saldo positivo de ${formatCurrency(m.saldo)} (taxa de poupança de ${m.taxaPoupanca.toFixed(1)}%).`
      : `A renda total do cliente é ${formatCurrency(m.totalReceita)}, mas as despesas somam ${formatCurrency(m.totalDespesa)} — um saldo NEGATIVO de ${formatCurrency(Math.abs(m.saldo))}. Este é o ponto mais urgente a resolver antes de qualquer outra recomendação.`
  );
  linhas.push('');

  // ── Distribuição do orçamento ──
  linhas.push('📐 DISTRIBUIÇÃO DO ORÇAMENTO');
  linhas.push(`• Essencial (moradia, contas, alimentação, saúde, transporte): ${formatCurrency(m.custoEssencial)} — ${percEssencial.toFixed(1)}% da renda.`);
  linhas.push(`• Estilo de Vida (lazer, delivery, compras, assinaturas): ${formatCurrency(m.estiloDeVida)} — ${percEstiloVida.toFixed(1)}% da renda.`);
  linhas.push(`• Investimentos e Reserva: ${formatCurrency(m.aportesInvestimento)} — ${percInvestimento.toFixed(1)}% da renda.`);
  if (m.custoDivida > 0) {
    linhas.push(`• Dívidas e Financiamentos: ${formatCurrency(m.custoDivida)} — ${percDivida.toFixed(1)}% da renda.`);
  }
  linhas.push('');

  // ── Comparação com referência 50/30/20 ──
  linhas.push('📏 COMPARAÇÃO COM A REFERÊNCIA 50/30/20');
  linhas.push('Como referência geral (não é uma regra fixa): até 50% essencial, até 30% estilo de vida, ao menos 20% investimentos.');
  if (percEssencial > 50) {
    linhas.push(`→ O essencial está ${(percEssencial - 50).toFixed(1)} pontos percentuais acima da referência — vale revisar contas fixas.`);
  }
  if (percEstiloVida > 30) {
    linhas.push(`→ O estilo de vida está ${(percEstiloVida - 30).toFixed(1)} pontos percentuais acima da referência — é o grupo com mais espaço para ajuste rápido.`);
  }
  if (percInvestimento < 20) {
    linhas.push(`→ Os investimentos estão ${(20 - percInvestimento).toFixed(1)} pontos percentuais abaixo da referência — pode ser um objetivo de médio prazo.`);
  }
  if (percEssencial <= 50 && percEstiloVida <= 30 && percInvestimento >= 20) {
    linhas.push('→ A distribuição do orçamento já está dentro (ou melhor do que) a referência em todos os grupos. 👏');
  }
  linhas.push('');

  // ── Maiores gastos ──
  if (topCategorias.length) {
    linhas.push('🔎 MAIORES GASTOS DO PERÍODO');
    topCategorias.slice(0, 5).forEach(([nome, valor]) => {
      linhas.push(`• ${nome}: ${formatCurrency(valor)}`);
    });
    linhas.push('');
  }

  // ── Prioridades sugeridas ──
  linhas.push('✅ PRIORIDADES SUGERIDAS');
  const prioridades = [];

  if (m.saldo < 0) {
    prioridades.push('Cortar despesas imediatamente até o saldo ficar positivo — comece pelos maiores gastos de Estilo de Vida listados acima.');
  }
  if (m.aportesInvestimento <= 0) {
    prioridades.push('Iniciar uma Reserva de Emergência, mesmo que com um valor pequeno todo mês — é a base antes de qualquer outro investimento.');
  } else if (percInvestimento < 10) {
    prioridades.push('Aumentar gradualmente o aporte mensal em investimentos/reserva até atingir 10%-20% da renda.');
  }
  if (m.custoDivida > 0 && percDivida > 20) {
    prioridades.push('Priorizar a quitação das dívidas com juros mais altos antes de aumentar outros investimentos.');
  }
  if (percEssencial > 50) {
    prioridades.push('Revisar contratos e assinaturas fixas (internet, plano de saúde, aluguel, etc.) em busca de opções mais baratas.');
  }
  if (percEstiloVida > 30) {
    prioridades.push('Definir um limite mensal para delivery/lazer/compras e acompanhar pelo Histórico do app.');
  }
  if (m.saldo >= 0 && m.taxaPoupanca >= 20 && !prioridades.length) {
    prioridades.push('O cliente já tem uma boa taxa de poupança e uma distribuição saudável — o foco pode ser diversificar/revisar periodicamente onde esse dinheiro está sendo investido.');
  }

  if (!prioridades.length) {
    prioridades.push('Nenhum ponto crítico identificado com os dados atuais — manter o acompanhamento mensal.');
  }

  prioridades.forEach((p, i) => linhas.push(`${i + 1}. ${p}`));

  return linhas.join('\n');
}

function renderAnalisePlanejamento(texto) {
  const bloco     = document.getElementById('planejamento-analise-bloco');
  const container = document.getElementById('planejamento-analise-texto');
  if (!bloco || !container) return;

  if (!texto) {
    bloco.classList.add('hidden');
    container.textContent = '';
    return;
  }

  container.textContent = texto;
  bloco.classList.remove('hidden');
}

/**
 * Copia o texto de análise gerado automaticamente para o campo
 * "Recomendações" do planejamento. Se o campo já tiver algo escrito,
 * pede confirmação antes de sobrescrever — nunca apaga o trabalho do
 * admin sem avisar.
 */
function inserirAnaliseNasRecomendacoes() {
  if (!planejamentoAnaliseTextoAtual) return;

  const textarea = document.getElementById('planejamento-recomendacoes');
  if (!textarea) return;

  if (textarea.value.trim() && !confirm('Já existe um texto no campo Recomendações. Deseja SUBSTITUIR pelo texto gerado automaticamente?')) {
    return;
  }

  textarea.value = planejamentoAnaliseTextoAtual;
  textarea.focus();
  showToast('Análise inserida nas Recomendações — edite como preferir antes de salvar.');
}

// ── Salva planejamento ────────────────────────────────────────
async function salvarPlanejamento() {
  const id            = document.getElementById('planejamento-id').value;
  const titulo        = document.getElementById('planejamento-titulo').value.trim();
  const recomendacoes = document.getElementById('planejamento-recomendacoes').value.trim();
  const detalhes      = document.getElementById('planejamento-detalhes').value.trim();
  const clienteId     = document.getElementById('planejamento-cliente-select').value;

  if (!titulo)    { showToast('Informe o título.', 'error');     return; }
  if (!clienteId) { showToast('Selecione um cliente.', 'error'); return; }

  // client_id apenas — NUNCA admin_id (coluna não existe nesta
  // tabela, ver nota no cabeçalho do arquivo).
  const payload = {
    titulo,
    recomendacoes: recomendacoes || null,
    detalhes:      detalhes      || null,
    client_id:     clienteId,
  };

  const btn = document.getElementById('btn-salvar-planejamento');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('planejamentos').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('planejamentos').insert(payload));
  }

  if (error) {
    showToast('Erro: ' + error.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
    return;
  }

  // Se este planejamento resolveu uma solicitação pendente do
  // cliente, marca a solicitação como atendida — evita o admin ter
  // que lembrar de ir descartar manualmente depois de já ter criado
  // o planejamento correspondente.
  if (planejamentoSolicitacaoIdAtual) {
    await supabaseClient
      .from('solicitacoes_planejamento')
      .update({ status: 'atendida' })
      .eq('id', planejamentoSolicitacaoIdAtual);
    planejamentoSolicitacaoIdAtual = null;
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }

  showToast(id ? 'Planejamento atualizado!' : 'Planejamento criado!');
  closeModal('modal-planejamento');
  renderPlanejamentos();
  renderSolicitacoesPendentes();
}

async function deletarPlanejamento(id, titulo) {
  if (!confirm(`Deletar o planejamento "${titulo}"?`)) return;
  const { error } = await supabaseClient.from('planejamentos').delete().eq('id', id);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }
  showToast('Planejamento removido.');
  renderPlanejamentos();
}

console.log('✅ planejamentos.js carregado (solicitações + análise automática detalhada)');