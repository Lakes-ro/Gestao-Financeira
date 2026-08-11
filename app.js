/**
 * APP.JS - ORQUESTRADOR DO PAINEL DO CLIENTE
 * ================================================
 * Este ficheiro (usado por index.html e client.html) cuida
 * SOMENTE do fluxo do cliente (login, registo, onboarding,
 * dashboard do cliente). O painel do administrador vive
 * exclusivamente em admin.html + admin.js.
 *
 * DEPENDÊNCIAS OBRIGATÓRIAS (devem ser carregadas ANTES deste
 * ficheiro no HTML): config.js, ui.js, auth.js, database.js,
 * dashboard.js, transactions.js, goals.js, planning.js, client.js
 *
 * ATENÇÃO: o módulo ClientModule (estado do cliente logado,
 * addTransaction, addGoal) NÃO está definido aqui — vive em
 * client.js. Se este ficheiro for incluído num HTML sem
 * <script src="client.js"> carregado antes, todas as chamadas a
 * ClientModule abaixo vão falhar com "ClientModule is not defined".
 *
 * ATUALIZAÇÃO — SMART DATE + SMART INPUT (smart-input.js):
 * 1) switchClientView() chama initForm() sempre que a aba
 *    "Transações" é aberta — isso garante que a data de hoje já
 *    esteja preenchida (Smart Date) assim que o cliente vê o
 *    formulário, sem sobrescrever uma data que ele já tenha alterado
 *    manualmente antes de submeter.
 * 2) handleAddTransaction() agora, antes de validar a categoria,
 *    garante que qualquer classificação automática em andamento
 *    (disparada pelo onblur do campo Descrição) termine primeiro — e,
 *    se o cliente clicar em Registar sem nunca ter saído do campo
 *    Descrição, tenta classificar de última hora. Depois de um
 *    registo bem-sucedido, chama initForm(true) para reinjetar a data
 *    de hoje no formulário já resetado, pronto para o próximo
 *    lançamento.
 * Todas as chamadas a funções de smart-input.js são protegidas por
 * `typeof === 'function'`, então o fluxo antigo (100% manual)
 * continua funcionando normalmente mesmo que smart-input.js não
 * esteja carregado na página.
 */

// ================================================
// UTILITÁRIOS GLOBAIS
// ================================================

function toggleScreen(screenId) {
    UIModule.showScreen(screenId);
}

function closeModal(modalId) {
    UIModule.closeModal(modalId);
}

function toggleAddMetaForm() {
    document.getElementById('addMetaForm')?.classList.toggle('hidden');
}

function switchClientView(sectionId, event) {
    event.preventDefault();
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');
    document.querySelectorAll('.sidebar__nav-item').forEach(b => b.classList.remove('active'));
    event.currentTarget.classList.add('active');

    if (sectionId === 'cli-transactions') {
        garantirCategoriasCarregadas();

        // Smart Date: garante que o campo de data já tenha a data de
        // hoje pronta assim que o cliente abre a aba de Transações
        // (não sobrescreve se ele já tiver alterado manualmente).
        if (typeof initForm === 'function') {
            initForm(false);
        }
    }
}

// ================================================
// ROTEAMENTO PÓS-LOGIN (RBAC)
// ================================================

async function routeByRole(user, role) {
    // ── ADMIN: painel próprio, fora deste ficheiro ──
    if (role === 'admin') {
        window.location.href = 'admin.html';
        return;
    }

    // ── VERIFICA ONBOARDING ──
    const needsOnboarding = await checkOnboarding(user, role);
    if (needsOnboarding) {
        UIModule.showScreen('onboardingScreen');
        return;
    }

    // ── AUTOCURA: garante que a linha em `clientes` existe ──
    // BUG JÁ CORRIGIDO (confirmado em produção via console: erro 403 ao
    // registar transação/meta): checkOnboarding() só verifica se
    // `usuarios.nome_completo`/`apelido` estão preenchidos — mas a linha
    // em `clientes` (necessária para RLS de transacoes/metas) só era
    // criada dentro de handleRegister/handleOnboarding. Contas que
    // completaram o cadastro ANTES desta correção existir ficaram com
    // `usuarios` completo mas SEM linha em `clientes`, então caíam
    // direto no dashboard (sem nunca passar pelo onboarding de novo) e
    // qualquer INSERT em transacoes/metas era bloqueado pela RLS.
    // garantirClienteExiste() repara isso automaticamente, sem exigir
    // que o cliente refaça o onboarding.
    await garantirClienteExiste(user);

    // ── FLUXO CLIENTE ──
    try {
        const { data: usuario } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('apelido')
            .eq('id', user.id)
            .maybeSingle();
        if (usuario?.apelido) {
            UIModule.setText('clientNameDisplay', usuario.apelido);
        }
    } catch (_) {}

    ClientModule.setClientId(user.id);
    await populateCategorySelect();
    UIModule.showScreen('clientScreen');
    await loadClientDashboard();
}

/**
 * Garante que existe uma linha em `clientes` com id = user.id — sem essa
 * linha, a RLS de transacoes/metas/planejamentos bloqueia qualquer
 * operação do cliente (elas dependem de EXISTS/comparação contra
 * clientes.id). Idempotente: se a linha já existir, não faz nada.
 * Chamada em todo login (routeByRole), não só no cadastro/onboarding —
 * é isso que torna a correção autocurativa para contas já existentes.
 *
 * ATUALIZAÇÃO — RECONCILIAÇÃO DE DUPLICATAS: em vez de um INSERT
 * direto, chama a função reconciliar_cliente_no_registro() (RPC no
 * Supabase). Ela faz o INSERT da mesma forma, mas ANTES procura se já
 * existe uma ficha "placeholder" com o mesmo email (criada manualmente
 * pelo admin antes do cliente se registrar) — se achar, transfere
 * qualquer transação/meta/planejamento já lançado nela para o id
 * definitivo e apaga a ficha antiga, evitando o bug de "cliente
 * duplicado" (confirmado em produção: o mesmo cliente chegou a
 * aparecer 3 vezes em Meus Clientes).
 */
async function garantirClienteExiste(user) {
    try {
        const { data: jaExiste, error: selectError } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (selectError) throw selectError;
        if (jaExiste) return; // já existe — nada a fazer

        // Busca nome/apelido já preenchidos em `usuarios` para não pedir
        // esses dados de novo — o cliente já os informou no cadastro.
        const { data: usuario } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('nome_completo, apelido')
            .eq('id', user.id)
            .maybeSingle();

        const nome = usuario?.nome_completo || usuario?.apelido || user.email?.split('@')[0] || 'Cliente';

        const { error: rpcError } = await supabaseClient.rpc('reconciliar_cliente_no_registro', {
            p_nome:  nome,
            p_email: user.email
        });

        if (rpcError) throw rpcError;

        console.log('✅ garantirClienteExiste: linha em clientes criada/reconciliada retroativamente para', user.email);
    } catch (error) {
        // Não bloqueia o login se isso falhar — só regista o problema.
        // Se a causa for RLS (client_insert_self exige auth.uid() = id,
        // o que já é o caso aqui), o próximo passo é investigar a policy;
        // se for outra coisa, o cliente ainda consegue ver o dashboard,
        // só não conseguirá lançar transações até isto ser resolvido.
        console.error('❌ garantirClienteExiste: falha ao verificar/criar linha em clientes:', error.message);
    }
}

// ================================================
// LOGIN UNIFICADO
// ================================================

async function handleLogin(event) {
    event.preventDefault();
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl  = document.getElementById('loginError');

    if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }

    if (!email || !password) {
        showLoginError('Preenche o email e a senha.');
        return;
    }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

    try {
        const { user, role } = await AuthModule.login(email, password);
        await routeByRole(user, role);
    } catch (error) {
        const msg = error.message || '';

        if (msg.includes('Invalid login credentials') || msg.includes('invalid_credentials')) {
            showLoginError(
                'Email não encontrado ou senha incorreta.',
                `Não tens conta? <a href="#" onclick="toggleScreen('registerScreen'); return false;" style="color:#6495ff; font-weight:700;">Criar conta grátis</a>`
            );
        } else if (msg.includes('Email not confirmed')) {
            showLoginError('Email ainda não confirmado. Verifica a tua caixa de entrada.');
        } else {
            showLoginError(msg || 'Erro ao entrar. Tenta novamente.');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    }
}

function showLoginError(msg, extra = '') {
    const errorEl = document.getElementById('loginError');
    if (errorEl) {
        errorEl.innerHTML = '⚠️ ' + msg + (extra ? '<br><span style="font-size:12px; margin-top:6px; display:block;">' + extra + '</span>' : '');
        errorEl.classList.remove('hidden');
    }
}

// ================================================
// CADASTRO — USUARIOS + USUARIOS_PERFIS
// ================================================

async function handleRegister(event) {
    event.preventDefault();

    const nome     = document.getElementById('registerNome')?.value.trim() || '';
    const apelido  = document.getElementById('registerApelido')?.value.trim() || '';
    const email    = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirm  = document.getElementById('registerPasswordConfirm')?.value || '';
    const errorEl  = document.getElementById('registerError');

    const showErr = (msg) => {
        if (errorEl) { errorEl.textContent = '⚠️ ' + msg; errorEl.classList.remove('hidden'); }
        else UIModule.showError(msg);
    };

    if (errorEl) errorEl.classList.add('hidden');

    if (!nome || !apelido || !email || !password) {
        showErr('Preenche todos os campos.'); return;
    }
    if (password.length < 6) { showErr('Senha mínima de 6 caracteres.'); return; }
    if (password !== confirm) { showErr('As senhas não coincidem.'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando conta...'; }

    try {
        // 1. Cria no Supabase Auth
        const user = await AuthModule.register(email, password);

        // 2. Insere em usuarios
        await supabaseClient.from(CONFIG.TABLES.USUARIOS).insert([{
            id:            user.id,
            nome_completo: nome,
            apelido:       apelido,
            created_at:    new Date().toISOString()
        }]);

        // 3. Insere em usuarios_perfis com role 'client'
        await supabaseClient.from(CONFIG.TABLES.USUARIOS_PERFIS).insert([{
            usuario_id: user.id,
            perfil:     'client',
            created_at: new Date().toISOString()
        }]);

        // 4. Cria/reconcilia a linha em `clientes` — a função RPC funde
        //    automaticamente com qualquer ficha "placeholder" que o
        //    admin já tenha criado manualmente com o mesmo email,
        //    evitando cliente duplicado (ver garantirClienteExiste
        //    para a explicação completa).
        await supabaseClient.rpc('reconciliar_cliente_no_registro', {
            p_nome:  nome,
            p_email: email
        });

        UIModule.showSuccess(`Conta criada! Bem-vindo, ${apelido}! Faz login agora.`);
        setTimeout(() => UIModule.showScreen('loginScreen'), 2000);

    } catch (error) {
        const msg = error.message || '';
        if (msg.includes('already registered') || msg.includes('already been registered')) {
            showErr('Este email já tem uma conta. Faz login.');
        } else {
            showErr(msg || 'Erro ao criar conta.');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Criar Conta'; }
    }
}

// ================================================
// ONBOARDING — USUARIOS + USUARIOS_PERFIS
// ================================================

async function checkOnboarding(user, role) {
    if (role === 'admin') return false;

    try {
        const { data } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .select('nome_completo, apelido')
            .eq('id', user.id)
            .maybeSingle();

        if (!data || !data.nome_completo || !data.apelido) return true;
        return false;
    } catch (_) {
        return true;
    }
}

async function handleOnboarding(event) {
    event.preventDefault();
    const nome    = document.getElementById('onboardingNome').value.trim();
    const apelido = document.getElementById('onboardingApelido').value.trim();
    const user    = AuthModule.getUser();

    if (!nome || !apelido) { UIModule.showError('Preenche todos os campos'); return; }

    const btn = event.target.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        // 1. Upsert em usuarios
        const { error: usuarioError } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS)
            .upsert({
                id:            user.id,
                nome_completo: nome,
                apelido:       apelido,
                created_at:    new Date().toISOString()
            });
        if (usuarioError) throw usuarioError;

        // 2. Garante registo em usuarios_perfis
        const { data: jaTemPerfil, error: selectError } = await supabaseClient
            .from(CONFIG.TABLES.USUARIOS_PERFIS)
            .select('id')
            .eq('usuario_id', user.id)
            .maybeSingle();
        if (selectError) throw selectError;

        if (!jaTemPerfil) {
            const { error: insertError } = await supabaseClient
                .from(CONFIG.TABLES.USUARIOS_PERFIS)
                .insert([{
                    usuario_id: user.id,
                    perfil:     'client',
                    created_at: new Date().toISOString()
                }]);
            if (insertError) throw insertError;
        }

        // 3. Garante/reconcilia registo na tabela clientes — a função RPC
        //    funde automaticamente com qualquer ficha "placeholder" que
        //    o admin já tenha criado manualmente com o mesmo email (ver
        //    garantirClienteExiste para a explicação completa).
        const { data: jaExisteCliente } = await supabaseClient
            .from(CONFIG.TABLES.CLIENTES)
            .select('id')
            .eq('id', user.id)
            .maybeSingle();

        if (!jaExisteCliente) {
            const { error: rpcError } = await supabaseClient.rpc('reconciliar_cliente_no_registro', {
                p_nome:  nome,
                p_email: user.email
            });
            if (rpcError) throw rpcError;
        }

        UIModule.showSuccess(`Bem-vindo, ${apelido}! 🎉`);

        // 4. Segue para o painel do cliente
        ClientModule.setClientId(user.id);
        UIModule.setText('clientNameDisplay', apelido);
        await populateCategorySelect();
        UIModule.showScreen('clientScreen');
        await loadClientDashboard();
    } catch (error) {
        console.error('❌ Erro em handleOnboarding:', error);
        UIModule.showError(error.message || 'Erro ao salvar perfil');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Continuar →'; }
    }
}

// ================================================
// LOGOUT
// ================================================

async function handleLogout() {
    if (!confirm('Tens a certeza que queres sair?')) return;

    try {
        await AuthModule.logout();
        window.location.reload();
    } catch (error) {
        UIModule.showError('Erro ao fazer logout');
    }
}

// ================================================
// PAINEL CLIENTE — DASHBOARD
// ================================================

async function loadClientDashboard() {
    try {
        const clientId = ClientModule.getClientId();
        const user     = AuthModule.getUser();

        try {
            const { data: usuario } = await supabaseClient
                .from(CONFIG.TABLES.USUARIOS).select('apelido').eq('id', user.id).maybeSingle();
            UIModule.setText('clientNameDisplay', usuario?.apelido || user?.email?.split('@')[0] || 'Cliente');
        } catch (_) {
            UIModule.setText('clientNameDisplay', user?.email?.split('@')[0] || 'Cliente');
        }

        await DashboardModule.renderClientDashboard(clientId);

        const goals = await GoalsModule.loadClientGoals(clientId);
        GoalsModule.renderGoals('clientMetasList', goals);

        await loadClientTransactions();
        await loadClientPlanning();

    } catch (error) {
        console.error('Erro dashboard cliente:', error);
        UIModule.showError('Erro ao carregar dashboard');
    }
}

// ── HISTÓRICO DE TRANSAÇÕES: cache local + filtros por período ──
// ATUALIZAÇÃO — HISTÓRICO FILTRÁVEL: `clienteTransacoesCache` guarda a
// última lista carregada do banco. Trocar de filtro (período rápido,
// intervalo personalizado, tipo) NÃO refaz a consulta ao Supabase —
// só reaplica o filtro em cima do que já está em memória, via
// TransactionsModule.renderTransactions(). Isso é recarregado (refetch
// de verdade) sempre que uma transação é adicionada/editada/excluída
// com sucesso, via loadClientDashboard() -> loadClientTransactions().
let clienteTransacoesCache = [];

async function loadClientTransactions() {
    try {
        const clientId = ClientModule.getClientId();
        clienteTransacoesCache = await DatabaseModule.getTransactionsByClient(clientId);
        renderClientTransactionHistory();
    } catch (error) {
        console.error('Erro transações cliente:', error);
    }
}

/**
 * Lê o estado atual dos controles de filtro do histórico e monta o
 * objeto de filtro que TransactionsModule.renderTransactions() espera
 * ({ type, dataInicio, dataFim }). Centralizado aqui para que tanto o
 * carregamento inicial quanto qualquer mudança nos controles cheguem
 * ao mesmo resultado.
 */
function getFiltroHistoricoAtual() {
    const filtro  = {};
    const tipo    = document.getElementById('histFiltroTipo')?.value || '';
    const periodo = document.getElementById('histPeriodoRapido')?.value || 'todos';

    if (tipo) filtro.type = tipo;

    // getDataDeHojeFormatoInput vem de smart-input.js (Smart Date) —
    // reaproveitado aqui para manter uma ÚNICA forma de calcular "hoje"
    // em fuso local no projeto inteiro, evitando o mesmo bug de UTC que
    // já foi corrigido lá (toISOString() "voltando" um dia).
    const hojeStr = typeof getDataDeHojeFormatoInput === 'function'
        ? getDataDeHojeFormatoInput()
        : formatarDataLocal(new Date());

    if (periodo === 'hoje') {
        filtro.dataInicio = hojeStr;
        filtro.dataFim    = hojeStr;
    } else if (periodo === '7dias') {
        const seteDiasAtras = new Date();
        seteDiasAtras.setDate(seteDiasAtras.getDate() - 6); // inclui hoje = 7 dias no total
        filtro.dataInicio = formatarDataLocal(seteDiasAtras);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'mes') {
        const agora       = new Date();
        const primeiroDia = new Date(agora.getFullYear(), agora.getMonth(), 1);
        filtro.dataInicio = formatarDataLocal(primeiroDia);
        filtro.dataFim    = hojeStr;
    } else if (periodo === 'personalizado') {
        const inicio = document.getElementById('histDataInicio')?.value;
        const fim    = document.getElementById('histDataFim')?.value;
        if (inicio) filtro.dataInicio = inicio;
        if (fim)    filtro.dataFim    = fim;
    }
    // periodo === 'todos' -> sem filtro de data nenhum

    return filtro;
}

// Mesma lógica de formatação local de getDataDeHojeFormatoInput (smart-
// input.js), mas aceitando qualquer data (não só "agora") — usada para
// calcular os limites de "últimos 7 dias" e "este mês".
function formatarDataLocal(d) {
    const ano = d.getFullYear();
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const dia = String(d.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function renderClientTransactionHistory() {
    const filtro = getFiltroHistoricoAtual();
    TransactionsModule.renderTransactions('transactionHistoryList', filtro, clienteTransacoesCache);
}

/**
 * Liga os controles de filtro do histórico (período rápido, datas
 * personalizadas, tipo). Chamada uma vez em initializeApp(). Mostra/
 * esconde a linha de datas personalizadas conforme o período rápido
 * escolhido, e sempre reaplica o filtro (client-side, sem refetch)
 * a cada mudança.
 */
function initHistoryFilters() {
    const selectPeriodo      = document.getElementById('histPeriodoRapido');
    const linhaPersonalizada = document.getElementById('histPeriodoPersonalizadoRow');
    const inputInicio        = document.getElementById('histDataInicio');
    const inputFim           = document.getElementById('histDataFim');
    const selectTipo         = document.getElementById('histFiltroTipo');

    if (!selectPeriodo) return; // elementos não existem nesta página — não faz nada

    selectPeriodo.addEventListener('change', () => {
        const personalizado = selectPeriodo.value === 'personalizado';
        linhaPersonalizada?.classList.toggle('hidden', !personalizado);
        renderClientTransactionHistory();
    });

    inputInicio?.addEventListener('change', renderClientTransactionHistory);
    inputFim?.addEventListener('change', renderClientTransactionHistory);
    selectTipo?.addEventListener('change', renderClientTransactionHistory);
}

async function loadClientPlanning() {
    try {
        const clientId  = ClientModule.getClientId();
        const plannings = await PlanningModule.loadClientPlannings(clientId);

        const container = document.getElementById('clientPlanningList');
        if (container) {
            if (!plannings || plannings.length === 0) {
                container.innerHTML = '<p class="empty-state">Aguardando planejamento do administrador...</p>';
            } else {
                container.innerHTML = plannings.map(p => `
                    <div class="card" style="margin-bottom: 15px;">
                        <h3>${p.titulo}</h3>
                        ${p.recomendacoes ? `<p style="color:#a0a0b0; margin-top:10px;">${p.recomendacoes}</p>` : ''}
                        ${p.detalhes      ? `<p style="color:#6b7c8f; margin-top:8px; font-size:13px;">${p.detalhes}</p>` : ''}
                    </div>
                `).join('');
            }
        }

        await atualizarAreaSolicitacaoPlanejamento(clientId);
    } catch (error) {
        console.error('Erro planning cliente:', error);
    }
}

// ================================================
// SOLICITAÇÃO DE PLANEJAMENTO (CLIENTE)
// ================================================
// Antes não existia NENHUMA forma do cliente avisar o admin que queria
// um planejamento — a aba só mostrava uma mensagem passiva de espera.
// Agora, se não houver planejamento nenhum ainda, aparece um botão
// "Solicitar Planejamento"; se já houver uma solicitação pendente,
// mostra isso em vez do botão (evita pedir duas vezes). O admin vê e
// atende essas solicitações em admin.html (ver planejamentos.js).

async function atualizarAreaSolicitacaoPlanejamento(clientId) {
    const area = document.getElementById('clientPlanningRequestArea');
    if (!area) return;

    try {
        const { data, error } = await supabaseClient
            .from('solicitacoes_planejamento')
            .select('id, created_at')
            .eq('client_id', clientId)
            .eq('status', 'pendente')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            const dataFormatada = new Date(data.created_at).toLocaleDateString('pt-BR');
            area.innerHTML = `
                <div class="empty-state" style="padding:16px; font-style:normal; text-align:left; background:rgba(100,150,255,0.06); border-radius:10px; border:1px solid rgba(100,150,255,0.15); margin-bottom:15px;">
                    📨 Você solicitou um planejamento em ${dataFormatada}. O administrador foi avisado e vai criar em breve.
                </div>
            `;
        } else {
            area.innerHTML = `
                <button type="button" class="btn btn--secondary" onclick="abrirModalSolicitarPlanejamento()" style="margin-bottom:15px;">
                    📩 Solicitar Planejamento
                </button>
            `;
        }
    } catch (err) {
        console.error('❌ atualizarAreaSolicitacaoPlanejamento:', err.message);
        area.innerHTML = '';
    }
}

function abrirModalSolicitarPlanejamento() {
    const campoMensagem = document.getElementById('solicitarPlanejamentoMensagem');
    if (campoMensagem) campoMensagem.value = '';
    UIModule.openModal('modalSolicitarPlanejamento');
}

async function handleEnviarSolicitacaoPlanejamento() {
    const clientId = ClientModule.getClientId();
    const mensagem = document.getElementById('solicitarPlanejamentoMensagem')?.value.trim() || '';

    const btn = document.getElementById('btnEnviarSolicitacaoPlanejamento');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

    try {
        const { error } = await supabaseClient
            .from('solicitacoes_planejamento')
            .insert({ client_id: clientId, mensagem: mensagem || null });

        if (error) throw error;

        UIModule.closeModal('modalSolicitarPlanejamento');
        UIModule.showSuccess('Solicitação enviada! O administrador foi avisado.');
        await loadClientPlanning();
    } catch (err) {
        console.error('❌ handleEnviarSolicitacaoPlanejamento:', err.message);
        UIModule.showError(err.message || 'Erro ao enviar a solicitação.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar Solicitação'; }
    }
}

// ================================================
// EDIÇÃO E EXCLUSÃO DE TRANSAÇÕES
// ================================================
// ATUALIZAÇÃO — o cliente agora pode editar (categoria, valor, data,
// descrição) ou excluir qualquer transação já lançada, direto pelo
// histórico (botões ✏️/🗑️ em cada item, ligados por
// ligarBotoesDeAcaoDaTransacao em transactions.js). Casos reais que
// isso resolve: categoria errada, valor digitado errado, ou uma
// despesa que precisa ser removida porque o pagamento foi estornado.
//
// NOTA DE DESIGN: editar uma transação NÃO atualiza a regra aprendida
// (regras_aprendidas) para aquela descrição — é uma correção pontual
// daquele lançamento específico, não necessariamente um sinal de que
// a classificação automática está errada para todo mundo que usar o
// mesmo termo no futuro. Quem quiser corrigir a regra aprendida em si
// deve editar/relançar via o formulário normal (que já aprende a cada
// "Registar" bem-sucedido).

let transacaoEmEdicaoId = null;

/**
 * Abre o modal de edição já preenchido com os dados da transação
 * (buscada do cache local `clienteTransacoesCache`, sem round-trip ao
 * banco). Popula o dropdown de categoria do modal com a categoria
 * atual já selecionada.
 */
async function abrirModalEditarTransacao(transactionId) {
    const transacao = clienteTransacoesCache.find(t => t.id === transactionId);
    if (!transacao) {
        UIModule.showError('Transação não encontrada — tenta recarregar a página.');
        return;
    }

    transacaoEmEdicaoId = transactionId;

    document.getElementById('editTransId').value          = transactionId;
    document.getElementById('editTransDescription').value = transacao.descricao || '';
    document.getElementById('editTransValue').value        = transacao.valor;
    document.getElementById('editTransDate').value          = transacao.data_competencia || '';

    await popularCategoriaEdicao(transacao.categoria_id);

    // Pré-seleciona a meta já vinculada a esta transação (se houver —
    // `transacao.meta_id` vem direto do `select('*')` de
    // getTransactionsByClient). O valor precisa ser setado ANTES de
    // chamar atualizarSeletorDeMeta: ela lê select.value logo no início
    // (antes de qualquer await) para preservar a seleção ao reconstruir
    // as opções — ver comentário na própria função.
    const seletorMeta = document.getElementById('editTransMeta');
    if (seletorMeta) seletorMeta.value = transacao.meta_id || '';
    await atualizarSeletorDeMeta('editTransCategory', 'editTransMetaWrapper', 'editTransMeta');

    UIModule.openModal('editTransactionModal');
}

/**
 * Carrega as categorias reais e monta o painel do dropdown de
 * categoria DENTRO do modal de edição — reaproveita montarPainelAgrupado
 * (mesma função usada no formulário principal de "Registar Transação"),
 * só que aplicada aos ids do modal de edição (editTransCategory*).
 */
async function popularCategoriaEdicao(categoriaSelecionadaId) {
    const trigger     = document.getElementById('editTransCategoryTrigger');
    const triggerText = document.getElementById('editTransCategoryTriggerText');
    const panel       = document.getElementById('editTransCategoryPanel');
    const hiddenInput = document.getElementById('editTransCategory');
    if (!trigger || !triggerText || !panel || !hiddenInput) return;

    trigger.disabled = true;
    triggerText.textContent = 'Carregando categorias...';

    try {
        const categorias = await DatabaseModule.getCategorias();
        panel.innerHTML = montarPainelAgrupado(categorias);

        const categoriaAtual = categorias.find(c => c.id === categoriaSelecionadaId);
        hiddenInput.value        = categoriaSelecionadaId || '';
        triggerText.textContent  = categoriaAtual?.nome || 'Selecione uma categoria';
        trigger.disabled = false;

        if (categoriaAtual) {
            panel.querySelector(`.custom-select__option[data-id="${categoriaAtual.id}"]`)?.classList.add('selected');
        }

        ligarCliquesDoPainelEdicao();
    } catch (err) {
        console.error('❌ popularCategoriaEdicao:', err.message);
        triggerText.textContent = '⚠️ Falha ao carregar — toque para tentar de novo';
        trigger.disabled = false;
    }
}

// Liga os cliques nas opções do painel de categoria DO MODAL DE
// EDIÇÃO — espelha ligarCliquesDoPainel() (formulário principal), mas
// aponta para os ids editTransCategory*, para não conflitar com o
// dropdown do formulário de "Registar Transação".
function ligarCliquesDoPainelEdicao() {
    const panel = document.getElementById('editTransCategoryPanel');
    if (!panel) return;

    panel.querySelectorAll('.custom-select__option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('editTransCategory').value = btn.dataset.id;
            document.getElementById('editTransCategoryTriggerText').textContent = btn.dataset.nome;

            panel.querySelectorAll('.custom-select__option.selected').forEach(el => el.classList.remove('selected'));
            btn.classList.add('selected');

            fecharPainelEdicaoCategorias();
            atualizarSeletorDeMeta('editTransCategory', 'editTransMetaWrapper', 'editTransMeta');
        });
    });
}

function abrirPainelEdicaoCategorias() {
    const trigger = document.getElementById('editTransCategoryTrigger');
    const panel   = document.getElementById('editTransCategoryPanel');
    if (!trigger || !panel) return;

    posicionarEReparentarPainel(trigger, panel);
    panel.classList.remove('hidden');
    trigger.classList.add('open');
}

function fecharPainelEdicaoCategorias() {
    document.getElementById('editTransCategoryPanel')?.classList.add('hidden');
    document.getElementById('editTransCategoryTrigger')?.classList.remove('open');
}

// Liga o botão/trigger do dropdown de categoria do modal de edição —
// chamado uma vez em initializeApp() (o modal já existe no HTML desde
// o carregamento da página, só fica escondido via .hidden).
function initEditCategoryDropdown() {
    const trigger = document.getElementById('editTransCategoryTrigger');
    const wrapper = document.getElementById('editTransCategoryWrapper');
    if (!trigger || !wrapper) return;

    trigger.addEventListener('click', () => {
        const abrindo = document.getElementById('editTransCategoryPanel')?.classList.contains('hidden');
        if (abrindo) abrirPainelEdicaoCategorias();
        else fecharPainelEdicaoCategorias();
    });

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('editTransCategoryPanel');
        if (!wrapper.contains(e.target) && !(panel && panel.contains(e.target))) {
            fecharPainelEdicaoCategorias();
        }
    });
}

async function handleSalvarEdicaoTransacao() {
    const id          = document.getElementById('editTransId').value;
    const descricao   = document.getElementById('editTransDescription').value;
    const categoriaId = document.getElementById('editTransCategory').value;
    const valor       = parseFloat(document.getElementById('editTransValue').value);
    const data        = document.getElementById('editTransDate').value;
    const metaId      = document.getElementById('editTransMeta')?.value || null;

    if (!categoriaId)          { UIModule.showError('Seleciona uma categoria'); return; }
    if (!data)                 { UIModule.showError('Data é obrigatória'); return; }
    if (!valor || valor <= 0)  { UIModule.showError('Informa um valor válido'); return; }

    const btn = document.getElementById('btnSalvarEdicaoTransacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
        const categorias = await DatabaseModule.getCategorias();
        const cat        = categorias.find(c => c.id === categoriaId);
        if (!cat) throw new Error('Categoria inválida');

        // meta_id precisa ser enviado SEMPRE (mesmo null) — se
        // omitíssemos este campo quando a categoria deixa de ser
        // 'investimento', o UPDATE parcial do Supabase não tocaria a
        // coluna, o vínculo antigo ficaria orfão para sempre, e o
        // trigger de sincronização não veria NENHUMA mudança em
        // meta_id (OLD e NEW ficariam iguais) — logo, o valor
        // continuaria contando na meta antiga por engano.
        await ClientModule.updateTransaction(id, {
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao,
            tipo: cat.tipo,
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null
        });

        fecharModalEdicaoTransacao();
        UIModule.showSuccess('Transação atualizada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao atualizar transação');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar Alterações'; }
    }
}

// Fecha o modal de edição E o painel de categoria (se estiver aberto)
// juntos. Necessário porque, com a correção de posicionamento
// flutuante, o painel pode ter sido reparentado para <body> — se
// fechássemos só o modal, o painel ficaria "flutuando" solto na tela,
// visualmente desconectado do formulário que já sumiu.
function fecharModalEdicaoTransacao() {
    fecharPainelEdicaoCategorias();
    UIModule.closeModal('editTransactionModal');
}

// Excluir a partir de DENTRO do modal de edição (usa o id já
// carregado em #editTransId).
async function handleDeletarTransacao() {
    const id = document.getElementById('editTransId').value;
    if (!id) return;
    await excluirTransacaoComConfirmacao(id, fecharModalEdicaoTransacao);
}

// Excluir direto do botão 🗑️ no item do histórico, sem abrir o modal
// (ligado por transactions.js/ligarBotoesDeAcaoDaTransacao).
async function handleDeletarTransacaoRapido(transactionId) {
    await excluirTransacaoComConfirmacao(transactionId);
}

async function excluirTransacaoComConfirmacao(transactionId, aoConcluir) {
    if (!confirm('Tens a certeza que queres excluir esta transação? Esta ação não pode ser desfeita.')) return;

    try {
        await ClientModule.deleteTransaction(transactionId);
        UIModule.showSuccess('Transação excluída!');
        if (typeof aoConcluir === 'function') aoConcluir();
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao excluir transação');
    }
}

// ── ADICIONAR TRANSAÇÃO (CLIENTE) ──
// ATUALIZAÇÃO — SMART INPUT / SMART DATE: antes de validar/salvar,
// garante que uma classificação automática (disparada pelo onblur da
// descrição, ver smart-input.js) já tenha terminado. Se o campo de
// categoria ainda estiver vazio nesse ponto (ex: cliente nunca saiu do
// campo Descrição antes de clicar em Registar), tenta classificar de
// última hora. Depois de registar com sucesso, reinjeta a data de hoje
// no formulário já resetado (initForm(true)), deixando-o pronto para o
// próximo lançamento. As chamadas são protegidas por
// `typeof === 'function'` para que o formulário continue funcionando
// normalmente (100% manual) mesmo que smart-input.js não esteja
// carregado na página.

async function handleAddTransaction(event) {
    event.preventDefault();

    // Smart Input: espera classificação em andamento, se houver
    if (typeof aguardarClassificacaoSmartInputPendente === 'function') {
        await aguardarClassificacaoSmartInputPendente();
    }

    // Smart Input: se a categoria ainda não foi preenchida, tenta
    // classificar a descrição já digitada antes de bloquear o envio
    if (!document.getElementById('transCategory').value &&
        typeof autoClassify === 'function') {
        const descricaoAtual = document.getElementById('transDescription').value.trim();
        if (descricaoAtual) await autoClassify(descricaoAtual);
    }

    const clientId    = ClientModule.getClientId();
    const categoriaId = document.getElementById('transCategory').value;
    const valor       = parseFloat(document.getElementById('transValue').value);
    const data        = document.getElementById('transDate').value;
    const descricao   = document.getElementById('transDescription').value;
    // Vínculo opcional com uma Meta/Caixinha — só existe/aparece
    // quando a categoria escolhida é do grupo 'investimento' (ver
    // atualizarSeletorDeMeta). Se o campo não existir na página ou
    // estiver vazio, metaId fica null — transação comum, sem alocação.
    const metaId      = document.getElementById('transMeta')?.value || null;

    if (!categoriaId) { UIModule.showError('Seleciona uma categoria'); return; }
    if (!data)         { UIModule.showError('Data é obrigatória'); return; }

    try {
        const categorias = await DatabaseModule.getCategorias();
        const cat        = categorias.find(c => c.id === categoriaId);
        if (!cat) throw new Error('Categoria inválida');

        await ClientModule.addTransaction({
            client_id:        clientId,
            categoria_id:     categoriaId,
            valor,
            data_competencia: data,
            descricao,
            tipo: cat.tipo,
            meta_id: cat.grupo === 'investimento' ? (metaId || null) : null
        });

        // Aprendizado de Categorias (regras-aprendidas.js): grava (ou
        // corrige, se já existia) a regra termo→categoria para este
        // cliente, usando a categoria FINAL confirmada no Registar —
        // seja ela a sugestão aceita como estava, seja uma correção
        // manual feita pelo cliente antes de salvar. Roda depois do
        // addTransaction ter tido sucesso, e é isolado num try/catch
        // próprio: uma falha ao salvar a REGRA nunca deve fazer parecer
        // que a TRANSAÇÃO em si falhou (ela já foi salva na linha acima).
        if (typeof RegrasAprendidasModule !== 'undefined' && descricao.trim()) {
            try {
                await RegrasAprendidasModule.salvarOuAtualizarRegra({
                    clienteId:   clientId,
                    termoBusca:  descricao,
                    categoriaId: cat.id,
                    tipo:        cat.tipo
                });
            } catch (regraErr) {
                console.warn('⚠️ Falha ao salvar regra aprendida (transação já foi registrada normalmente):', regraErr.message);
            }
        }

        event.target.reset();

        // Smart Date: o reset() acima limpa o campo de data também —
        // reinjeta a data de hoje (forçado, já que o campo ficou vazio)
        // para o próximo lançamento já vir pronto.
        if (typeof initForm === 'function') {
            initForm(true);
        }

        // O reset() limpa a categoria também — esconde o seletor de
        // meta (só reaparece quando uma categoria de investimento for
        // escolhida de novo no próximo lançamento).
        atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');

        // LOOP DE LANÇAMENTO RÁPIDO: depois de registar (seja clicando
        // no botão, seja apertando Enter no campo Valor — Enter dentro
        // de um <form> já dispara o submit por padrão do navegador),
        // o foco volta sozinho para a Descrição. Isso permite lançar
        // várias transações seguidas só pelo teclado: digita a
        // descrição, Tab/clica a categoria sugerida, digita o valor,
        // Enter — e já está pronto pra digitar a próxima descrição,
        // sem precisar tocar no mouse a cada lançamento.
        document.getElementById('transDescription')?.focus();

        UIModule.showSuccess('Transação registada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao registar transação');
    }
}

// ================================================
// VÍNCULO OPCIONAL: TRANSAÇÃO → META/CAIXINHA
// ================================================
// Quando a categoria escolhida (no formulário principal OU no modal de
// edição) é do grupo 'investimento' (Aporte em Investimentos,
// Previdência Privada, Reserva de Emergência), aparece um seletor
// extra e OPCIONAL: "Vincular a uma Meta". Se o cliente escolher uma,
// o valor da transação passa a contar automaticamente no progresso
// daquela meta (barra de progresso em "Minhas Metas").
//
// IMPORTANTE: a sincronização em si (somar/subtrair do
// metas.valor_economizado) acontece via TRIGGER no banco
// (trg_sync_valor_economizado_meta — ver migração), não aqui. Esta
// função só cuida da UI: mostrar/esconder o campo certo e popular as
// opções com as metas reais do cliente. Isso garante que o progresso
// da meta fique correto não importa por qual caminho a transação foi
// criada (formulário manual, edição, OU a importação em massa de
// OFX/CSV) — o trigger cobre todos, sem precisar duplicar esta lógica
// em cada lugar.
//
// Chamada depois de QUALQUER caminho que preencha a categoria: clique
// manual (ligarCliquesDoPainel/ligarCliquesDoPainelEdicao), Smart
// Input (smart-input.js) e Aprendizado de Categorias
// (regras-aprendidas.js) — por isso recebe os ids como parâmetro, em
// vez de estar hard-coded para um só formulário.
//
// @param {string} idCategoriaHidden - id do <input type="hidden"> com o categoria_id atual
// @param {string} idWrapper         - id do <div> que envolve o seletor (mostrado/escondido)
// @param {string} idSelect          - id do <select> de metas
async function atualizarSeletorDeMeta(idCategoriaHidden, idWrapper, idSelect) {
    const wrapper        = document.getElementById(idWrapper);
    const select          = document.getElementById(idSelect);
    const categoriaAtual  = document.getElementById(idCategoriaHidden)?.value;
    if (!wrapper || !select) return;

    if (!categoriaAtual) {
        wrapper.classList.add('hidden');
        select.value = '';
        return;
    }

    try {
        // Reaproveita o cache de categorias do Smart Input quando
        // disponível (evita refetch a cada seleção); cai para uma busca
        // direta se smart-input.js não estiver carregado nesta página.
        const categorias = typeof getCategoriasParaClassificacao === 'function'
            ? await getCategoriasParaClassificacao()
            : await DatabaseModule.getCategorias();

        const categoria = categorias.find(c => c.id === categoriaAtual);

        if (!categoria || categoria.grupo !== 'investimento') {
            wrapper.classList.add('hidden');
            select.value = '';
            return;
        }

        const clientId = ClientModule.getClientId();
        const metas    = await DatabaseModule.getMetasByClient(clientId);

        if (!metas.length) {
            // Sem nenhuma meta cadastrada ainda — não faz sentido
            // mostrar um seletor vazio; o cliente pode criar uma na aba
            // "Metas" e o campo passa a aparecer no próximo lançamento.
            wrapper.classList.add('hidden');
            select.value = '';
            return;
        }

        // Preserva a seleção atual do <select>, se ainda for válida —
        // isto é o que permite ao modal de edição pré-selecionar a meta
        // já vinculada: quem chama esta função pode setar select.value
        // ANTES de chamá-la (ver abrirModalEditarTransacao), e esse
        // valor sobrevive à reconstrução das opções abaixo.
        const valorSelecionadoAntes = select.value;

        select.innerHTML = '<option value="">Não vincular a nenhuma meta</option>' +
            metas.map(m => `<option value="${m.id}">${m.nome}</option>`).join('');

        if (valorSelecionadoAntes && metas.some(m => m.id === valorSelecionadoAntes)) {
            select.value = valorSelecionadoAntes;
        }

        wrapper.classList.remove('hidden');
    } catch (err) {
        console.error('❌ atualizarSeletorDeMeta:', err.message);
        wrapper.classList.add('hidden');
    }
}

// ── ADICIONAR META (CLIENTE) ──

async function handleAddMeta(event) {
    event.preventDefault();
    const clientId = ClientModule.getClientId();
    const nome     = document.getElementById('metaName').value.trim();
    const valor    = parseFloat(document.getElementById('metaValue').value);

    try {
        await ClientModule.addGoal({ client_id: clientId, nome, valor_necessario: valor, valor_economizado: 0 });
        event.target.reset();
        UIModule.showSuccess('Meta criada!');
        await loadClientDashboard();
    } catch (_) { UIModule.showError('Erro ao criar meta'); }
}

// ── PERFIL CLIENTE ──

function showClientProfile() {
    const user = AuthModule.getUser();
    UIModule.setText('profileClientName', user?.user_metadata?.name || user?.email || 'Cliente');
    UIModule.setText('profileClientEmail', user?.email || '');
    UIModule.openModal('clientProfileModal');
}

// ================================================
// INICIALIZAÇÃO
// ================================================

async function waitForSupabase(maxAttempts = 20) {
    for (let i = 0; i < maxAttempts; i++) {
        if (typeof supabaseClient !== 'undefined' && supabaseClient !== null) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

// ================================================
// CATEGORIAS (plano de contas)
// ================================================
// ANTES: populateCategorySelect() só era chamada 1x no login. Se a
// consulta voltasse vazia (0 linhas) ou desse erro (RLS, coluna,
// rede), a função saía/entrava no catch em silêncio — o <select>
// ficava travado no placeholder "Carregando categorias..." para
// sempre, sem qualquer forma de recuperação sem recarregar a página.
//
// AGORA: o estado do carregamento fica visível (no próprio select) e
// visível para o utilizador (toast), e há retentativa automática
// sempre que a aba "Transações" é reaberta ou o campo recebe foco —
// sem precisar recarregar a página.

let categoriasEstado = 'idle'; // 'idle' | 'carregando' | 'ok' | 'vazio' | 'erro'

// Rótulos amigáveis pra agrupar o select por `grupo` — o cliente não
// precisa saber o que é "despesa"/"receita" tecnicamente, o sistema
// já infere isso sozinho a partir da categoria escolhida.
const GRUPO_LABEL_SELECT = {
    essencial:      '🟠 Essenciais',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimentos',
    renda:          '📈 Renda'
};

function setCategorySelectState(state, categorias = []) {
    const trigger     = document.getElementById('transCategoryTrigger');
    const triggerText = document.getElementById('transCategoryTriggerText');
    const panel       = document.getElementById('transCategoryPanel');
    const hiddenInput = document.getElementById('transCategory');
    if (!trigger || !triggerText || !panel || !hiddenInput) return;

    fecharPainelDeCategorias();

    if (state === 'carregando') {
        trigger.disabled = true;
        triggerText.textContent = 'Carregando categorias...';
        panel.innerHTML = '';
        hiddenInput.value = '';
    } else if (state === 'ok') {
        trigger.disabled = false;
        triggerText.textContent = 'Selecione uma categoria';
        hiddenInput.value = '';
        panel.innerHTML = montarPainelAgrupado(categorias);
        ligarCliquesDoPainel();
    } else if (state === 'vazio') {
        trigger.disabled = true;
        triggerText.textContent = 'Nenhuma categoria cadastrada';
        panel.innerHTML = '';
        hiddenInput.value = '';
    } else if (state === 'erro') {
        trigger.disabled = false; // habilitado para permitir tocar e tentar de novo
        triggerText.textContent = '⚠️ Falha ao carregar — toque aqui para tentar de novo';
        panel.innerHTML = '';
        hiddenInput.value = '';
    }
}

// Agrupa as categorias por `grupo` (essencial/estilo_de_vida/
// investimento/renda) em seções visuais dentro do painel próprio,
// na ordem que faz mais sentido pro cliente ver primeiro suas
// despesas do dia a dia. O campo `tipo` (receita/despesa) nunca
// aparece no texto — é só metadado interno que o sistema usa
// sozinho (ex: no dashboard, no saldo).
const ORDEM_GRUPOS = ['essencial', 'estilo_de_vida', 'investimento', 'renda'];

function montarPainelAgrupado(categorias) {
    const porGrupo = {};
    categorias.forEach(c => {
        const grupo = c.grupo || 'outros';
        if (!porGrupo[grupo]) porGrupo[grupo] = [];
        porGrupo[grupo].push(c);
    });

    const grupos = [
        ...ORDEM_GRUPOS.filter(g => porGrupo[g]),
        ...Object.keys(porGrupo).filter(g => !ORDEM_GRUPOS.includes(g))
    ];

    return grupos.map(grupo => {
        const label   = GRUPO_LABEL_SELECT[grupo] || grupo;
        const options = porGrupo[grupo]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .map(c => `<button type="button" class="custom-select__option" data-id="${c.id}" data-nome="${c.nome}">${c.nome}</button>`)
            .join('');
        return `
            <div class="custom-select__group">
                <div class="custom-select__group-label">${label}</div>
                ${options}
            </div>
        `;
    }).join('');
}

// ── POSICIONAMENTO FLUTUANTE DOS DROPDOWNS DE CATEGORIA ────────
// CORREÇÃO: o painel de categoria (.custom-select__panel) é
// `position: absolute` relativo ao seu `.custom-select` — isso
// funciona bem quando o dropdown está solto na página, mas quebra
// quando está DENTRO de um contêiner com `overflow` (ex: o modal de
// edição de transação, cujo `.modal__content` tem `overflow-y:auto` e
// `max-height:90vh`): o painel fica CORTADO pela borda do contêiner,
// escondendo tanto os itens de baixo quanto a própria barra de
// rolagem interna do painel (que existe no CSS, mas nunca aparecia
// porque a região onde ela ficaria já tinha sido cortada). O mesmo
// pode acontecer no formulário principal em telas pequenas (mobile),
// onde sobra pouco espaço vertical.
//
// A correção: ao abrir, o painel é (1) reparentado para ser filho
// direto de <body> — isso evita qualquer clipping por overflow de
// ancestrais, e também evita que `backdrop-filter` em ancestrais
// (usado em .card/.login-box) crie um "containing block" alternativo
// para elementos fixed, o que bagunçaria as coordenadas calculadas
// abaixo — e (2) posicionado com `position: fixed` usando a posição
// REAL do botão-gatilho na tela (getBoundingClientRect), com
// max-height calculado a partir do espaço realmente disponível até a
// borda da tela. Se não houver espaço suficiente abaixo do botão
// (comum no mobile, com o navbar fixo ocupando a parte de baixo), o
// painel abre para CIMA automaticamente.
function posicionarEReparentarPainel(trigger, panel) {
    if (panel.parentElement !== document.body) {
        document.body.appendChild(panel);
    }

    const rect            = trigger.getBoundingClientRect();
    const margem           = 10; // respiro antes da borda da tela / navbar mobile
    const espacoAbaixo      = window.innerHeight - rect.bottom - margem;
    const espacoAcima       = rect.top - margem;
    const alturaMaximaBase  = 280; // mesmo valor do max-height original em style.css
    const abreParaCima      = espacoAbaixo < 160 && espacoAcima > espacoAbaixo;
    const alturaDisponivel  = abreParaCima ? espacoAcima : espacoAbaixo;

    panel.style.position  = 'fixed';
    panel.style.left      = `${rect.left}px`;
    panel.style.width     = `${rect.width}px`;
    panel.style.maxHeight = `${Math.max(120, Math.min(alturaMaximaBase, alturaDisponivel))}px`;

    if (abreParaCima) {
        panel.style.top    = 'auto';
        panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    } else {
        panel.style.top    = `${rect.bottom + 6}px`;
        panel.style.bottom = 'auto';
    }
}

// Reposiciona (ou fecha, se não for mais possível calcular) qualquer
// painel de categoria aberto quando a janela é redimensionada — evita
// que o painel fique flutuando num lugar errado após rotacionar o
// celular ou redimensionar a janela no desktop.
function religarReposicionamentoAoRedimensionar() {
    window.addEventListener('resize', () => {
        const combinacoes = [
            ['transCategoryTrigger', 'transCategoryPanel'],
            ['editTransCategoryTrigger', 'editTransCategoryPanel']
        ];
        combinacoes.forEach(([triggerId, panelId]) => {
            const trigger = document.getElementById(triggerId);
            const panel   = document.getElementById(panelId);
            if (trigger && panel && !panel.classList.contains('hidden')) {
                posicionarEReparentarPainel(trigger, panel);
            }
        });
    });
}

// CORREÇÃO — "painel voando pela tela": como o painel usa
// `position: fixed` (coordenadas fixas na TELA, calculadas uma única
// vez no momento em que abre), ele NÃO acompanha sozinho a rolagem de
// nenhum contêiner — nem da página, nem do `.card` onde o formulário
// vive (que tem overflow-y:auto), nem do `.modal__content` do modal de
// edição. Resultado: ao rolar qualquer um desses, o botão-gatilho se
// move (some de vista, inclusive), mas o painel fica parado nas
// coordenadas antigas — visualmente "flutuando" desconectado do botão
// que o abriu, como nos prints.
//
// A correção mais simples e robusta aqui não é tentar recalcular a
// posição a cada pixel de rolagem (caro, e ainda daria uma sensação
// de "grude" estranha) — é simplesmente FECHAR o painel assim que
// qualquer rolagem acontecer FORA dele. Rolagens DENTRO do próprio
// painel (o usuário passando o dedo/mouse pela lista de categorias)
// são explicitamente ignoradas, senão seria impossível rolar a lista.
//
// `addEventListener(..., true)` com `true` no fim = fase de captura:
// é o que permite pegar eventos de "scroll" de QUALQUER elemento
// rolável da página (scroll não borbulha normalmente, só é capturado
// na fase de captura, de cima para baixo a partir do document).
function handleScrollGlobalFechaPaineisCategoria(e) {
    const paineis = [
        { id: 'transCategoryPanel',     fechar: fecharPainelDeCategorias },
        { id: 'editTransCategoryPanel', fechar: fecharPainelEdicaoCategorias }
    ];

    paineis.forEach(({ id, fechar }) => {
        const panel = document.getElementById(id);
        if (!panel || panel.classList.contains('hidden')) return;

        const alvo = e.target;
        if (alvo && panel.contains(alvo)) return; // rolagem dentro do próprio painel — ignora

        fechar();
    });
}

function religarFechamentoAoRolar() {
    document.addEventListener('scroll', handleScrollGlobalFechaPaineisCategoria, true);
}

// Liga os cliques nas opções do painel (delegação simples, já que o
// painel inteiro é recriado a cada carga de categorias).
function ligarCliquesDoPainel() {
    const panel = document.getElementById('transCategoryPanel');
    if (!panel) return;

    panel.querySelectorAll('.custom-select__option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('transCategory').value = btn.dataset.id;
            document.getElementById('transCategoryTriggerText').textContent = btn.dataset.nome;

            panel.querySelectorAll('.custom-select__option.selected').forEach(el => el.classList.remove('selected'));
            btn.classList.add('selected');

            fecharPainelDeCategorias();
            atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
        });
    });
}

function abrirPainelDeCategorias() {
    const trigger = document.getElementById('transCategoryTrigger');
    const panel   = document.getElementById('transCategoryPanel');
    if (!trigger || !panel) return;

    posicionarEReparentarPainel(trigger, panel);
    panel.classList.remove('hidden');
    trigger.classList.add('open');
}

function fecharPainelDeCategorias() {
    document.getElementById('transCategoryPanel')?.classList.add('hidden');
    document.getElementById('transCategoryTrigger')?.classList.remove('open');
}

async function populateCategorySelect() {
    categoriasEstado = 'carregando';
    setCategorySelectState('carregando');

    try {
        const categorias = await DatabaseModule.getCategorias();

        if (!categorias || categorias.length === 0) {
            categoriasEstado = 'vazio';
            setCategorySelectState('vazio');
            console.warn('⚠️ categorias retornou vazio (0 categorias).');
            return;
        }

        categoriasEstado = 'ok';
        setCategorySelectState('ok', categorias);
    } catch (err) {
        categoriasEstado = 'erro';
        setCategorySelectState('erro');
        console.error('❌ Erro ao carregar categorias:', err.message);
        UIModule.showError('Não foi possível carregar as categorias. Toque no campo para tentar de novo.');
    }
}

// Chamada ao entrar na aba "Transações". Só refaz a consulta se a
// última tentativa não deu certo — evita chamadas repetidas quando
// já está tudo carregado.
async function garantirCategoriasCarregadas() {
    if (categoriasEstado === 'ok' || categoriasEstado === 'carregando') return;
    await populateCategorySelect();
}

// Botão do dropdown: se estiver em erro/vazio, toca -> tenta de novo;
// se estiver ok, abre/fecha o painel. Clique fora ou Esc fecham.
function initTransCategoryRetry() {
    const trigger = document.getElementById('transCategoryTrigger');
    const wrapper = document.getElementById('transCategoryWrapper');
    if (!trigger || !wrapper) return;

    trigger.addEventListener('click', () => {
        if (categoriasEstado === 'erro' || categoriasEstado === 'vazio') {
            populateCategorySelect();
            return;
        }
        const abrindo = document.getElementById('transCategoryPanel')?.classList.contains('hidden');
        if (abrindo) abrirPainelDeCategorias();
        else fecharPainelDeCategorias();
    });

    document.addEventListener('click', (e) => {
        const panel = document.getElementById('transCategoryPanel');
        // O painel agora pode estar reparentado para <body> (ver
        // posicionarEReparentarPainel) — por isso a checagem de "clique
        // fora" precisa considerar também o próprio painel, não só o
        // wrapper original, senão clicar dentro do painel (ex: na barra
        // de rolagem) fecharia o dropdown por engano.
        if (!wrapper.contains(e.target) && !(panel && panel.contains(e.target))) {
            fecharPainelDeCategorias();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') fecharPainelDeCategorias();
    });
}

async function initializeApp() {
    initTransCategoryRetry();
    initHistoryFilters();
    initEditCategoryDropdown();
    religarReposicionamentoAoRedimensionar();
    religarFechamentoAoRolar();

    try {
        const ok = await waitForSupabase();
        if (!ok) throw new Error('Supabase não inicializou');

        // Restaura sessão persistida, se existir
        const user = await AuthModule.checkSession();
        if (user) {
            await routeByRole(user, AuthModule.getUserRole());
        } else {
            UIModule.showScreen('loginScreen');
        }

        console.log('✅ App (cliente) inicializado');
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error);
        UIModule.showError('Erro ao inicializar a aplicação');
        UIModule.showScreen('loginScreen');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

console.log('✅ app.js (cliente) carregado');
