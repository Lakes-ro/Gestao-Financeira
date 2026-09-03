/**
 * LANCAMENTOS-ADMIN.JS — Lançamento Manual e Importação de Extrato
 * PELO ADMIN, em nome de um cliente específico.
 * ================================================
 * Padrão: script global. Sem import/export.
 *
 * POR QUE ESTE ARQUIVO EXISTE:
 * O formulário de transação e a importação de extrato (OFX/CSV) já
 * existem prontos no painel do CLIENTE (smart-input.js +
 * importacao-extrato.js) — com toda a inteligência de classificação
 * automática (sinônimos cadastrados, nome da categoria, radical,
 * grupos semânticos, regras Nubank pré-classificadas). Só que esses
 * dois arquivos são escritos pra rodar dentro da SESSÃO do próprio
 * cliente: dependem de três globals que só existem em
 * client.html/index.html — `ClientModule` (sabe o id do cliente
 * logado), `DatabaseModule` (camada de acesso ao banco) e `UIModule`
 * (toasts/mensagens). Nenhum dos três existe no admin.
 *
 * Em vez de duplicar centenas de linhas de lógica de classificação,
 * este arquivo cria uma versão MÍNIMA desses três objetos — apontando
 * sempre pro CLIENTE SELECIONADO no modal, em vez do cliente logado
 * — e reaproveita smart-input.js/importacao-extrato.js SEM modificar
 * nenhum dos dois.
 *
 * ATUALIZAÇÃO — EDITAR E EXCLUIR LANÇAMENTOS:
 * O painel "Últimos lançamentos deste cliente" agora exibe botões ✏️ e
 * 🗑️ em cada linha. O ✏️ ativa o MODO EDIÇÃO no formulário "Lançamento
 * Manual" existente (sem novo modal ou alteração de admin.html): os
 * campos são preenchidos, o botão de submit troca para "✏️ Salvar
 * Alterações" e um banner âmbar é injetado dinamicamente com um link
 * "✕ Cancelar edição". O 🗑️ abre uma confirmação nativa e apaga a
 * transação via `ClientModule.deleteTransaction()`. A lista passa a
 * exibir até 20 lançamentos (antes eram 8) e inclui `categoria_id` no
 * select para que o formulário de edição consiga pré-selecionar a
 * categoria original. Troca de cliente ou reabertura do modal descartam
 * automaticamente qualquer edição em curso.
 *
 * ⚠️ ORDEM DE CARREGAMENTO NO admin.html (crítica): este arquivo deve
 * vir DEPOIS de smart-input.js, regras-aprendidas.js e
 * importacao-extrato.js — embora funções sejam hoisted e só executem
 * no clique do utilizador (quando todos os scripts já carregaram),
 * manter essa ordem deixa a dependência explícita e evita confusão
 * futura.
 */

// ══════════════════════════════════════════════════════════════
// SHIMS — versões mínimas de ClientModule/DatabaseModule/UIModule
// ══════════════════════════════════════════════════════════════

let adminClienteSelecionadoId = null; // cliente atualmente selecionado no modal

const ClientModule = {
    getClientId: () => adminClienteSelecionadoId,

    async addTransaction(transactionData) {
        const { data, error } = await supabaseClient.from('transacoes').insert([transactionData]).select();
        if (error) throw error;
        return data?.[0];
    },

    async updateTransaction(transactionId, updates) {
        const { data, error } = await supabaseClient
            .from('transacoes').update(updates).eq('id', transactionId).select();
        if (error) throw error;
        return data?.[0];
    },

    async deleteTransaction(transactionId) {
        const { error } = await supabaseClient.from('transacoes').delete().eq('id', transactionId);
        if (error) throw error;
        return true;
    }
};

const DatabaseModule = {
    async getCategorias() {
        const { data, error } = await supabaseClient
            .from('categorias')
            .select('*')
            .order('tipo', { ascending: false })
            .order('grupo')
            .order('nome');
        if (error) throw error;
        return data || [];
    },

    async addTransaction(transactionData) {
        const { data, error } = await supabaseClient.from('transacoes').insert([transactionData]).select();
        if (error) throw error;
        return data?.[0];
    },

    async addTransactionsBulk(transactionsData) {
        const { data, error } = await supabaseClient.from('transacoes').insert(transactionsData).select();
        if (error) throw error;
        return data || [];
    }
};

const UIModule = {
    showError(msg)             { showToast(msg || 'Erro', 'error'); },
    showSuccess(msg)           { showToast(msg || 'Sucesso', 'success'); },
    showMessage(msg, tipo)     { showToast(msg, tipo === 'error' ? 'error' : 'success'); }
};

/**
 * importacao-extrato.js chama `await loadClientDashboard()` ao final
 * de uma importação bem-sucedida. Aqui recarrega apenas a lista de
 * lançamentos recentes do cliente selecionado.
 */
async function loadClientDashboard() {
    if (adminClienteSelecionadoId) {
        await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
    }
}

// ══════════════════════════════════════════════════════════════
// ESTADO DE EDIÇÃO
// ══════════════════════════════════════════════════════════════

/** ID da transação em edição no formulário manual; null = modo criação. */
let transacaoAdminEmEdicaoId = null;

/**
 * Cache das transações recentes do cliente selecionado.
 * Alimentado por carregarUltimosLancamentosDoCliente — permite que
 * abrirEdicaoTransacaoAdmin acesse categoria_id e demais campos sem
 * refazer a consulta ao banco.
 */
let transacoesAdminRecentesCache = [];

// ══════════════════════════════════════════════════════════════
// MODO EDIÇÃO — HELPERS DE UI
// ══════════════════════════════════════════════════════════════

/**
 * Ativa o modo de edição no formulário manual:
 *  • Troca o texto e a cor do botão de submit.
 *  • Injeta um banner âmbar com link "✕ Cancelar edição" (apenas uma vez).
 *  • Destaca na lista o item que está sendo editado.
 *  • Rola o formulário para a viewport.
 */
function setModoEdicaoAdmin(transacaoId) {
    transacaoAdminEmEdicaoId = transacaoId;

    ativarAbaLancamentosAdmin('manual');

    const form      = document.getElementById('lancamento-manual-form');
    const btnSubmit = form?.querySelector('button[type="submit"]');

    if (btnSubmit) {
        btnSubmit.textContent      = '✏️ Salvar Alterações';
        btnSubmit.style.background = 'var(--accent-warning, #ffb443)';
        btnSubmit.style.color      = '#0d1610';
    }

    // Banner âmbar — injeta apenas uma vez por sessão de edição
    if (!document.getElementById('lancamento-admin-edit-banner')) {
        const banner = document.createElement('div');
        banner.id = 'lancamento-admin-edit-banner';
        banner.style.cssText = `
            padding:8px 12px;
            background:rgba(255,180,67,.12);
            border:1px solid rgba(255,180,67,.35);
            border-radius:6px;
            margin-bottom:12px;
            display:flex;
            justify-content:space-between;
            align-items:center;
            gap:8px;
            font-size:12px;
            color:#ffb443;
        `;
        banner.innerHTML = `
            <span>✏️ <strong>Modo edição</strong> — alterando lançamento existente</span>
            <button type="button" id="btn-cancelar-edicao-admin" style="
                background:rgba(255,180,67,.15);
                border:1px solid rgba(255,180,67,.4);
                border-radius:4px;
                color:#ffb443;
                font-size:11px;
                padding:3px 10px;
                cursor:pointer;
                font-family:inherit;
                white-space:nowrap;
            ">✕ Cancelar edição</button>`;

        if (form) form.insertBefore(banner, form.firstChild);

        document.getElementById('btn-cancelar-edicao-admin')
            ?.addEventListener('click', cancelarEdicaoAdmin);
    }

    // Destaca o item sendo editado na lista de lançamentos recentes
    document.querySelectorAll('#lancamentos-admin-recentes .razonete-item').forEach(el => {
        const emEdicao = el.dataset.transacaoId === transacaoId;
        el.style.outline      = emEdicao ? '2px solid #ffb443' : '';
        el.style.outlineOffset = emEdicao ? '2px' : '';
        el.style.borderRadius  = emEdicao ? '6px' : '';
    });

    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Restaura o formulário para o modo de CRIAÇÃO:
 * remove o banner, restaura o botão de submit e limpa o destaque na lista.
 */
function resetModoEdicaoAdmin() {
    transacaoAdminEmEdicaoId = null;

    document.getElementById('lancamento-admin-edit-banner')?.remove();

    const form      = document.getElementById('lancamento-manual-form');
    const btnSubmit = form?.querySelector('button[type="submit"]');

    if (btnSubmit) {
        btnSubmit.textContent      = '➕ Registrar Lançamento';
        btnSubmit.style.background = '';
        btnSubmit.style.color      = '';
    }

    // Remove destaque da lista
    document.querySelectorAll('#lancamentos-admin-recentes .razonete-item').forEach(el => {
        el.style.outline       = '';
        el.style.outlineOffset = '';
        el.style.borderRadius  = '';
    });
}

/** Cancela a edição em curso: reseta o modo e limpa o formulário. */
function cancelarEdicaoAdmin() {
    resetModoEdicaoAdmin();
    document.getElementById('lancamento-manual-form')?.reset();
    document.getElementById('lancamento-manual-data').value = getDataDeHojeFormatoInputAdmin();
    showToast('Edição cancelada.');
}

// ══════════════════════════════════════════════════════════════
// ABRIR EDIÇÃO DE TRANSAÇÃO
// ══════════════════════════════════════════════════════════════

/**
 * Popula o formulário "Lançamento Manual" com os dados de uma transação
 * existente e ativa o modo de edição.
 *
 * Usa `transacoesAdminRecentesCache` para evitar um refetch ao banco.
 * Se a transação não estiver no cache (ex: lista foi recarregada), exibe
 * um erro orientando o admin a recarregar.
 */
async function abrirEdicaoTransacaoAdmin(transacaoId) {
    const transacao = transacoesAdminRecentesCache.find(t => t.id === transacaoId);

    if (!transacao) {
        showToast('Transação não encontrada — recarregue a lista.', 'error');
        return;
    }

    // Garante que as categorias estejam no select antes de pré-selecionar
    if (!categoriasCacheLancamentoManual.length) {
        categoriasCacheLancamentoManual = await DatabaseModule.getCategorias();
        popularSelectCategoriaManual(categoriasCacheLancamentoManual);
    }

    const campoDescricao = document.getElementById('lancamento-manual-descricao');
    const campoCategoria = document.getElementById('lancamento-manual-categoria');
    const campoValor     = document.getElementById('lancamento-manual-valor');
    const campoData      = document.getElementById('lancamento-manual-data');

    if (campoDescricao) campoDescricao.value = transacao.descricao       || '';
    if (campoValor)     campoValor.value      = Math.abs(transacao.valor) || '';
    if (campoData)      campoData.value        = transacao.data_competencia || '';

    if (campoCategoria && transacao.categoria_id) {
        campoCategoria.value = transacao.categoria_id;
        // Categoria pode ter sido apagada após o lançamento — avisa o admin
        if (!campoCategoria.value) {
            showToast('⚠️ Categoria original não encontrada — selecione uma nova antes de salvar.', 'error');
        }
    }

    setModoEdicaoAdmin(transacaoId);
}

// ══════════════════════════════════════════════════════════════
// EXCLUIR TRANSAÇÃO
// ══════════════════════════════════════════════════════════════

/**
 * Pede confirmação e exclui a transação do cliente selecionado.
 * Se a transação estiver em edição no formulário, o modo de edição é
 * descartado antes da exclusão.
 */
async function handleDeletarTransacaoAdmin(transacaoId, descricao) {
    const msg = descricao
        ? `Excluir o lançamento "${descricao}"?\n\nEsta ação não pode ser desfeita.`
        : 'Excluir este lançamento? Esta ação não pode ser desfeita.';

    if (!confirm(msg)) return;

    const btnDel = document.querySelector(`.btn-admin-trans-delete[data-id="${transacaoId}"]`);
    if (btnDel) { btnDel.disabled = true; btnDel.textContent = '...'; }

    try {
        await ClientModule.deleteTransaction(transacaoId);

        // Se estava sendo editado, descarta o estado de edição e limpa o form
        if (transacaoAdminEmEdicaoId === transacaoId) {
            resetModoEdicaoAdmin();
            document.getElementById('lancamento-manual-form')?.reset();
            document.getElementById('lancamento-manual-data').value = getDataDeHojeFormatoInputAdmin();
        }

        showToast('Lançamento excluído!');
        await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
    } catch (err) {
        showToast('Erro ao excluir: ' + err.message, 'error');
        if (btnDel) { btnDel.disabled = false; btnDel.textContent = '🗑️'; }
    }
}

// ══════════════════════════════════════════════════════════════
// MODAL: SELEÇÃO DE CLIENTE + ABAS (Manual / Importar Extrato)
// ══════════════════════════════════════════════════════════════

let categoriasCacheLancamentoManual = [];

function initLancamentosAdmin() {
    document.getElementById('lancamentos-cliente-select')
        ?.addEventListener('change', (e) => selecionarClienteParaLancamento(e.target.value));

    document.querySelectorAll('.lancamentos-admin__tab').forEach(tab => {
        tab.addEventListener('click', () => ativarAbaLancamentosAdmin(tab.dataset.tab));
    });

    document.getElementById('lancamento-manual-form')
        ?.addEventListener('submit', handleLancamentoManualAdmin);

    document.getElementById('lancamento-manual-descricao')
        ?.addEventListener('blur', sugerirCategoriaLancamentoManual);
}

/**
 * Abre o modal já com um cliente pré-selecionado (chamado pelo botão
 * "📥 Lançamentos" de cada card em clientes.js). Se nenhum id for
 * passado, abre com o seletor vazio para o admin escolher.
 * Descarta qualquer edição em curso antes de abrir.
 */
async function abrirModalLancamentosAdmin(clienteIdPreSelecionado) {
    if (!allClientes.length) await loadAllClientes();

    // Descarta edição em curso ao (re)abrir o modal
    resetModoEdicaoAdmin();
    transacoesAdminRecentesCache = [];

    const select = document.getElementById('lancamentos-cliente-select');
    if (select) {
        select.innerHTML = '<option value="">Selecione um cliente...</option>' +
            allClientes
                .slice()
                .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
                .map(c => `<option value="${c.id}" ${c.id === clienteIdPreSelecionado ? 'selected' : ''}>${c.nome}</option>`)
                .join('');
    }

    if (typeof cancelarImportacao === 'function') cancelarImportacao();

    ativarAbaLancamentosAdmin('manual');
    document.getElementById('lancamento-manual-form')?.reset();

    if (clienteIdPreSelecionado) {
        await selecionarClienteParaLancamento(clienteIdPreSelecionado);
    } else {
        adminClienteSelecionadoId = null;
        document.getElementById('lancamentos-conteudo')?.classList.add('hidden');
    }

    openModal('modal-lancamentos-admin');
}

async function selecionarClienteParaLancamento(clienteId) {
    // Troca de cliente descarta qualquer edição em curso para evitar
    // salvar dados de um cliente no registro de outro.
    if (transacaoAdminEmEdicaoId) {
        resetModoEdicaoAdmin();
        document.getElementById('lancamento-manual-form')?.reset();
    }

    adminClienteSelecionadoId    = clienteId || null;
    transacoesAdminRecentesCache = [];

    const conteudo = document.getElementById('lancamentos-conteudo');
    const select   = document.getElementById('lancamentos-cliente-select');
    if (select && select.value !== (clienteId || '')) select.value = clienteId || '';

    if (!adminClienteSelecionadoId) {
        conteudo?.classList.add('hidden');
        return;
    }

    conteudo?.classList.remove('hidden');

    categoriasCacheLancamentoManual = await DatabaseModule.getCategorias();
    popularSelectCategoriaManual(categoriasCacheLancamentoManual);

    const campoData = document.getElementById('lancamento-manual-data');
    if (campoData && !campoData.value) campoData.value = getDataDeHojeFormatoInputAdmin();

    await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
}

function ativarAbaLancamentosAdmin(nomeAba) {
    document.querySelectorAll('.lancamentos-admin__tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === nomeAba);
    });
    document.querySelectorAll('.lancamentos-admin__tab-content').forEach(c => {
        c.classList.toggle('active', c.id === `lancamentos-tab-${nomeAba}`);
    });
}

function getDataDeHojeFormatoInputAdmin() {
    const agora = new Date();
    const ano = agora.getFullYear();
    const mes = String(agora.getMonth() + 1).padStart(2, '0');
    const dia = String(agora.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

// ══════════════════════════════════════════════════════════════
// ABA: LANÇAMENTO MANUAL
// ══════════════════════════════════════════════════════════════

function popularSelectCategoriaManual(categorias) {
    const select = document.getElementById('lancamento-manual-categoria');
    if (!select) return;

    const porGrupo = {};
    categorias.forEach(c => {
        const chave = `${c.tipo}__${c.grupo}`;
        if (!porGrupo[chave]) porGrupo[chave] = [];
        porGrupo[chave].push(c);
    });

    const ordemGrupos = [
        'receita__renda', 'receita__transferencia',
        'despesa__essencial', 'despesa__estilo_de_vida', 'despesa__investimento',
        'despesa__divida', 'despesa__transferencia'
    ];
    const labelGrupo = {
        renda: '📈 Renda', essencial: '🟠 Essencial', estilo_de_vida: '🎯 Estilo de Vida',
        investimento: '💰 Investimento', divida: '💳 Dívida', transferencia: '🔄 Transferência'
    };

    const chaves = [
        ...ordemGrupos.filter(k => porGrupo[k]),
        ...Object.keys(porGrupo).filter(k => !ordemGrupos.includes(k))
    ];

    let html = '<option value="">Selecione a categoria...</option>';
    chaves.forEach(chave => {
        const [, grupo] = chave.split('__');
        const label = labelGrupo[grupo] || grupo;
        porGrupo[chave]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .forEach(c => {
                html += `<option value="${c.id}" data-tipo="${c.tipo}">${label} — ${c.nome}</option>`;
            });
    });

    select.innerHTML = html;
}

/**
 * Ao sair do campo Descrição, tenta sugerir a categoria via sinônimos/
 * nome/grupos semânticos (encontrarCategoriaPorPalavraChave de
 * smart-input.js). Em modo edição, só sugere se o select estiver vazio
 * — evita sobrescrever a categoria original sem querer.
 */
function sugerirCategoriaLancamentoManual() {
    const descricao = document.getElementById('lancamento-manual-descricao')?.value.trim();
    if (!descricao || descricao.length < 3) return;
    if (typeof encontrarCategoriaPorPalavraChave !== 'function') return;

    // Em modo edição, só sugere se a categoria ainda não foi escolhida
    if (transacaoAdminEmEdicaoId) {
        const selectCategoria = document.getElementById('lancamento-manual-categoria');
        if (selectCategoria?.value) return;
    }

    const match = encontrarCategoriaPorPalavraChave(categoriasCacheLancamentoManual, descricao);
    if (!match) return;

    const select = document.getElementById('lancamento-manual-categoria');
    if (select) select.value = match.id;

    const aviso = match._confiancaAlta === false
        ? `🔎 Sugestão por semelhança: ${match.nome} — confira antes de salvar`
        : `🤖 Categoria sugerida: ${match.nome}`;
    showToast(aviso, match._confiancaAlta === false ? 'error' : 'success');
}

/**
 * Lida com o submit do formulário "Lançamento Manual".
 *
 * MODO EDIÇÃO (`transacaoAdminEmEdicaoId !== null`):
 *   Chama `ClientModule.updateTransaction`. Ao salvar com sucesso,
 *   resetModoEdicaoAdmin() restaura o formulário para o modo criação.
 *
 * MODO CRIAÇÃO (`transacaoAdminEmEdicaoId === null`):
 *   Comportamento original — chama `ClientModule.addTransaction` e
 *   aprende a regra de classificação via RegrasAprendidasModule.
 */
async function handleLancamentoManualAdmin(event) {
    event.preventDefault();

    if (!adminClienteSelecionadoId) { showToast('Selecione um cliente primeiro.', 'error'); return; }

    const descricao   = document.getElementById('lancamento-manual-descricao').value.trim();
    const categoriaId = document.getElementById('lancamento-manual-categoria').value;
    const valor       = parseFloat(document.getElementById('lancamento-manual-valor').value);
    const data        = document.getElementById('lancamento-manual-data').value;

    if (!categoriaId)         { showToast('Selecione uma categoria.', 'error'); return; }
    if (!data)                { showToast('Data é obrigatória.', 'error'); return; }
    if (!valor || valor <= 0) { showToast('Informe um valor válido.', 'error'); return; }

    const cat = categoriasCacheLancamentoManual.find(c => c.id === categoriaId);
    if (!cat) { showToast('Categoria inválida.', 'error'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    // ── MODO EDIÇÃO ──────────────────────────────────────────────
    if (transacaoAdminEmEdicaoId) {
        try {
            await ClientModule.updateTransaction(transacaoAdminEmEdicaoId, {
                categoria_id:     categoriaId,
                valor,
                data_competencia: data,
                descricao:        descricao || null,
                tipo:             cat.tipo,
            });

            showToast('Lançamento atualizado!');
            resetModoEdicaoAdmin();         // restaura botão + remove banner
            event.target.reset();
            document.getElementById('lancamento-manual-data').value = getDataDeHojeFormatoInputAdmin();
            document.getElementById('lancamento-manual-descricao')?.focus();
            await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
        } catch (err) {
            showToast('Erro ao atualizar: ' + err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                // Se transacaoAdminEmEdicaoId ainda é não-nulo, o update
                // falhou e o modo de edição permanece — restaura o texto
                // de edição. Se for null, resetModoEdicaoAdmin() já cuidou.
                if (transacaoAdminEmEdicaoId) {
                    btn.textContent      = '✏️ Salvar Alterações';
                    btn.style.background = 'var(--accent-warning, #ffb443)';
                    btn.style.color      = '#0d1610';
                }
            }
        }
        return;
    }

    // ── MODO CRIAÇÃO ─────────────────────────────────────────────
    try {
        await ClientModule.addTransaction({
            client_id:        adminClienteSelecionadoId,
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao:        descricao || null,
            tipo:             cat.tipo,
            origem:           'lancamento_admin'
        });

        // Aprende a classificação para reutilizar nas próximas vezes
        if (typeof RegrasAprendidasModule !== 'undefined' && descricao) {
            try {
                await RegrasAprendidasModule.salvarOuAtualizarRegra({
                    clienteId:   adminClienteSelecionadoId,
                    termoBusca:  descricao,
                    categoriaId: cat.id,
                    tipo:        cat.tipo
                });
            } catch (_) { /* não crítico */ }
        }

        showToast('Lançamento registrado!');
        event.target.reset();
        document.getElementById('lancamento-manual-data').value = getDataDeHojeFormatoInputAdmin();
        document.getElementById('lancamento-manual-descricao')?.focus();
        await carregarUltimosLancamentosDoCliente(adminClienteSelecionadoId);
    } catch (err) {
        showToast('Erro ao registrar: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '➕ Registrar Lançamento'; }
    }
}

// ══════════════════════════════════════════════════════════════
// PAINEL: ÚLTIMOS LANÇAMENTOS DO CLIENTE (com editar / excluir)
// ══════════════════════════════════════════════════════════════

/**
 * Carrega e renderiza os lançamentos recentes do cliente selecionado.
 *
 * MUDANÇAS em relação à versão anterior:
 *  • `categoria_id` incluído no select para pré-preencher o form de edição.
 *  • Limite ampliado de 8 → 20 para mais contexto sem sair do modal.
 *  • Cache populado em `transacoesAdminRecentesCache`.
 *  • Botões ✏️ e 🗑️ adicionados em cada linha, com listeners ligados
 *    após a renderização do HTML.
 */
async function carregarUltimosLancamentosDoCliente(clienteId) {
    const container = document.getElementById('lancamentos-admin-recentes');
    if (!container) return;

    container.innerHTML = '<p class="empty-state">Carregando...</p>';

    const { data, error } = await supabaseClient
        .from('transacoes')
        .select('id, valor, tipo, descricao, data_competencia, created_at, categoria_id, categorias(nome)')
        .eq('client_id', clienteId)
        .order('data_competencia', { ascending: false })
        .order('created_at',       { ascending: false })
        .limit(20);                              // ampliado de 8 → 20

    if (error) {
        container.innerHTML = `<p class="empty-state">Erro ao carregar: ${error.message}</p>`;
        transacoesAdminRecentesCache = [];
        return;
    }

    if (!data?.length) {
        container.innerHTML = '<p class="empty-state">Nenhum lançamento ainda.</p>';
        transacoesAdminRecentesCache = [];
        return;
    }

    transacoesAdminRecentesCache = data;   // cache para abrirEdicaoTransacaoAdmin

    // Estilos inline compartilhados entre os dois botões de ação
    const BTN_BASE = [
        'border-radius:4px',
        'padding:3px 8px',
        'font-size:12px',
        'cursor:pointer',
        'font-family:inherit',
        'flex-shrink:0',
        'line-height:1.5',
    ].join(';');

    const BTN_EDITAR  = `${BTN_BASE};background:rgba(66,99,235,.12);border:1px solid rgba(66,99,235,.3);color:#7b96ff`;
    const BTN_DELETAR = `${BTN_BASE};background:rgba(255,77,109,.10);border:1px solid rgba(255,77,109,.25);color:#ff8099`;

    container.innerHTML = data.map(t => {
        const categoriaNome    = t.categorias?.nome || 'Sem categoria';
        const descricaoDisplay = t.descricao ? ` · ${t.descricao}` : '';
        // Escapa para uso seguro em atributos HTML
        const descricaoSegura  = (t.descricao || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        return `
            <div class="razonete-item ${t.tipo}" data-transacao-id="${t.id}">
                <div class="razonete-item-info">
                    <span class="razonete-descricao">${categoriaNome}${descricaoDisplay}</span>
                    <span class="razonete-data">${formatDate(t.data_competencia)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <span class="razonete-valor ${t.tipo === 'receita' ? 'positivo' : 'negativo'}">
                        ${t.tipo === 'receita' ? '+' : '-'}${formatCurrency(Math.abs(t.valor))}
                    </span>
                    <button type="button"
                        class="btn-admin-trans-edit"
                        data-id="${t.id}"
                        title="Editar lançamento"
                        style="${BTN_EDITAR}">✏️</button>
                    <button type="button"
                        class="btn-admin-trans-delete"
                        data-id="${t.id}"
                        data-descricao="${descricaoSegura}"
                        title="Excluir lançamento"
                        style="${BTN_DELETAR}">🗑️</button>
                </div>
            </div>`;
    }).join('');

    // Liga eventos após o innerHTML ser renderizado
    container.querySelectorAll('.btn-admin-trans-edit').forEach(btn => {
        btn.addEventListener('click', () => abrirEdicaoTransacaoAdmin(btn.dataset.id));
    });

    container.querySelectorAll('.btn-admin-trans-delete').forEach(btn => {
        btn.addEventListener('click', () =>
            handleDeletarTransacaoAdmin(btn.dataset.id, btn.dataset.descricao)
        );
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLancamentosAdmin);
} else {
    initLancamentosAdmin();
}

console.log('✅ lancamentos-admin.js carregado (lançamento manual + importação + edição + exclusão)');
