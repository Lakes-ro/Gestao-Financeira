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
 * `grupo` (essencial/estilo_de_vida/investimento/divida/transferencia/
 * renda), que o BI exige, é decidido por um classificador — o cliente
 * NÃO escolhe isso, e não precisa entender essa taxonomia interna.
 *
 * ⚠️ BUG CORRIGIDO — O CLASSIFICADOR NÃO PODE FORÇAR O TIPO:
 * A versão anterior, quando a heurística discordava do Tipo escolhido
 * pelo cliente (ex: cliente criando "Aluguel" e marcando Receita,
 * porque ele RECEBE aluguel de um imóvel, não paga), SOBRESCREVIA
 * silenciosamente para Despesa antes de salvar — o cliente via um
 * aviso, mas não tinha como confirmar que a escolha dele estava
 * certa mesmo. Isso viola a regra do próprio sistema ("a IA sugere,
 * nunca impõe"), que já era respeitada em todo o resto do app (Smart
 * Input, Aprendizado de Categorias) menos aqui.
 *
 * AGORA: a sugestão é só uma MENSAGEM. O <select> de Tipo nunca é
 * alterado por código — o cliente pode mudar de ideia depois de ver o
 * aviso, ou simplesmente ignorá-lo e confirmar do jeito que escolheu.
 * `handleConfirmarNovaCategoria()` sempre lê o valor ATUAL do select
 * no momento de salvar (nunca um valor "decidido" antes), e escolhe um
 * grupo compatível com esse tipo final — nunca grava uma combinação
 * inconsistente (ex: tipo=despesa com grupo='renda').
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
//
// ATUALIZAÇÃO — 'divida' e 'transferencia': "financiamento" e
// "empréstimo" saíram de 'essencial' — pagar uma dívida não é a mesma
// coisa que sobrevivência (aluguel, mercado, etc.), e misturar os dois
// distorce o Custo de Sobrevivência no BI. "Cartão de crédito/fatura"
// segue o mesmo grupo. "Transferência entre contas" é tratado como
// neutro (não conta nem como receita nem como despesa no dashboard).
const REGRAS_CLASSIFICACAO_CATEGORIA = [
    // Renda
    [/sal[aá]rio|holerite|pr[oó]-labore/i,                       'renda',          'receita'],
    [/freelance|freela|bico|consultoria/i,                        'renda',          'receita'],
    [/dividendo|jcp|rendimento/i,                                  'renda',          'receita'],
    [/renda extra|extra/i,                                         'renda',          'receita'],

    // Transferência interna (neutro — não conta como receita/despesa)
    [/transfer[eê]ncia entre contas|transfer[eê]ncia interna|entre contas|pix para mim mesmo/i, 'transferencia', 'despesa'],

    // Dívidas e Financiamentos (isolado de essencial/estilo de vida)
    [/financiamento|empr[eé]stimo|parcelamento da d[ií]vida|renegocia[çc][ãa]o/i, 'divida', 'despesa'],
    [/fatura|cart[aã]o de cr[eé]dito/i,                            'divida',         'despesa'],

    // Investimento (poupança/aportes — nem essencial nem estilo de vida)
    [/investimento|aporte|previd[eê]ncia|reserva|poupan[çc]a/i,   'investimento',   'despesa'],

    // Essencial (sobrevivência)
    [/luz|energia|[aá]gua|g[aá]s\b|condom[ií]nio|aluguel|iptu/i,  'essencial',      'despesa'],
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
 *   { tipoSugerido, grupoParaTipoSugerido, corrigido, motivo }
 * `corrigido` é true quando o tipo que a heurística reconheceria
 * difere do que o cliente JÁ escolheu no momento da análise — mas
 * isso NUNCA altera o campo automaticamente, é só informativo (ver
 * handleConfirmarNovaCategoria, que sempre respeita a escolha final
 * do cliente no momento de salvar).
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
            tipoSugerido: tipoInformado,
            grupoParaTipoSugerido: grupoPadrao,
            corrigido: false,
            motivo: 'Não consegui identificar automaticamente essa categoria, mas não tem problema — ela foi criada exatamente do jeito que você escolheu e já pode ser usada normalmente.'
        };
    }

    const [, grupoSugerido, tipoSugerido] = regra;
    const corrigido = tipoSugerido !== tipoInformado;

    return {
        tipoSugerido,
        grupoParaTipoSugerido: grupoSugerido,
        corrigido,
        motivo: corrigido
            ? `"${nome}" normalmente é ${tipoSugerido === 'receita' ? 'uma receita (dinheiro que entra)' : 'uma despesa (dinheiro que sai)'}. Se for esse o seu caso, mude a opção "Tipo" acima antes de confirmar — mas se você tem certeza que é ${tipoInformado === 'receita' ? 'uma receita' : 'uma despesa'} mesmo (ex: você RECEBE aluguel, em vez de pagar), pode deixar como está e confirmar do mesmo jeito.`
            : `Tudo certo! "${nome}" foi reconhecida como ${tipoSugerido === 'receita' ? 'uma receita' : 'uma despesa'}.`
    };
}

// ── Modal: Nova Categoria Personalizada ────────────────────────
let sugestaoIACategoria = null;

function abrirModalNovaCategoria() {
    document.getElementById('novaCategoriaNome').value = '';
    // Default alinhado com a ordem visual das opções (Receita
    // primeiro) — antes abria em 'despesa', o que confundia porque a
    // caixa já mostrava "Receita" selecionada visualmente sem
    // realmente estar.
    document.getElementById('novaCategoriaTipo').value = 'receita';
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
        // IMPORTANTE: isto NÃO altera document.getElementById('novaCategoriaTipo').value —
        // só guarda a sugestão para consulta posterior. O cliente continua
        // 100% livre para mudar o Tipo manualmente antes de confirmar.
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

    // Lê o tipo ATUAL do select — não o que a heurística sugeriu. Se o
    // cliente viu o aviso "isso parece ser uma despesa" e mesmo assim
    // manteve/confirmou Receita (ex: aluguel recebido, não pago), é
    // essa escolha final que vale, sempre.
    const tipoFinal = document.getElementById('novaCategoriaTipo').value;

    // Grupo: usa o sugerido pela heurística se o tipo final bater com
    // o que ela detectou; senão cai num grupo neutro e válido para o
    // tipo que o cliente realmente escolheu — nunca grava uma
    // combinação inconsistente (ex: tipo=receita com grupo='essencial',
    // que não existe/não faz sentido).
    const grupoFinal = (tipoFinal === sugestaoIACategoria.tipoSugerido)
        ? sugestaoIACategoria.grupoParaTipoSugerido
        : (tipoFinal === 'receita' ? 'renda' : 'estilo_de_vida');

    const btn = document.getElementById('btnConfirmarCategoria');
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    try {
        const { error } = await supabaseClient.from('categorias').insert({
            nome,
            tipo:       tipoFinal,
            grupo:      grupoFinal,
            cliente_id: clientId,
            revisado:   false // toda categoria criada pelo CLIENTE nasce pendente — o admin confirma/corrige o grupo depois (ver "Pendentes de Contabilização" em Categorias, admin.html)
        });

        if (error) throw error;

        UIModule.showSuccess('Categoria criada! O administrador vai revisar a classificação dela em breve.');
        UIModule.closeModal('modalNovaCategoria');

        // Recarrega o dropdown do formulário principal de "Registar
        // Transação", já incluindo a categoria nova.
        await populateCategorySelect();

        // Se a Importação de Extrato estiver aberta com uma tabela de
        // revisão na tela, atualiza os <select> de categoria de cada
        // linha também — sem isso, a categoria recém-criada só
        // apareceria depois de reprocessar o arquivo do zero. Guarda
        // por `typeof` porque este arquivo não depende de
        // importacao-extrato.js estar carregado.
        if (typeof atualizarCategoriasNaTabelaImportacao === 'function') {
            await atualizarCategoriasNaTabelaImportacao();
        }
    } catch (err) {
        console.error('❌ handleConfirmarNovaCategoria:', err.message);
        UIModule.showError('Erro ao salvar categoria: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '✓ Confirmar e Salvar';
    }
}

console.log('✅ categoria-personalizada.js carregado');
