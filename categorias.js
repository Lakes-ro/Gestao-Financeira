/**
 * CATEGORIAS.JS — Módulo: Categorias (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, allClientes, loadAllClientes, openModal,
 *             closeModal, showToast (definidos em admin.js)
 *
 * ATUALIZAÇÃO — NOVOS GRUPOS 'divida' E 'transferencia': ver migração
 * 'adicionar_grupos_divida_e_transferencia' no Supabase.
 *
 * ATUALIZAÇÃO — LIVRE CRIAÇÃO + REVISÃO PELO ADMIN: o cliente agora
 * pode criar QUALQUER categoria pessoal (nome + tipo, sem restrição —
 * ex: "Passagem de Ônibus" e "Passagem de Avião" como categorias
 * separadas). A classificação de `grupo` (essencial/estilo_de_vida/
 * investimento/divida/transferencia/renda) que o sistema sugere
 * automaticamente na hora da criação é só um PALPITE inicial — toda
 * categoria criada por um cliente nasce com `revisado = false` (ver
 * categoria-personalizada.js) e cai na fila "📥 Pendentes de
 * Contabilização" abaixo, até o admin confirmar ou corrigir o grupo.
 * Isso resolve o problema de fundo: o cliente não tem contexto pra
 * saber se "Aluguel" dele é despesa (paga) ou receita (recebe) pro
 * BI, e não deveria precisar entender essa taxonomia — quem fecha a
 * classificação de verdade é o admin.
 *
 * ATUALIZAÇÃO — CAMPO DE BUSCA: com categorias globais + pessoais
 * misturadas na mesma grid, a lista pode crescer bastante.
 * `categoriasCache` guarda a última lista carregada do banco; filtrar
 * por texto NÃO refaz a consulta, só reaplica o filtro em memória.
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
    .select('id, nome, tipo, grupo, cliente_id, revisado')
    .order('tipo')
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
// Categorias criadas por CLIENTES (cliente_id não nulo) com
// revisado=false — precisam que o admin confirme ou corrija o grupo
// antes de considerar a classificação "fechada" pro BI.
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
    return `
      <div class="card card--pendente">
        <div class="card-header-row">
          <div>
            <p class="card-name">${c.nome}</p>
            <p class="card-sub">Criada por ${cliente?.nome || 'cliente desconhecido'}</p>
            <p class="card-sub">Sugestão atual: ${GRUPO_LABEL[c.grupo] || c.grupo || 'sem grupo'}</p>
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
    btn.addEventListener('click', () => confirmarPendenteSemAlterar(btn.dataset.id, btn.dataset.nome));
  });
}

// Aprova a classificação atual (grupo sugerido) sem abrir o modal —
// usado quando o admin olha a sugestão e concorda com ela de cara.
async function confirmarPendenteSemAlterar(id, nome) {
  const { error } = await supabaseClient
    .from('categorias')
    .update({ revisado: true })
    .eq('id', id);

  if (error) { showToast('Erro ao confirmar: ' + error.message, 'error'); return; }

  showToast(`"${nome}" confirmada!`);
  renderCategorias();
}

/**
 * Reaplica o filtro de busca em cima de `categoriasCache` (sem refazer
 * a consulta ao Supabase) e redesenha a grid principal. Chamada tanto
 * a cada tecla digitada no campo de busca quanto logo após um
 * carregamento novo.
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

  grid.innerHTML = lista.map(c => {
    const isReceita = c.tipo === 'receita';
    const cliente   = c.cliente_id ? allClientes.find(cl => cl.id === c.cliente_id) : null;
    return `
      <div class="card">
        <div class="card-header-row">
          <div>
            <p class="card-name">${c.nome}</p>
            <p class="card-sub">${GRUPO_LABEL[c.grupo] || c.grupo || 'Sem grupo'}${cliente ? ` · pessoal de ${cliente.nome}` : ''}</p>
          </div>
          <span class="risk-badge ${isReceita ? 'verde' : 'cinza'}">${isReceita ? 'Receita' : 'Despesa'}</span>
        </div>
        <div class="card-actions">
          <button class="btn-card editar" data-id="${c.id}">✏️ Editar</button>
          <button class="btn-card deletar" data-id="${c.id}" data-nome="${c.nome}">🗑️ Deletar</button>
        </div>
      </div>
    `;
  }).join('');

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

function abrirModalCategoria(item) {
  categoriaEmEdicao = item;

  document.getElementById('modal-categoria-title').textContent =
    item ? '✏️ Editar Categoria' : '🏷️ Adicionar Categoria';

  document.getElementById('categoria-id').value   = item?.id   || '';
  document.getElementById('categoria-nome').value = item?.nome || '';
  document.getElementById('categoria-tipo').value = item?.tipo || 'despesa';

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

  if (!nome)  { showToast('Informe o nome da categoria.', 'error'); return; }
  if (!grupo) { showToast('Selecione um grupo.', 'error'); return; }

  // Qualquer categoria que o ADMIN salva (criando nova ou editando uma
  // pendente) já sai daqui como revisado=true — é literalmente o admin
  // decidindo/confirmando a classificação nesse momento.
  const payload = { nome, tipo, grupo, revisado: true };

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('categorias').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('categorias').insert(payload));
  }

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

console.log('✅ categorias.js carregado');
