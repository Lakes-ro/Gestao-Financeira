/**
 * CATEGORIAS.JS — Módulo: Categorias (admin.html)
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, openModal, closeModal, showToast
 *             (definidos em admin.js)
 *
 * SUBSTITUI plano-de-contas.js. Aquele módulo escrevia na tabela
 * `plano_de_contas`, que — confirmado via Supabase MCP (auditoria ao
 * vivo no banco, não suposição) — tem RLS de "plano de contas por
 * cliente" (exige `client_id` apontando pra um cliente do próprio
 * admin) e nunca teve dados visíveis para o cliente final.
 *
 * A tabela correta, usada de fato pelo formulário de transação do
 * cliente (via `transacoes.categoria_id`), é `categorias`:
 *   - RLS de leitura: liberada pra qualquer usuário autenticado.
 *   - RLS de escrita: exige `has_perfil('admin')` — ou seja, uma
 *     linha em `usuarios_perfis` com perfil='admin' pro usuário
 *     logado. Se o INSERT/UPDATE abaixo falhar com erro de RLS,
 *     confirme essa linha (ver instruções que acompanham este
 *     código).
 *
 * Colunas reais (confirmadas ao vivo no banco):
 *   nome  (text)
 *   tipo  ('receita' | 'despesa')
 *   grupo ('essencial' | 'estilo_de_vida' | 'investimento' | 'renda')
 *         — despesa usa essencial/estilo_de_vida/investimento;
 *         receita usa só 'renda' (não existe distinção ativa/passiva
 *         nesta tabela).
 */

let categoriaEmEdicao = null;

// Opções de "grupo" válidas por tipo — usado tanto pra popular o
// <select> quanto pra validar antes de salvar.
const GRUPOS_POR_TIPO = {
  despesa: [
    { value: 'essencial',      label: 'Essencial (sobrevivência)' },
    { value: 'estilo_de_vida', label: 'Estilo de Vida' },
    { value: 'investimento',   label: 'Investimento (poupança/reserva)' },
  ],
  receita: [
    { value: 'renda', label: 'Renda' },
  ],
};

function initCategorias() {
  document.getElementById('btn-add-categoria')
    ?.addEventListener('click', () => abrirModalCategoria(null));

  document.getElementById('btn-salvar-categoria')
    ?.addEventListener('click', salvarCategoria);

  document.getElementById('categoria-tipo')
    ?.addEventListener('change', atualizarOpcoesDeGrupo);

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'categorias') renderCategorias();
  });

  renderCategorias();
}

// ── Renderiza grid ────────────────────────────────────────────
async function renderCategorias() {
  const grid = document.getElementById('categorias-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  const { data, error } = await supabaseClient
    .from('categorias')
    .select('id, nome, tipo, grupo')
    .order('tipo')
    .order('grupo')
    .order('nome');

  if (error) {
    grid.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
    console.error('❌ renderCategorias:', error.message);
    return;
  }

  if (!data?.length) {
    grid.innerHTML = `
      <p class="empty-state">
        Nenhuma categoria cadastrada ainda.<br>
        Sem categorias aqui, os clientes NÃO conseguem registrar transações.<br>
        Clique em "+ Adicionar Categoria" para começar.
      </p>`;
    return;
  }

  const GRUPO_LABEL = {
    essencial:      '🟠 Essencial',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimento',
    renda:          '📈 Renda',
  };

  grid.innerHTML = data.map(c => {
    const isReceita = c.tipo === 'receita';
    return `
      <div class="card">
        <div class="card-header-row">
          <div>
            <p class="card-name">${c.nome}</p>
            <p class="card-sub">${GRUPO_LABEL[c.grupo] || c.grupo || 'Sem grupo'}</p>
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

// ── Modal: abrir (add ou editar) ───────────────────────────────
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

// Popula o <select> de grupo conforme o tipo escolhido (despesa tem
// 3 opções; receita hoje só tem 'renda') — evita salvar combinação
// inconsistente (ex: despesa com grupo 'renda').
function atualizarOpcoesDeGrupo(grupoSelecionado) {
  const tipo   = document.getElementById('categoria-tipo').value;
  const select = document.getElementById('categoria-grupo');
  const opcoes = GRUPOS_POR_TIPO[tipo] || [];

  select.innerHTML = opcoes.map(o =>
    `<option value="${o.value}" ${grupoSelecionado === o.value ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

// ── Salvar (insert ou update) ───────────────────────────────────
async function salvarCategoria() {
  const id    = document.getElementById('categoria-id').value;
  const nome  = document.getElementById('categoria-nome').value.trim();
  const tipo  = document.getElementById('categoria-tipo').value;
  const grupo = document.getElementById('categoria-grupo').value;

  if (!nome)  { showToast('Informe o nome da categoria.', 'error'); return; }
  if (!grupo) { showToast('Selecione um grupo.', 'error'); return; }

  const payload = { nome, tipo, grupo };

  let error;
  if (id) {
    ({ error } = await supabaseClient.from('categorias').update(payload).eq('id', id));
  } else {
    ({ error } = await supabaseClient.from('categorias').insert(payload));
  }

  if (error) {
    // Erro típico aqui é RLS ("new row violates row-level security
    // policy for table categorias") se o usuário logado não tiver
    // perfil 'admin' em usuarios_perfis — ver cabeçalho do arquivo.
    showToast('Erro ao salvar: ' + error.message, 'error');
    return;
  }

  showToast(id ? 'Categoria atualizada!' : 'Categoria adicionada!');
  closeModal('modal-categoria');
  renderCategorias();
}

// ── Deletar ──────────────────────────────────────────────────
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
