/**
 * CATEGORIA-PERSONALIZADA.JS — Categorias customizadas por cliente
 * ================================================
 * Permite que o CLIENTE (não o admin) crie categorias próprias, além
 * das globais geridas pelo admin em admin.html. Multi-tenant via
 * `categorias.cliente_id`:
 *   - cliente_id = NULL   → categoria global (padrão do sistema)
 *   - cliente_id = <uuid> → categoria pessoal, só visível/editável
 *     pelo próprio cliente (isolamento garantido por RLS no banco).
 *
 * O cliente só informa Nome + Tipo (Receita/Despesa). O campo
 * `grupo`, que o BI exige, é decidido por um classificador — o cliente
 * NÃO escolhe isso.
 *
 * ⚠️ O CLASSIFICADOR NÃO PODE FORÇAR O TIPO — a sugestão é só uma
 * MENSAGEM. `handleConfirmarNovaCategoria()` sempre lê o valor ATUAL
 * do select no momento de salvar.
 *
 * ⚠️ SOBRE A "IA" — `classificarCategoriaComIA()` é uma SIMULAÇÃO — um
 * classificador por palavra-chave, não uma chamada real a um LLM (ver
 * nota completa mais abaixo sobre por que embutir uma chave de API de
 * LLM direto no JS do navegador não é seguro).
 *
 * ATUALIZAÇÃO — PLANO DE CONTAS ROBUSTO (EVITA DUPLICAR CATEGORIA):
 * Antes de classificar, o sistema agora verifica se já existe alguma
 * categoria (global do admin, ou já criada pelo próprio cliente antes)
 * que reconheceria esse mesmo termo — seja pelo NOME dela, seja por um
 * dos SINÔNIMOS cadastrados pelo admin em `categorias.palavras_chave`
 * (ex: o admin cadastrou "Aluguel Ganho" com os sinônimos "aluguel
 * ganho, aluguel recebido, recebimento de aluguel"; se o cliente for
 * criar "Aluguel Recebido" do zero, o sistema avisa que já existe
 * "Aluguel Ganho" cobrindo esse termo). Isso é só um AVISO — o cliente
 * continua com controle total e pode confirmar e criar a categoria
 * nova mesmo assim, se preferir.
 */

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

async function classificarCategoriaComIA(nome, tipoInformado) {
    await new Promise(resolve => setTimeout(resolve, 400));

    const regra = REGRAS_CLASSIFICACAO_CATEGORIA.find(([regex]) => regex.test(nome));

    if (!regra) {
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
        sugestaoIACategoria = await classificarCategoriaComIA(nome, tipoInformado);

        // Verifica se já existe uma categoria (global ou já criada pelo
        // próprio cliente) que reconheceria este termo, via nome ou via
        // sinônimos cadastrados pelo admin — evita criar duplicata de
        // algo que já existe sob outro nome/variação de texto.
        let categoriaExistente = null;
        try {
            const categoriasExistentes = await DatabaseModule.getCategorias();
            if (typeof encontrarCategoriaPorPalavraChave === 'function') {
                categoriaExistente = encontrarCategoriaPorPalavraChave(categoriasExistentes, nome);
            }
            if (!categoriaExistente) {
                const nomeNormalizado = typeof normalizarTexto === 'function' ? normalizarTexto(nome) : nome.toLowerCase();
                categoriaExistente = categoriasExistentes.find(c =>
                    (typeof normalizarTexto === 'function' ? normalizarTexto(c.nome) : c.nome.toLowerCase()) === nomeNormalizado
                ) || null;
            }
        } catch (_) {
            // Falha ao checar duplicidade não deve impedir o fluxo normal.
        }

        const sugestaoEl = document.getElementById('novaCategoriaSugestao');
        let texto = '🤖 ' + sugestaoIACategoria.motivo;

        if (categoriaExistente) {
            texto += `\n\n⚠️ Já existe uma categoria parecida: "${categoriaExistente.nome}". Considere usar essa em vez de criar uma nova, para não duplicar o plano de contas. Se preferir mesmo assim, pode confirmar e criar a sua própria categoria normalmente.`;
        }

        sugestaoEl.textContent = texto;
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

    const tipoFinal = document.getElementById('novaCategoriaTipo').value;

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
            revisado:   false
        });

        if (error) throw error;

        UIModule.showSuccess('Categoria criada! O administrador vai revisar a classificação dela em breve.');
        UIModule.closeModal('modalNovaCategoria');

        await populateCategorySelect();

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
