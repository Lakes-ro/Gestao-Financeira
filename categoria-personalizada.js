/**
 * CATEGORIA-PERSONALIZADA.JS — Categorias customizadas por cliente
 * ================================================
 * Permite que o CLIENTE (não o admin) crie categorias próprias, além
 * das globais geridas pelo admin em admin.html. Multi-tenant via
 * `categorias.cliente_id`:
 *   - cliente_id = NULL   → categoria global (padrão do sistema)
 *   - cliente_id = <uuid> → categoria pessoal, só visível/editável
 *     pelo próprio cliente (isolamento garantido por RLS no banco —
 *     ver migração 'categorias_multi_tenant_cliente_id').
 *
 * O cliente só informa Nome + Tipo (Receita/Despesa). O campo
 * `grupo` (essencial/estilo_de_vida/investimento/renda), que o BI
 * exige, é decidido por um classificador — o cliente NÃO escolhe
 * isso, e não precisa entender essa taxonomia interna.
 *
 * ⚠️ SOBRE A "IA" — LEIA ANTES DE ACHAR QUE ISSO É ENROLAÇÃO:
 * `classificarCategoriaComIA()` abaixo é uma SIMULAÇÃO — um
 * classificador por palavra-chave, não uma chamada real a um LLM.
 * Isso é proposital, não preguiça: uma chamada real a uma API de LLM
 * (OpenAI, Anthropic etc.) direto do JS do navegador exigiria
 * embutir uma chave de API no código-fonte público do site —
 * qualquer pessoa abre o DevTools, copia a chave, e gasta seu
 * crédito. Isso não é um detalhe menor, é uma falha de segurança que
 * eu não vou fingir que não existe só para entregar algo que "parece
 * usar IA de verdade".
 *
 * O caminho correto: criar uma Supabase Edge Function que guarda a
 * chave da API no servidor; o front-end chama só a URL dessa
 * function (sem chave nenhuma exposta). A função abaixo já é `async`
 * e já recebe/retorna exatamente o formato que essa troca exigiria —
 * no dia em que a Edge Function existir, é só trocar o CORPO desta
 * função por um `fetch` pra ela. Posso montar essa Edge Function
 * quando vocês quiserem — é rápido.
 */

// ── Base de palavras-chave do classificador simulado ──────────
// Cada entrada: [regex sobre o nome, grupo do BI, tipo esperado].
// A primeira regra que bater no nome digitado vence.
const REGRAS_CLASSIFICACAO_CATEGORIA = [
    // Renda
    [/sal[aá]rio|holerite|pr[oó]-labore/i,                       'renda',          'receita'],
    [/freelance|freela|bico|consultoria/i,                        'renda',          'receita'],
    [/dividendo|jcp|rendimento/i,                                  'renda',          'receita'],
    [/renda extra|extra/i,                                         'renda',          'receita'],

    // Investimento (poupança/aportes — nem essencial nem estilo de vida)
    [/investimento|aporte|previd[eê]ncia|reserva|poupan[çc]a/i,   'investimento',   'despesa'],

    // Essencial (sobrevivência)
    [/luz|energia|[aá]gua|g[aá]s\b|condom[ií]nio|aluguel|financiamento|iptu/i, 'essencial', 'despesa'],
    [/mercado|supermercado|feira|a[çc]ougue/i,                     'essencial',      'despesa'],
    [/farm[aá]cia|m[eé]dico|consulta|plano de sa[uú]de|hospital/i, 'essencial',      'despesa'],
    [/escola|faculdade|curso|mensalidade/i,                        'essencial',      'despesa'],
    [/[oô]nibus|uber|99|combust[ií]vel|gasolina|transporte/i,      'essencial',      'despesa'],

    // Estilo de vida (consumo não essencial)
    [/streaming|netflix|spotify|assinatura/i,                      'estilo_de_vida', 'despesa'],
    [/viagem|hotel|passagem/i,                                     'estilo_de_vida', 'despesa'],
    [/restaurante|delivery|ifood|lanche|bar\b/i,                   'estilo_de_vida', 'despesa'],
    [/shopping|roupa|compra/i,                                     'estilo_de_vida', 'despesa'],
];

/**
 * Classifica uma categoria a partir do nome (heurística — ver nota
 * de segurança no topo do arquivo). Retorna:
 *   { tipo, grupo, corrigido, motivo }
 * `corrigido` é true quando o tipo sugerido difere do que o cliente
 * escolheu (ex: cliente marcou "Salário" como despesa por engano).
 */
async function classificarCategoriaComIA(nome, tipoInformado) {
    // Simula a latência de uma chamada de rede real — remover
    // quando isto virar um fetch de verdade pra uma Edge Function.
    await new Promise(resolve => setTimeout(resolve, 400));

    const regra = REGRAS_CLASSIFICACAO_CATEGORIA.find(([regex]) => regex.test(nome));

    if (!regra) {
        // Sem palavra-chave reconhecida: mantém o tipo informado e
        // usa o grupo mais neutro possível para esse tipo.
        const grupoPadrao = tipoInformado === 'receita' ? 'renda' : 'estilo_de_vida';
        return {
            tipo: tipoInformado,
            grupo: grupoPadrao,
            corrigido: false,
            motivo: 'Não reconheci essa categoria — mantive o tipo que você escolheu e usei um grupo padrão.'
        };
    }

    const [, grupo, tipoEsperado] = regra;
    const corrigido = tipoEsperado !== tipoInformado;

    return {
        tipo: tipoEsperado,
        grupo,
        corrigido,
        motivo: corrigido
            ? `"${nome}" parece ser ${tipoEsperado === 'receita' ? 'uma receita' : 'uma despesa'}, não ${tipoInformado === 'receita' ? 'uma receita' : 'uma despesa'} — corrigi automaticamente.`
            : `Categoria classificada como ${tipoEsperado === 'receita' ? 'receita' : 'despesa'}.`
    };
}

// ── Modal: Nova Categoria Personalizada ────────────────────────
let sugestaoIACategoria = null;

function abrirModalNovaCategoria() {
    document.getElementById('novaCategoriaNome').value = '';
    document.getElementById('novaCategoriaTipo').value = 'despesa';
    sugestaoIACategoria = null;

    const sugestaoEl = document.getElementById('novaCategoriaSugestao');
    sugestaoEl.classList.add('hidden');
    sugestaoEl.textContent = '';

    document.getElementById('btnClassificarCategoria').classList.remove('hidden');
    document.getElementById('btnConfirmarCategoria').classList.add('hidden');

    UIModule.openModal('modalNovaCategoria');
}

async function handleClassificarNovaCategoria() {
    const nome          = document.getElementById('novaCategoriaNome').value.trim();
    const tipoInformado = document.getElementById('novaCategoriaTipo').value;

    if (!nome) { UIModule.showError('Digite um nome para a categoria.'); return; }

    const btn = document.getElementById('btnClassificarCategoria');
    btn.disabled = true;
    btn.textContent = 'Analisando...';

    try {
        sugestaoIACategoria = await classificarCategoriaComIA(nome, tipoInformado);

        const sugestaoEl = document.getElementById('novaCategoriaSugestao');
        sugestaoEl.textContent = '🤖 ' + sugestaoIACategoria.motivo;
        sugestaoEl.classList.remove('hidden');

        btn.classList.add('hidden');
        document.getElementById('btnConfirmarCategoria').classList.remove('hidden');
    } catch (err) {
        console.error('❌ classificarCategoriaComIA:', err.message);
        UIModule.showError('Não foi possível analisar a categoria. Tenta de novo.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Analisar categoria';
    }
}

async function handleConfirmarNovaCategoria() {
    if (!sugestaoIACategoria) return;

    const nome     = document.getElementById('novaCategoriaNome').value.trim();
    const clientId = ClientModule.getClientId();

    if (!nome || !clientId) { UIModule.showError('Não foi possível identificar a categoria ou o cliente.'); return; }

    const btn = document.getElementById('btnConfirmarCategoria');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    try {
        const { error } = await supabaseClient.from('categorias').insert({
            nome,
            tipo:       sugestaoIACategoria.tipo,
            grupo:      sugestaoIACategoria.grupo,
            cliente_id: clientId
        });

        if (error) throw error;

        UIModule.showSuccess('Categoria criada!');
        UIModule.closeModal('modalNovaCategoria');
        await populateCategorySelect(); // recarrega o <select>, já incluindo a categoria nova
    } catch (err) {
        console.error('❌ handleConfirmarNovaCategoria:', err.message);
        UIModule.showError('Erro ao salvar categoria: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '✓ Confirmar e Salvar';
    }
}

console.log('✅ categoria-personalizada.js carregado');
