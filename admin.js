/**
 * ADMIN.JS — LÓGICA CENTRAL DO PAINEL ADMIN
 * =====================================================
 * Expõe globals usados pelos sub-módulos:
 *   currentAdmin, allClientes, loadAllClientes,
 *   openModal, closeModal, showToast,
 *   formatCurrency, formatDate,
 *   mascararTexto, renderIdentidadeCliente, toggleIdentidadeCliente
 * Padrão: script global (sem import/export ES module).
 *
 * ATUALIZAÇÃO — PRIVACIDADE (OLHINHO 👁️):
 * Adicionados mascararTexto()/renderIdentidadeCliente()/
 * toggleIdentidadeCliente() — usados por clientes.js e dashboards.js
 * para ocultar nome/email do cliente por padrão (mostrando só um
 * texto mascarado tipo "R••••• H••••"), com um botão de olho que
 * revela/oculta o dado real por card, sem precisar de nova consulta
 * ao banco (o dado real já veio, só fica escondido visualmente até o
 * clique).
 *
 * NOTA: este ficheiro só deve ser incluído em admin.html.
 * Foi adicionada uma guarda no final (verifica document.body
 * .app-body, classe exclusiva do admin.html) para que, mesmo que
 * alguém volte a incluir este script noutra página por engano,
 * ele não tente redirecionar/auto-executar e cause loops.
 */

// ── Estado compartilhado ──────────────────────────────────────
let currentAdmin = null;   // { id, email, nome }
let allClientes  = [];     // cache dos clientes do admin

// ── Helpers globais ───────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  toast.classList.remove('hidden');

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function formatCurrency(val) {
  const n = parseFloat(val) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

// ══════════════════════════════════════════════════════════════
// PRIVACIDADE — OCULTAR NOME/EMAIL DO CLIENTE (OLHINHO)
// ══════════════════════════════════════════════════════════════
/**
 * Mascara um texto mantendo só o primeiro caractere de cada palavra
 * visível (ex: "Roger Hugo" -> "R•••• H•••"). Para email, mantém só o
 * primeiro caractere do usuário e oculta todo o domínio, pra não dar
 * nenhuma pista real (ex: "roger@gmail.com" -> "r••••@••••••.com").
 */
function mascararTexto(texto) {
  if (!texto) return '';

  if (texto.includes('@')) {
    const [usuario] = texto.split('@');
    const primeira  = usuario.charAt(0) || '•';
    return `${primeira}${'•'.repeat(Math.max(3, usuario.length - 1))}@••••••.com`;
  }

  return texto
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(p => p.charAt(0) + '•'.repeat(Math.max(2, p.length - 1)))
    .join(' ');
}

/**
 * Gera o bloco HTML de "identidade" (nome + email) de um cliente já
 * com o olhinho de privacidade. `extraClass` é opcional, usado quando
 * o bloco precisa se comportar como flex:1 dentro de um
 * .card-header-row (ver dashboards.js).
 */
function renderIdentidadeCliente(nome, email, extraClass = '') {
  const nomeSeguro  = (nome  || '').replace(/"/g, '&quot;');
  const emailSeguro = (email || '').replace(/"/g, '&quot;');
  const temEmail    = !!email;

  return `
    <div class="client-privacy-row ${extraClass}">
      <div class="client-identity" data-nome="${nomeSeguro}" data-email="${emailSeguro}">
        <p class="card-name client-identity__nome">${mascararTexto(nome)}</p>
        <p class="card-sub client-identity__email">${temEmail ? mascararTexto(email) : 'Sem email'}</p>
      </div>
      <button type="button" class="btn-eye-toggle" title="Mostrar dados" onclick="toggleIdentidadeCliente(this)">👁️</button>
    </div>
  `;
}

/**
 * Alterna entre mostrar o nome/email REAIS (vindos dos data-attributes,
 * já carregados junto com o card — não faz nova consulta) e a versão
 * mascarada. Chamado pelo onclick do botão de olho gerado acima.
 */
function toggleIdentidadeCliente(btn) {
  const linha = btn.closest('.client-privacy-row');
  const bloco = linha?.querySelector('.client-identity');
  if (!bloco) return;

  const revelado = bloco.classList.toggle('revelado');
  const nomeEl   = bloco.querySelector('.client-identity__nome');
  const emailEl  = bloco.querySelector('.client-identity__email');
  const nomeReal  = bloco.dataset.nome  || '—';
  const emailReal = bloco.dataset.email || '';

  if (revelado) {
    nomeEl.textContent  = nomeReal;
    emailEl.textContent = emailReal || 'Sem email';
    btn.textContent = '🙈';
    btn.title = 'Ocultar dados';
  } else {
    nomeEl.textContent  = mascararTexto(nomeReal);
    emailEl.textContent = emailReal ? mascararTexto(emailReal) : 'Sem email';
    btn.textContent = '👁️';
    btn.title = 'Mostrar dados';
  }
}

async function loadAllClientes() {
  if (!currentAdmin?.id) return;
  try {
    const { data, error } = await supabaseClient
      .from('clientes')
      .select('id, nome, email, cpf, telefone')
      .eq('admin_id', currentAdmin.id)
      .order('nome');

    if (error) throw error;

    // Muta o array compartilhado em vez de reatribuir
    allClientes.splice(0, allClientes.length, ...(data || []));
  } catch (err) {
    console.error('❌ loadAllClientes:', err.message);
  }
}

// ── Fechar modais ao clicar no overlay ou no botão ✕ ─────────
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-modal]');
  if (closeBtn) {
    closeModal(closeBtn.dataset.modal);
    return;
  }
  if (e.target.classList.contains('modal-overlay')) {
    closeModal(e.target.id);
  }
});

// ══════════════════════════════════════════════════════════════
// MÓDULO ADMIN — Navegação e inicialização do SPA
// ══════════════════════════════════════════════════════════════

const AdminModule = (() => {

  // ── Navegação entre secções ─────────────────────────────────
  function initNavigation() {
    document.querySelectorAll('.nav-item[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;

        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`section-${section}`);
        if (target) target.classList.add('active');

        window.dispatchEvent(new CustomEvent('section:change', { detail: { section } }));
      });
    });
  }

  // ── Logout ──────────────────────────────────────────────────
  function initLogout() {
    const btn = document.getElementById('btn-sair');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Deseja sair?')) return;
      await supabaseClient.auth.signOut();
      window.location.href = 'index.html';
    });
  }

  // ── Inicialização ────────────────────────────────────────────
  async function init() {
    // Aguarda Supabase
    let tries = 0;
    while (!supabaseClient && tries++ < 20) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!supabaseClient) {
      console.error('❌ Supabase não disponível');
      return;
    }

    // Verifica sessão (agora persistida — ver config.js)
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
      window.location.href = 'index.html';
      return;
    }

    const user = session.user;

    // Verifica se é o admin autorizado
    if (user.email !== CONFIG.ADMIN.EMAIL) {
      showToast('Acesso não autorizado.', 'error');
      await supabaseClient.auth.signOut();
      window.location.href = 'index.html';
      return;
    }

    // Define admin global
    currentAdmin = { id: user.id, email: user.email, nome: user.email.split('@')[0] };

    // Preenche header
    const subtitle = document.getElementById('admin-subtitle');
    if (subtitle) subtitle.textContent = `Bem-vindo, ${currentAdmin.nome}`;

    // Preenche perfil
    const pfNome  = document.getElementById('perfil-nome');
    const pfEmail = document.getElementById('perfil-email');
    if (pfNome)  pfNome.textContent  = currentAdmin.nome;
    if (pfEmail) pfEmail.textContent = currentAdmin.email;

    // Pré-carrega clientes
    await loadAllClientes();

    // Inicia navegação e logout
    initNavigation();
    initLogout();

    // Inicia sub-módulos (definidos nos outros scripts)
    if (typeof initClientes          === 'function') initClientes();
    if (typeof initCategorias        === 'function') initCategorias();
    if (typeof initDashboards        === 'function') initDashboards();
    if (typeof initMetas             === 'function') initMetas();
    if (typeof initPlanejamentos     === 'function') initPlanejamentos();
    if (typeof initRazonete          === 'function') initRazonete();
    if (typeof initNotificacoesAdmin === 'function') initNotificacoesAdmin();

    console.log('✅ Admin inicializado:', currentAdmin.email);
  }

  return { init };
})();

// ── Arranca apenas dentro de admin.html ──────────────────────
// Guarda: admin.html é a única página com <body class="app-body">.
// Se este script acabar incluído noutra página por engano, ele
// simplesmente não faz nada, em vez de redirecionar em loop.
function bootAdminModuleIfOnAdminPage() {
  if (document.body.classList.contains('app-body')) {
    AdminModule.init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootAdminModuleIfOnAdminPage);
} else {
  bootAdminModuleIfOnAdminPage();
}

console.log('✅ admin.js carregado');