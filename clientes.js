let clienteEmEdicao     = null;
let clienteComentarioId = null;

function initClientes() {
  document.getElementById('btn-add-cliente')
    ?.addEventListener('click', () => abrirModalCliente(null));

  document.getElementById('btn-salvar-cliente')
    ?.addEventListener('click', salvarCliente);

  document.getElementById('cliente-cpf')?.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    v = v.replace(/(\d{3})(\d)/, '$1.$2')
         .replace(/(\d{3})(\d)/, '$1.$2')
         .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    e.target.value = v;
  });

  document.getElementById('cliente-telefone')?.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    v = v.replace(/(\d{2})(\d)/, '($1) $2')
         .replace(/(\d{5})(\d)/, '$1-$2');
    e.target.value = v;
  });

  document.getElementById('btn-salvar-comentario')
    ?.addEventListener('click', salvarComentario);

  window.addEventListener('section:change', ({ detail }) => {
    if (detail.section === 'clientes') renderClientes();
  });

  renderClientes();
}

async function renderClientes() {
  const grid = document.getElementById('clientes-grid');
  if (!grid) return;
  grid.innerHTML = '<p class="empty-state">Carregando...</p>';

  await loadAllClientes();

  if (!allClientes.length) {
    grid.innerHTML = '<p class="empty-state">Nenhum cliente cadastrado. Clique em + Adicionar Cliente.</p>';
    return;
  }

  grid.innerHTML = allClientes.map(c => `
    <div class="card">
      <div>
        <p class="card-name">${c.nome}</p>
        <p class="card-sub">${c.email || 'Sem email'}</p>
      </div>
      <div class="card-actions">
        <button class="btn-card editar" data-id="${c.id}">✏️ Editar</button>
        <button class="btn-card comentarios" data-id="${c.id}" data-nome="${c.nome}">💬 Comentários</button>
      </div>
      <div class="card-actions">
        <button class="btn-card deletar" data-id="${c.id}" data-nome="${c.nome}">🗑️ Deletar</button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.btn-card.editar').forEach(btn => {
    btn.addEventListener('click', () => {
      const cliente = allClientes.find(c => c.id === btn.dataset.id);
      if (cliente) abrirModalCliente(cliente);
    });
  });

  grid.querySelectorAll('.btn-card.comentarios').forEach(btn => {
    btn.addEventListener('click', () => {
      abrirModalComentarios(btn.dataset.id, btn.dataset.nome);
    });
  });

  grid.querySelectorAll('.btn-card.deletar').forEach(btn => {
    btn.addEventListener('click', () => {
      confirmarDeletar(btn.dataset.id, btn.dataset.nome);
    });
  });
}

function abrirModalCliente(cliente) {
  clienteEmEdicao = cliente;

  document.getElementById('modal-cliente-title').textContent =
    cliente ? '✏️ Editar Cliente' : '📋 Adicionar Cliente';

  document.getElementById('cliente-id').value       = cliente?.id       || '';
  document.getElementById('cliente-nome').value     = cliente?.nome     || '';
  document.getElementById('cliente-email').value    = cliente?.email    || '';
  document.getElementById('cliente-cpf').value      = cliente?.cpf      || '';
  document.getElementById('cliente-telefone').value = cliente?.telefone || '';

  openModal('modal-cliente');
}

async function salvarCliente() {
  const nome      = document.getElementById('cliente-nome').value.trim();
  const email     = document.getElementById('cliente-email').value.trim();
  const cpf       = document.getElementById('cliente-cpf').value.trim();
  const telefone  = document.getElementById('cliente-telefone').value.trim();
  const clienteId = document.getElementById('cliente-id').value;

  if (!nome) { showToast('Informe o nome do cliente.', 'error'); return; }

  // ATUALIZAÇÃO — EMAIL OBRIGATÓRIO + AVISO DE DUPLICIDADE: o mesmo
  // cliente já apareceu 3 VEZES na lista (cadastrado manualmente duas
  // vezes, e uma terceira quando ele criou a própria conta). O email é
  // a única forma confiável do sistema reconhecer "essa é a mesma
  // pessoa" quando ela se registra depois — sem ele, a fusão automática
  // (ver reconciliar_cliente_no_registro no banco) não tem como
  // funcionar. Por isso agora é obrigatório, e avisamos ANTES de
  // salvar se já existe alguém com esse email.
  if (!email) {
    showToast('Informe o email do cliente — sem ele, se a pessoa criar a própria conta depois, vai virar um cadastro duplicado.', 'error');
    return;
  }

  const { data: existente } = await supabaseClient
    .from('clientes')
    .select('id, nome')
    .ilike('email', email)
    .maybeSingle();

  if (existente && existente.id !== clienteId) {
    showToast(`Já existe um cliente com esse email: "${existente.nome}". Edite aquele em vez de criar outro.`, 'error');
    return;
  }

  const payload = {
    nome,
    email,
    cpf:      cpf      || null,
    telefone: telefone || null,
    admin_id: currentAdmin.id,
  };

  let error;

  if (clienteId) {
    ({ error } = await supabaseClient.from('clientes').update(payload).eq('id', clienteId));
  } else {
    ({ error } = await supabaseClient.from('clientes').insert(payload));
  }

  if (error) {
    showToast('Erro ao salvar cliente: ' + error.message, 'error');
    return;
  }

  showToast(clienteId ? 'Cliente atualizado!' : 'Cliente adicionado!');
  closeModal('modal-cliente');
  renderClientes();
}

async function confirmarDeletar(id, nome) {
  if (!confirm(`Tem certeza que deseja deletar o cliente "${nome}"? Esta ação não pode ser desfeita.`)) return;

  const { error } = await supabaseClient.from('clientes').delete().eq('id', id);

  if (error) {
    showToast('Erro ao deletar: ' + error.message, 'error');
    return;
  }

  showToast('Cliente removido.');
  renderClientes();
}

async function abrirModalComentarios(clienteId, nome) {
  clienteComentarioId = clienteId;
  document.getElementById('modal-comentarios-title').textContent = `💬 Comentários — ${nome}`;
  document.getElementById('novo-comentario').value = '';

  await carregarComentarios(clienteId);
  openModal('modal-comentarios');
}

async function carregarComentarios(clienteId) {
  const lista = document.getElementById('comentarios-list');
  lista.innerHTML = '<p class="empty-state">Carregando...</p>';

  const { data, error } = await supabaseClient
    .from('comentarios_clientes')
    .select('texto, created_at')
    .eq('client_id', clienteId)
    .order('created_at', { ascending: false });

  if (error || !data?.length) {
    lista.innerHTML = '<p class="empty-state">Nenhum comentário ainda.</p>';
    return;
  }

  lista.innerHTML = data.map(c => `
    <div class="comentario-item">
      <p class="comentario-data">${formatDataComentario(c.created_at)}</p>
      <p class="comentario-texto">${c.texto}</p>
    </div>
  `).join('');
}

async function salvarComentario() {
  const texto = document.getElementById('novo-comentario').value.trim();
  if (!texto) { showToast('Escreva um comentário antes de enviar.', 'error'); return; }

  const { error } = await supabaseClient.from('comentarios_clientes').insert({
    client_id: clienteComentarioId,
    admin_id:  currentAdmin.id,
    texto,
  });

  if (error) { showToast('Erro ao enviar: ' + error.message, 'error'); return; }

  document.getElementById('novo-comentario').value = '';
  showToast('Comentário enviado!');
  await carregarComentarios(clienteComentarioId);
}

function formatDataComentario(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

console.log('✅ clientes.js carregado');
