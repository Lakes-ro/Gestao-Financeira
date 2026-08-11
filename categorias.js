/**
 * CATEGORIAS.JS — Módulo: Categorias (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes, openModal,
 *             closeModal, showToast (definidos em admin.js),
 *             obterCodigoGrupo (definido em contabilidade.js —
 *             carregado ANTES deste ficheiro).
 *
 * ATUALIZAÇÃO — PLANO DE CONTAS ROBUSTO (PALAVRAS-CHAVE/SINÔNIMOS):
 * Cada categoria agora tem uma coluna `palavras_chave` (text[]),
 * editável no modal de categoria como uma lista separada por vírgula
 * (ex: "aluguel ganho, aluguel recebido, recebimento de aluguel").
 * Isso é usado pelo Smart Input, pela importação de extrato e pela
 * criação de categoria personalizada do cliente para reconhecer a
 * descrição digitada e sugerir a categoria certa — mesmo com ordens
 * de palavras diferentes ou termos que o classificador fixo no código
 * não previu (ver smart-input.js, `encontrarCategoriaPorPalavraChave`).
 *
 * ATUALIZAÇÃO — PERFORMANCE DO "CONFIRMAR" (Pendentes de
 * Contabilização): confirmarPendenteSemAlterar() antes chamava
 * renderCategorias() inteiro após o UPDATE, o que refazia a consulta
 * completa de categorias + a lista de clientes + reconstruía as DUAS
 * grids (pendentes + geral) do zero — em conexões mais lentas isso
 * dava a sensação de "travou". Agora a mudança é aplicada de forma
 * OTIMISTA: `categoriasCache` é atualizado localmente e as grids são
 * redesenhadas na hora (sem nenhuma consulta nova), o UPDATE roda em
 * paralelo, e só reverte a UI se o servidor de fato recusar. Percebido
 * como instantâneo — mesmo padrão de responsividade que o resto do
 * app já usa em outros lugares (ex: filtros do histórico do cliente).
 *
 * ATUALIZAÇÃO — "RECEITA ANTES DE DESPESA": a consulta ordenava por
 * `tipo` ascendente ('despesa' < 'receita' alfabeticamente), mostrando
 * Despesas primeiro em toda a grid. Trocado para trazer Receita
 * primeiro, e o <select> de Tipo do modal também foi reordenado no
 * HTML (ver admin.html).
 *
 * ATUALIZAÇÃO — GRADE REORGANIZADA COMO PLANO DE CONTAS REAL:
 * `renderCategoriasFiltradas()` deixou de jogar tudo numa única grade
 * plana e passou a AGRUPAR por seção contábil, na mesma ordem/código
 * usado no Balancete (ver obterCodigoGrupo, contabilidade.js):
 *   1.1 Renda · 1.2 Transferências (receita)
 *   2.1 Essencial · 2.2 Estilo de Vida · 2.3 Investimentos ·
 *   2.4 Dívidas · 2.5 Transferências (despesa)
 * Cada categoria ganha um código de conta (ex: "2.1.03") mostrado ao
 * lado do nome. NADA foi removido: os mesmos cards, os mesmos botões
 * "✏️ Editar"/"🗑️ Deletar" com as mesmas classes/dataset (por isso os
 * listeners que já existiam continuam funcionando sem alteração), a
 * mesma busca por nome, e a seção "Pendentes de Contabilização"
 * continua exatamente onde estava — só ganhou o código contábil
 * sugerido ao lado do grupo, pra já mostrar em que seção do plano de
 * contas aquela categoria provavelmente vai cair.
 */

let categoriaEmEdicao = null;
let categoriasCache   = [];

const GRUPOS_POR_TIPO = {
  despesa: [
    { value: 'essencial',      label: 'Essencial (sobrevivência)' },
    { value: 'estilo_de_vida', label: 'Estilo de Vida' },
    { value: 'investimento',   label: 'Investimento (poupança/reserva)' },
    { value: 'divida',         label: 'Dívidas e Financiamentos' },
    { value: 'transferencia',  label: 'Transferência Interna (não conta como gasto)' },
  ],
  receita: [
    { value: 'renda',         label: 'Renda' },
    { value: 'transferencia', label: 'Transferência Interna (não conta como ganho)' },
  ],
};

const GRUPO_LABEL = {
  essencial:      '🟠 Essencial',
  estilo_de_vida: '🎯 Estilo de Vida',
  investimento:   '💰 Investimento',
  divida:         '💳 Dívidas e Financiamentos',
  transferencia:  '🔄 Transferência Interna',
  renda:          '📈 Renda',
};

// Ordem contábil das seções do Plano de Contas — mesma numeração usada
// no Balancete (1.x Receitas, 2.x Despesas). Ver obterCodigoGrupo() em
// contabilidade.js, a fonte única de verdade pro código de cada grupo.
const ORDEM_PLANO_DE_CONTAS = [
  { tipo: 'receita', grupo: 'renda' },
  { tipo: 'receita', grupo: 'transferencia' },
  { tipo: 'despesa', grupo: 'essencial' },
  { tipo: 'despesa', grupo: 'estilo_de_vida' },
  { tipo: 'despesa', grupo: 'investimento' },
  { tipo: 'despesa', grupo: 'divida' },
  { tipo: 'despesa', grupo: 'transferencia' },
];

function normalizarTextoBusca(txt) {
  return (txt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function initCategorias() {
  document.getElementById('btn-add-categoria')
    ?.addEventListener('click', () => abrirModalCategoria(null));

  document.getElementById('btn-salvar-categoria')
    ?.addEventListener('click', salvarCategoria);

  document.getElementById('categoria-tipo')
    ?.addEventListener('change', atualizarOpcoesDeGrupo);

  document.getElementById('categoria-busca')
    ?.addEventListener('input', (e) => renderCategoriasFiltradas(e.target.value));

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'categorias') renderCategorias();
  });

  renderCategorias();
}

async function renderCategorias() {
  const grid = document.getElementById('categorias-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  if (!allClientes.length) await loadAllClientes();

  const { data, error } = await supabaseClient
    .from('categorias')
    .select('id, nome, tipo, grupo, cliente_id, revisado, palavras_chave')
    .order('tipo', { ascending: false }) // receita antes de despesa
    .order('grupo')
    .order('nome');

  if (error) {
    grid.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
    console.error('❌ renderCategorias:', error.message);
    return;
  }

  categoriasCache = data || [];

  renderPendentesRevisao();

  const campoBusca = document.getElementById('categoria-busca');
  renderCategoriasFiltradas(campoBusca?.value || '');
}

// ── Pendentes de Contabilização ─────────────────────────────────
function renderPendentesRevisao() {
  const grid = document.getElementById('pendentes-revisao-grid');
  const bloco = document.getElementById('pendentes-revisao-bloco');
  if (!grid || !bloco) return;

  const pendentes = categoriasCache.filter(c => c.revisado === false);

  if (!pendentes.length) {
    bloco.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  bloco.classList.remove('hidden');

  grid.innerHTML = pendentes.map(c => {
    const cliente   = allClientes.find(cl => cl.id === c.cliente_id);
    const isReceita = c.tipo === 'receita';

    // Código/seção contábil pra onde essa categoria provavelmente vai
    // cair assim que for confirmada — só um preview, não altera nada
    // no banco (a confirmação continua exatamente igual a antes).
    const infoGrupo = (typeof obterCodigoGrupo === 'function')
      ? obterCodigoGrupo(c.tipo, c.grupo)
      : null;
    const sugestaoLabel = infoGrupo
      ? `${infoGrupo.codigo} — ${infoGrupo.label}`
      : (GRUPO_LABEL[c.grupo] || c.grupo || 'sem grupo');

    return `
      <div class="card card--pendente" data-cat-id="${c.id}">
        <div class="card-header-row">
          <div>
            <p class="card-name">${c.nome}</p>
            <p class="card-sub">Criada por ${cliente?.nome || 'cliente desconhecido'}</p>
            <p class="card-sub">Sugestão atual: ${sugestaoLabel}</p>
          </div>
          <span class="risk-badge ${isReceita ? 'verde' : 'cinza'}">${isReceita ? 'Receita' : 'Despesa'}</span>
        </div>
        <div class="card-actions">
          <button class="btn-card editar btn-ajustar-pendente" data-id="${c.id}">✏️ Ajustar</button>
          <button class="btn-card confirmar btn-confirmar-pendente" data-id="${c.id}" data-nome="${c.nome}">✓ Confirmar</button>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.btn-ajustar-pendente').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = categoriasCache.find(c => c.id === btn.dataset.id);
      if (cat) abrirModalCategoria(cat);
    });
  });

  grid.querySelectorAll('.btn-confirmar-pendente').forEach(btn => {
    btn.addEventListener('click', (e) => confirmarPendenteSemAlterar(btn.dataset.id, btn.dataset.nome, e.currentTarget));
  });
}

/**
 * Aprova a classificação atual (grupo sugerido) sem abrir o modal.
 * ATUALIZAÇÃO DE PERFORMANCE: aplica a mudança primeiro na UI (local,
 * instantâneo) e só depois confirma no servidor — se o servidor
 * recusar, reverte e avisa. Nunca refaz a consulta inteira de
 * categorias/clientes só para marcar um booleano.
 */
async function confirmarPendenteSemAlterar(id, nome, botaoClicado) {
  const cat = categoriasCache.find(c => c.id === id);
  if (!cat) return;

  if (botaoClicado) { botaoClicado.disabled = true; botaoClicado.textContent = '✓ Confirmando...'; }

  const valorAnterior = cat.revisado;
  cat.revisado = true;
  renderPendentesRevisao();
  renderCategoriasFiltradas(document.getElementById('categoria-busca')?.value || '');
  showToast(`"${nome}" confirmada!`);

  const { error } = await supabaseClient
    .from('categorias')
    .update({ revisado: true })
    .eq('id', id);

  if (error) {
    // Reverte apenas se a categoria ainda existir no cache (o admin
    // pode ter navegado para outra seção e voltado nesse meio tempo).
    const catAtual = categoriasCache.find(c => c.id === id);
    if (catAtual) catAtual.revisado = valorAnterior;
    renderPendentesRevisao();
    renderCategoriasFiltradas(document.getElementById('categoria-busca')?.value || '');
    showToast('Erro ao confirmar no servidor: ' + error.message, 'error');
  }
}

/**
 * Renderiza a grade principal de categorias agrupada por SEÇÃO
 * CONTÁBIL (estilo plano de contas real) em vez de uma lista plana.
 * A busca continua funcionando normalmente — ela filtra a lista ANTES
 * de agrupar, então uma seção sem nenhum resultado simplesmente não
 * aparece.
 */
function renderCategoriasFiltradas(termoBusca) {
  const grid  = document.getElementById('categorias-grid');
  if (!grid) return;

  const termo = normalizarTextoBusca(termoBusca);
  const lista = termo
    ? categoriasCache.filter(c => normalizarTextoBusca(c.nome).includes(termo))
    : categoriasCache;

  if (!categoriasCache.length) {
    grid.innerHTML = `
      <p class="empty-state">
        Nenhuma categoria cadastrada ainda.<br>
        Sem categorias aqui, os clientes NÃO conseguem registrar transações.<br>
        Clique em "+ Adicionar Categoria" para começar.
      </p>`;
    return;
  }

  if (!lista.length) {
    grid.innerHTML = `<p class="empty-state">Nenhuma categoria encontrada para "${termoBusca}".</p>`;
    return;
  }

  let html = '';

  ORDEM_PLANO_DE_CONTAS.forEach(({ tipo, grupo }) => {
    const itensDoGrupo = lista.filter(c => c.tipo === tipo && c.grupo === grupo);
    if (!itensDoGrupo.length) return;

    const infoGrupo = (typeof obterCodigoGrupo === 'function')
      ? obterCodigoGrupo(tipo, grupo)
      : { codigo: '', label: GRUPO_LABEL[grupo] || grupo };

    html += montarSecaoPlanoDeContas(infoGrupo, itensDoGrupo);
  });

  // Rede de segurança: categorias com combinação tipo+grupo fora do
  // mapa conhecido (dado legado/inconsistente) não podem simplesmente
  // sumir da tela — caem numa seção "Outras" ao final.
  const chavesConhecidas = new Set(ORDEM_PLANO_DE_CONTAS.map(g => `${g.tipo}__${g.grupo}`));
  const orfas = lista.filter(c => !chavesConhecidas.has(`${c.tipo}__${c.grupo}`));
  if (orfas.length) {
    html += montarSecaoPlanoDeContas({ codigo: '9', label: 'Outras / Sem Grupo Definido' }, orfas);
  }

  grid.innerHTML = html;

  grid.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { data: c, error } = await supabaseClient
        .from('categorias').select('*').eq('id', btn.dataset.id).single();
      if (error) { showToast('Erro ao carregar categoria: ' + error.message, 'error'); return; }
      if (c) abrirModalCategoria(c);
    });
  });

  grid.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => confirmarDeletarCategoria(btn.dataset.id, btn.dataset.nome));
  });
}

function montarSecaoPlanoDeContas(infoGrupo, itens) {
  const itensOrdenados = [...itens].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  return `
    <div class="plano-contas-secao">
      <div class="plano-contas-secao__header">
        <span class="plano-contas-secao__codigo">${infoGrupo.codigo}</span>
        <span class="plano-contas-secao__label">${infoGrupo.label}</span>
        <span class="plano-contas-secao__contador">${itens.length} conta${itens.length > 1 ? 's' : ''}</span>
      </div>
      <div class="plano-contas-secao__grid">
        ${itensOrdenados.map((c, idx) => renderCardCategoria(c, infoGrupo.codigo, idx + 1)).join('')}
      </div>
    </div>
  `;
}

function renderCardCategoria(c, codigoGrupo, indice) {
  const isReceita     = c.tipo === 'receita';
  const cliente        = c.cliente_id ? allClientes.find(cl => cl.id === c.cliente_id) : null;
  const qtdSinonimos   = Array.isArray(c.palavras_chave) ? c.palavras_chave.length : 0;
  const codigoConta    = codigoGrupo ? `${codigoGrupo}.${String(indice).padStart(2, '0')}` : '';

  return `
    <div class="card">
      <div class="card-header-row">
        <div>
          <p class="card-name">${codigoConta ? `<span class="conta-codigo">${codigoConta}</span>` : ''}${c.nome}</p>
          <p class="card-sub">${cliente ? `pessoal de ${cliente.nome}` : 'Categoria global'}</p>
          ${qtdSinonimos > 0 ? `<p class="card-sub">🔑 ${qtdSinonimos} sinônimo${qtdSinonimos > 1 ? 's' : ''} cadastrado${qtdSinonimos > 1 ? 's' : ''}</p>` : ''}
        </div>
        <span class="risk-badge ${isReceita ? 'verde' : 'cinza'}">${isReceita ? 'Receita' : 'Despesa'}</span>
      </div>
      <div class="card-actions">
        <button class="btn-card editar" data-id="${c.id}">✏️ Editar</button>
        <button class="btn-card deletar" data-id="${c.id}" data-nome="${c.nome}">🗑️ Deletar</button>
      </div>
    </div>
  `;
}

function abrirModalCategoria(item) {
  categoriaEmEdicao = item;

  document.getElementById('modal-categoria-title').textContent =
    item ? '✏️ Editar Categoria' : '🏷️ Adicionar Categoria';

  document.getElementById('categoria-id').value   = item?.id   || '';
  document.getElementById('categoria-nome').value = item?.nome || '';
  document.getElementById('categoria-tipo').value = item?.tipo || 'receita';

  const campoPalavrasChave = document.getElementById('categoria-palavras-chave');
  if (campoPalavrasChave) {
    campoPalavrasChave.value = Array.isArray(item?.palavras_chave) ? item.palavras_chave.join(', ') : '';
  }

  atualizarOpcoesDeGrupo(item?.grupo);
  openModal('modal-categoria');
}

function atualizarOpcoesDeGrupo(grupoSelecionado) {
  const tipo   = document.getElementById('categoria-tipo').value;
  const select = document.getElementById('categoria-grupo');
  const opcoes = GRUPOS_POR_TIPO[tipo] || [];

  select.innerHTML = opcoes.map(o =>
    `<option value="${o.value}" ${grupoSelecionado === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

async function salvarCategoria() {
  const id    = document.getElementById('categoria-id').value;
  const nome  = document.getElementById('categoria-nome').value.trim();
  const tipo  = document.getElementById('categoria-tipo').value;
  const grupo = document.getElementById('categoria-grupo').value;

  const palavrasChaveTexto = document.getElementById('categoria-palavras-chave')?.value.trim() || '';
  const palavrasChave = palavrasChaveTexto
    ? [...new Set(palavrasChaveTexto.split(',').map(p => p.trim()).filter(Boolean))]
    : [];

  if (!nome)  { showToast('Informe o nome da categoria.', 'error'); return; }
  if (!grupo) { showToast('Selecione um grupo.', 'error'); return; }

  const payload = { nome, tipo, grupo, revisado: true, palavras_chave: palavrasChave };

  const btn = document.getElementById('btn-salvar-categoria');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('categorias').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('categorias').insert(payload));
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }

  if (error) {
    showToast('Erro ao salvar: ' + error.message, 'error');
    return;
  }

  showToast(id ? 'Categoria atualizada!' : 'Categoria adicionada!');
  closeModal('modal-categoria');
  renderCategorias();
}

async function confirmarDeletarCategoria(id, nome) {
  if (!confirm(`Tem certeza que deseja deletar a categoria "${nome}"? Transações que já usam essa categoria podem ficar órfãs.`)) return;

  const { error } = await supabaseClient.from('categorias').delete().eq('id', id);

  if (error) {
    showToast('Erro ao deletar (pode haver transações usando essa categoria): ' + error.message, 'error');
    return;
  }

  showToast('Categoria removida.');
  renderCategorias();
}

console.log('✅ categorias.js carregado (grade agrupada como Plano de Contas)');
