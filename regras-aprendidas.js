/**
 * REGRAS-APRENDIDAS.JS — Aprendizado de Categorias
 * ================================================
 * Objetivo: o sistema não deve obrigar o cliente a classificar a mesma
 * descrição duas vezes. Da primeira vez que ele lança "BUSE" (ou
 * qualquer termo), o sistema classifica via IA/heurística (ver
 * smart-input.js) e, no momento em que ele clica em "Registar", grava a
 * associação termo→categoria na tabela `regras_aprendidas`. Da próxima
 * vez que ele digitar "BUSE", o sistema já preenche direto — sem
 * chamar IA nenhuma — e se ele corrigir a categoria antes de salvar,
 * essa correção vira a nova regra definitiva (UPDATE, não um registro
 * duplicado).
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 *
 * ORDEM DE CARREGAMENTO NO HTML (crítica):
 *   ... database.js, client.js, app.js, smart-input.js, regras-aprendidas.js, categoria-personalizada.js
 * Este ficheiro depende de funções/variáveis GLOBAIS definidas em
 * smart-input.js (normalizarTexto, getCategoriasParaClassificacao,
 * setSmartInputEstadoVisual, marcarOpcaoSelecionadaNoPainel,
 * TransactionFormState, autoClassify) — por isso deve vir DEPOIS dele.
 *
 * TABELA `regras_aprendidas` (Supabase, já criada via migration):
 *   id            uuid PK
 *   cliente_id    uuid NOT NULL  → FK clientes.id
 *   termo_busca   text NOT NULL  → sempre gravado NORMALIZADO (ver
 *                                  normalizarTexto, de smart-input.js)
 *   categoria_id  uuid NOT NULL  → FK categorias.id
 *   tipo          text NOT NULL  → 'receita' | 'despesa'
 *   created_at / updated_at
 *   UNIQUE (cliente_id, termo_busca)  ← 1 regra por cliente por termo;
 *                                        este índice único composto É o
 *                                        índice de performance da busca
 *                                        "WHERE cliente_id=? AND
 *                                        termo_busca=?" — não precisa de
 *                                        índice manual adicional.
 * RLS: cliente só lê/grava/corrige/apaga as PRÓPRIAS regras
 * (cliente_id = auth.uid()), mesmo padrão de `categorias`.
 */

const RegrasAprendidasModule = (() => {

    /**
     * Consulta se já existe uma regra aprendida para este cliente + termo.
     * Retorna a linha (com categoria_id, tipo) ou null se não existir.
     */
    async function buscarRegra(clienteId, termoBusca) {
        const termo = normalizarTexto(termoBusca);
        if (!clienteId || !termo) return null;

        try {
            const { data, error } = await supabaseClient
                .from('regras_aprendidas')
                .select('id, categoria_id, tipo, termo_busca')
                .eq('cliente_id', clienteId)
                .eq('termo_busca', termo)
                .maybeSingle();

            if (error) throw error;
            return data || null;
        } catch (err) {
            console.error('❌ RegrasAprendidasModule.buscarRegra:', err.message);
            return null;
        }
    }

    /**
     * Grava a regra definitiva para (cliente, termo) — INSERT se for a
     * primeira vez que esse termo é confirmado, UPDATE se já existia uma
     * regra e a categoria final escolhida no Registar for diferente
     * (ou seja: o cliente corrigiu a sugestão). Usa upsert do Supabase
     * com onConflict na constraint única (cliente_id, termo_busca), então
     * o INSERT/UPDATE é decidido pelo próprio Postgres numa única
     * chamada — sem precisar de um SELECT prévio para decidir qual dos
     * dois fazer.
     */
    async function salvarOuAtualizarRegra({ clienteId, termoBusca, categoriaId, tipo }) {
        const termo = normalizarTexto(termoBusca);
        if (!clienteId || !termo || !categoriaId || !tipo) {
            console.warn('⚠️ RegrasAprendidasModule.salvarOuAtualizarRegra: parâmetros incompletos, nada foi salvo.');
            return null;
        }

        try {
            const { data, error } = await supabaseClient
                .from('regras_aprendidas')
                .upsert(
                    {
                        cliente_id:   clienteId,
                        termo_busca:  termo,
                        categoria_id: categoriaId,
                        tipo,
                        updated_at:   new Date().toISOString()
                    },
                    { onConflict: 'cliente_id,termo_busca' }
                )
                .select();

            if (error) throw error;
            return data?.[0] || null;
        } catch (err) {
            // Não relançamos o erro para o chamador (app.js): uma falha
            // ao gravar a REGRA aprendida nunca deve impedir nem reverter
            // o registo da TRANSAÇÃO em si, que já foi salva com sucesso
            // antes desta chamada acontecer.
            console.error('❌ RegrasAprendidasModule.salvarOuAtualizarRegra:', err.message);
            return null;
        }
    }

    return { buscarRegra, salvarOuAtualizarRegra };
})();

// ══════════════════════════════════════════════════════════════
// REGISTERTRANSACTION — o "motor" do fluxo de aprendizado
// ══════════════════════════════════════════════════════════════
// Chamado ao sair do campo Descrição (ver wiring mais abaixo, que
// substitui a chamada direta a autoClassify feita em smart-input.js).
//
// Fluxo:
//   a) consulta regras_aprendidas pelo termo digitado + cliente atual;
//   b) se achar → preenche a categoria direto, sem chamar IA nenhuma;
//   c) se não achar → delega para autoClassify() (pipeline já existente
//      em smart-input.js: tenta /api/classify, cai no classificador
//      local por palavras-chave, ou pede seleção manual).
//
// IMPORTANTE: esta função NÃO grava nada em `regras_aprendidas` — ela
// só CONSULTA e SUGERE. A gravação da regra definitiva só acontece no
// momento do "Registar" (ver handleAddTransaction em app.js), porque só
// nesse momento sabemos a categoria FINAL que o cliente confirmou —
// que pode ser a sugestão aceita como está, ou uma correção manual.
//
// @param {{ clienteId: string, descricao: string }} inputData
// @returns {Promise<{origem: 'aprendida'|'classificada', categoriaId, tipo}|null>}
async function registerTransaction(inputData) {
    const clienteId = inputData?.clienteId;
    const descricao  = (inputData?.descricao || '').trim();

    TransactionFormState.descricao = descricao;

    if (!clienteId || descricao.length < 3) {
        return null;
    }

    // a) Consulta a regra aprendida para este termo + cliente
    const regra = await buscarRegraComFeedbackVisual(clienteId, descricao);

    if (regra) {
        // b) Regra encontrada — precisa confirmar que a categoria que ela
        // aponta ainda existe (pode ter sido apagada pelo admin depois).
        const categorias = await getCategoriasParaClassificacao();
        const categoria  = categorias.find(c => c.id === regra.categoria_id);

        if (categoria) {
            preencherCategoriaNoFormulario(categoria, '🧠 Categoria aprendida');
            return { origem: 'aprendida', categoriaId: categoria.id, tipo: categoria.tipo };
        }

        // Regra aponta para uma categoria que não existe mais — não usa
        // a regra órfã, cai para o pipeline de classificação normal.
        console.warn('⚠️ Regra aprendida aponta para categoria inexistente — reclassificando.');
    }

    // c) Sem regra aprendida (ou regra órfã) — usa o pipeline já existente
    const resultadoClassificacao = await autoClassify(descricao);
    return resultadoClassificacao
        ? { origem: 'classificada', categoriaId: TransactionFormState.categoriaId, tipo: TransactionFormState.tipo }
        : null;
}

// Mostra "Verificando..." enquanto consulta regras_aprendidas — evita
// que o dropdown pareça travado durante a ida ao banco.
async function buscarRegraComFeedbackVisual(clienteId, descricao) {
    setSmartInputEstadoVisual('carregando');
    const regra = await RegrasAprendidasModule.buscarRegra(clienteId, descricao);
    return regra;
}

// Preenche o dropdown de categoria (hidden input + painel visual) com
// uma categoria já resolvida (id real, já existente no banco) — usado
// tanto pelo caminho "regra aprendida" quanto poderia ser reaproveitado
// por outros fluxos futuros que já tenham a categoria certa em mãos.
function preencherCategoriaNoFormulario(categoria, prefixoMensagem) {
    const hiddenInput = document.getElementById('transCategory');
    if (!hiddenInput) return;

    hiddenInput.value = categoria.id;
    marcarOpcaoSelecionadaNoPainel(categoria.id);
    setSmartInputEstadoVisual('sugestao', categoria.nome);

    TransactionFormState.tipo          = categoria.tipo;
    TransactionFormState.categoriaId   = categoria.id;
    TransactionFormState.categoriaNome = categoria.nome;

    UIModule.showMessage(`${prefixoMensagem}: ${categoria.nome}`, 'success', 2500);

    // Vínculo com Meta/Caixinha (app.js): reavalia se a categoria
    // aprendida é do grupo 'investimento' e, se for, mostra o seletor
    // de meta. Guarda por typeof porque este módulo não depende de
    // app.js estar carregado.
    if (typeof atualizarSeletorDeMeta === 'function') {
        atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
    }
}

console.log('✅ regras-aprendidas.js carregado');
