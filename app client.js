// ================================================
// UTILITÁRIOS GLOBAIS
// ================================================

function toggleScreen(screenId) {
    UIModule.showScreen(screenId);
}

function toggleAddMetaForm() {
    const form = document.getElementById('addMetaForm');
    if (form) {
        form.classList.toggle('hidden');
    }
}

function closeModal(modalId) {
    UIModule.closeModal(modalId);
}

function switchView(sectionId, event) {
    event.preventDefault();
    UIModule.showSection(sectionId);
    document.querySelectorAll('.sidebar__nav-item').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
}

// ================================================
// LOGIN CLIENTE
// ================================================

async function handleClientLogin(event) {
    event.preventDefault();
    const email = document.getElementById('clientEmail').value.trim();
    const password = document.getElementById('clientPassword').value;

    if (!email || !password) {
        UIModule.showError('Email e senha são obrigatórios');
        return;
    }

    try {
        const result = await AuthModule.login(email, password);
        const user = result.user;
        
        ClientModule.setClientId(user.id);
        UIModule.showScreen('clientScreen');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao fazer login');
    }
}

async function handleClientRegister(event) {
    event.preventDefault();
    const email = document.getElementById('clientRegEmail').value.trim();
    const password = document.getElementById('clientRegPassword').value;

    if (!email || !password) {
        UIModule.showError('Email e senha são obrigatórios');
        return;
    }

    if (password.length < 6) {
        UIModule.showError('Senha deve ter no mínimo 6 caracteres');
        return;
    }

    try {
        await AuthModule.register(email, password);
        UIModule.showSuccess('Conta criada! Faça login agora');
        setTimeout(() => {
            UIModule.showScreen('loginClientScreen');
        }, 2000);
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao criar conta');
    }
}

// ================================================
// CLIENTE DASHBOARD
// ================================================

async function loadClientDashboard() {
    try {
        const clientId = ClientModule.getClientId();
        const user = AuthModule.getUser();

        if (user?.user_metadata?.name) {
            UIModule.setText('clientNameDisplay', user.user_metadata.name);
        } else {
            UIModule.setText('clientNameDisplay', user?.email?.split('@')[0] || 'Cliente');
        }

        const data = await DashboardModule.renderClientDashboard(clientId);
        const goals = await GoalsModule.loadClientGoals(clientId);
        
        GoalsModule.renderGoals('clientMetasList', goals);
        
        await loadClientTransactions();
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        UIModule.showError('Erro ao carregar dashboard');
    }
}

async function loadClientTransactions() {
    try {
        const clientId = ClientModule.getClientId();
        const transactions = await DatabaseModule.getTransactionsByClient(clientId);
        TransactionsModule.renderTransactions('transactionHistoryList');
    } catch (error) {
        console.error('Erro ao carregar transações:', error);
    }
}

// ================================================
// TRANSAÇÕES CLIENTE
// ================================================

async function handleAddTransaction(event) {
    event.preventDefault();
    const clientId = ClientModule.getClientId();
    const planoId = document.getElementById('transCategory').value;
    const value = parseFloat(document.getElementById('transValue').value);
    const date = document.getElementById('transDate').value;
    const description = document.getElementById('transDescription').value;

    try {
        const plano = await DatabaseModule.getPlanoDeContas();
        const selectedCategory = plano.find(p => p.id === planoId);

        if (!selectedCategory) {
            throw new Error('Categoria inválida');
        }

        await ClientModule.addTransaction({
            client_id: clientId,
            plano_de_contas_id: planoId,
            valor: value,
            data_competencia: date,
            descricao: description,
            tipo: selectedCategory.tipo
        });

        event.target.reset();
        UIModule.showSuccess('Transação registrada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao registrar transação');
    }
}

// ================================================
// METAS CLIENTE
// ================================================

async function handleAddMeta(event) {
    event.preventDefault();
    const clientId = ClientModule.getClientId();
    const name = document.getElementById('metaName').value;
    const value = parseFloat(document.getElementById('metaValue').value);

    try {
        await ClientModule.addGoal({
            client_id: clientId,
            nome: name,
            valor_necessario: value,
            valor_economizado: 0
        });

        event.target.reset();
        UIModule.showSuccess('Meta criada!');
        await loadClientDashboard();
    } catch (error) {
        UIModule.showError(error.message || 'Erro ao criar meta');
    }
}

// ================================================
// PERFIL CLIENTE
// ================================================

function showClientProfile() {
    const user = AuthModule.getUser();
    UIModule.setText('profileClientName', user?.email || 'Cliente');
    UIModule.setText('profileClientEmail', user?.email || '');
    UIModule.openModal('clientProfileModal');
}

// ================================================
// LOGOUT
// ================================================

async function handleLogout() {
    if (!confirm('Tem certeza que deseja sair?')) {
        return;
    }

    try {
        await AuthModule.logout();
        window.location.reload();
    } catch (error) {
        UIModule.showError('Erro ao fazer logout');
    }
}

// ================================================
// INICIALIZAÇÃO
// ================================================

async function initializeApp() {
    try {
        // Aguarda Supabase inicializar
        let attempts = 0;
        while (!supabaseClient && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        if (!supabaseClient) {
            throw new Error('Supabase não inicializou');
        }

        // Carrega plano de contas
        const plano = await DatabaseModule.getPlanoDeContas();
        if (plano && plano.length > 0) {
            const select = document.getElementById('transCategory');
            if (select) {
                const options = plano.map(p => `<option value="${p.id}">${p.nome}</option>`).join('');
                select.innerHTML = options;
            }
        }

        // Verifica sessão
        const user = await AuthModule.checkSession();
        if (user) {
            ClientModule.setClientId(user.id);
            UIModule.showScreen('clientScreen');
            await loadClientDashboard();
        }

        console.log('✅ App inicializado com sucesso');
    } catch (error) {
        console.error('❌ Erro ao inicializar app:', error);
        UIModule.showError('Erro ao inicializar aplicação');
    }
}

// Inicia app quando DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

console.log('✅ app.js (CLIENTE) carregado');