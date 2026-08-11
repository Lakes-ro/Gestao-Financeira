/**
 * SMART-INPUT.JS — Smart Date + Smart Input (classificação automática)
 * ================================================
 * Objetivo: reduzir ao máximo o esforço do cliente ao lançar uma
 * transação. Duas frentes:
 *
 *   1) SMART DATE — o campo de data é preenchido sozinho com a data de
 *      hoje assim que o formulário aparece, mas o cliente pode alterar
 *      livremente (lançamento retroativo ou futuro).
 *
 *   2) SMART INPUT — o cliente descreve a transação em texto livre
 *      (ex: "Posto Shell", "Gasolina", "Uber pro trabalho") e o sistema
 *      tenta classificar tipo + categoria sozinho, preenchendo o
 *      dropdown de categoria — sempre deixando o cliente livre para
 *      corrigir, nunca travando o formulário.
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 * Depende de: DatabaseModule (database.js), UIModule (ui.js) — ambos
 * devem ser carregados ANTES deste ficheiro no HTML.
 *
 * ⚠️ HISTÓRICO DE UM BUG JÁ CORRIGIDO NESTA VERSÃO — LEIA ANTES DE MEXER:
 * A versão anterior usava, como fallback quando `/api/classify` falhava
 * (o que acontece SEMPRE hoje, porque o endpoint ainda é um placeholder
 * — ver nota abaixo), uma categoria fixa chamada "outros". Só que essa
 * categoria NUNCA existiu na tabela `categorias`. Resultado: TODA
 * descrição digitada caía no mesmo beco sem saída. A CORREÇÃO: existe
 * um CLASSIFICADOR LOCAL POR PALAVRAS-CHAVE (`classificarLocalmente`)
 * que já mapeia direto para categorias reais.
 *
 * ATUALIZAÇÃO — PLANO DE CONTAS ROBUSTO (SINÔNIMOS CADASTRADOS PELO
 * ADMIN): agora existe uma fonte de classificação melhor que a
 * heurística fixa em código: `categorias.palavras_chave` (text[]),
 * editável pelo admin em admin.html (modal de categoria → campo
 * "Palavras-chave / sinônimos"). Ex: a categoria "Aluguel Ganho" pode
 * ter as palavras-chave "aluguel ganho, aluguel recebido, recebimento
 * de aluguel, renda de aluguel" — não importa a ORDEM das palavras
 * nem a variação de texto exata que o cliente digitar, desde que o
 * termo cadastrado apareça (como substring, já normalizado sem
 * acento/caixa) dentro da descrição.
 *
 * ATUALIZAÇÃO — MATCH BIDIRECIONAL + POR RADICAL (RESOLVE "cabelo" NÃO
 * ACHAR "Cabeleireiro"): o match é BIDIRECIONAL (`a.includes(b) ||
 * b.includes(a)`) e também compara contra o NOME da própria categoria,
 * não só os sinônimos. Pra palavras com pelo menos 5 caracteres, um
 * match de RADICAL (mesmos 5 primeiros caracteres) também conta —
 * cobre variações de gênero/plural/conjugação da MESMA palavra
 * (cabelo/cabeleireiro).
 *
 * ATUALIZAÇÃO — GRUPOS SEMÂNTICOS (RESOLVE "Unha" NÃO ACHAR
 * "Manicure"): o match por radical só funciona quando duas palavras
 * COMPARTILHAM TEXTO (mesmo início). Só que "Unha" e "Manicure", ou
 * "Notebook" e "Eletrônicos", não têm NENHUMA letra em comum como
 * string — nenhum algoritmo de substring/radical resolve isso, porque
 * não é uma questão de TEXTO parecido, é uma questão de SIGNIFICADO
 * parecido. A única forma honesta de resolver isso é uma lista CURADA
 * manualmente (`GRUPOS_SEMANTICOS_CATEGORIA`, abaixo): cada grupo tem
 * um nome de categoria "guarda-chuva" (ex: "Eletrônicos") e uma lista
 * de itens que pertencem a ele (Celular, Smartphone, Notebook...).
 * Quando a descrição digitada bate com um desses itens, o sistema
 * procura se já existe uma categoria REAL cadastrada com esse nome
 * guarda-chuva (ou parecido) e usa ela — NUNCA inventa uma categoria
 * nova sozinho. Essa é sempre tratada como confiança APROXIMADA (pede
 * confirmação), porque é uma inferência de significado, não um texto
 * batendo com certeza.
 *
 * ATUALIZAÇÃO — CONFIANÇA DO MATCH (ALTA vs APROXIMADA):
 * Um match por SUBSTRING (bidirecional) é ALTA confiança. Um match só
 * por RADICAL ou por GRUPO SEMÂNTICO é confiança APROXIMADA — nesses
 * casos: a mensagem exibida diz explicitamente "confira antes de
 * salvar"; o texto do botão de categoria mostra "(confira)" ao lado do
 * nome; em importacao-extrato.js, o selo da linha na tabela de revisão
 * muda de "🔑 Sinônimo" para "🔎 Sugestão aproximada". O formulário
 * NUNCA trava nem impede de salvar — a diferença é puramente de AVISO
 * VISUAL, pra você saber quando vale a pena olhar com mais atenção
 * antes de confirmar.
 *
 * ORDEM DE PRIORIDADE da classificação (do mais para o menos
 * confiável), usada tanto aqui quanto em importacao-extrato.js:
 *   1. Regra aprendida do próprio cliente (regras_aprendidas) — feito
 *      em regras-aprendidas.js, ANTES de chamar autoClassify(). Sempre
 *      alta confiança (o próprio cliente já confirmou essa categoria
 *      pra esse termo antes).
 *   2. Palavras-chave/sinônimos cadastrados pelo ADMIN em `categorias`
 *      OU nome da própria categoria (encontrarCategoriaPorPalavraChave,
 *      abaixo) — alta confiança se substring, aproximada se só radical.
 *   3. Grupo semântico curado (GRUPOS_SEMANTICOS_CATEGORIA) — sempre
 *      confiança aproximada, só entra em ação se já existir uma
 *      categoria real com o nome guarda-chuva do grupo.
 *   4. Endpoint /api/classify (IA real — hoje é placeholder).
 *   5. Classificador local por palavras-chave FIXAS no código
 *      (classificarLocalmente) — cobre termos comuns mesmo sem
 *      nenhuma curadoria feita pelo admin ainda.
 *   6. Nenhum match — pede seleção manual, nunca inventa uma categoria.
 *
 * ⚠️ SOBRE O ENDPOINT `/api/classify`:
 * Continua sendo um PLACEHOLDER — nenhuma mudança nisso.
 *
 * IMPORTANTE — POR QUE NÃO INVENTAMOS UM categoria_id:
 * `transacoes.categoria_id` é uma foreign key para `categorias.id`.
 * Este módulo SEMPRE cruza qualquer sugestão com as categorias REAIS
 * já cadastradas no banco antes de preencher o campo oculto
 * `transCategory`. Se não achar uma correspondência confiável, ele NÃO
 * grava um id qualquer — apenas avisa o cliente para escolher manualmente.
 *
 * GARANTIA DURA (não depende de confiança nenhuma): o formulário só
 * salva se `transCategory` tiver um id de categoria REAL selecionado
 * (ver handleAddTransaction em app.js) — e, tanto no formulário manual
 * quanto na importação, o `tipo` salvo na transação vem sempre da
 * categoria escolhida (`cat.tipo`), nunca de uma suposição solta. Uma
 * transação de despesa não tem como ser salva com uma categoria de
 * receita, e vice-versa — essa checagem é uma trava dura, não uma
 * sugestão.
 */

// ══════════════════════════════════════════════════════════════
// ESTADO DO FORMULÁRIO
// ══════════════════════════════════════════════════════════════
const TransactionFormState = {
    data:          null, // 'YYYY-MM-DD'
    descricao:     '',
    tipo:          null, // 'receita' | 'despesa'
    categoriaId:   null,
    categoriaNome: null
};

function resetTransactionFormState() {
    TransactionFormState.data          = null;
    TransactionFormState.descricao     = '';
    TransactionFormState.tipo          = null;
    TransactionFormState.categoriaId   = null;
    TransactionFormState.categoriaNome = null;
}

// ── Estado interno do módulo (cache/controle de chamadas) ──────
let smartInputCategoriasCache = null; // cache local das categorias (evita refetch a cada blur)
let smartInputUltimaDescricao = null; // evita reclassificar o mesmo texto repetidamente
let smartInputPromisePendente = null; // permite ao handleAddTransaction esperar uma classificação em andamento

const GRUPOS_VALIDOS = ['essencial', 'estilo_de_vida', 'investimento', 'renda'];

// Tamanho mínimo de palavra para entrar na regra de match por RADICAL
// (evita falso positivo tipo "carro" casando com "carta" só porque os
// 3 primeiros caracteres batem — com um piso de 5 caracteres, o
// radical comparado já carrega significado suficiente).
const RADICAL_MIN_LEN = 5;

// ── Utilitários de texto (comparação tolerante a acento/caixa) ─
function normalizarTexto(txt) {
    return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Compara dois textos já normalizados e devolve { match, confiancaAlta }:
 *   - match=true, confiancaAlta=true  → um é substring do outro
 *     (correspondência exata de texto — o nível de certeza mais alto).
 *   - match=true, confiancaAlta=false → só bateram os primeiros
 *     RADICAL_MIN_LEN caracteres (raiz comum) — ex: "cabelo" vs
 *     "cabeleireiro". Provavelmente certo, mas não é garantido (duas
 *     palavras diferentes podem começar parecido), por isso o
 *     resultado precisa de confirmação visual antes de salvar.
 *   - match=false → nenhuma correspondência.
 */
function avaliarCorrespondencia(a, b) {
    if (!a || !b) return { match: false, confiancaAlta: false };
    if (a.includes(b) || b.includes(a)) return { match: true, confiancaAlta: true };

    const menorTamanho = Math.min(a.length, b.length);
    if (menorTamanho < RADICAL_MIN_LEN) return { match: false, confiancaAlta: false };

    const radicalBate = a.slice(0, RADICAL_MIN_LEN) === b.slice(0, RADICAL_MIN_LEN);
    return { match: radicalBate, confiancaAlta: false };
}

// Wrapper booleano simples — usado onde só interessa saber SE bateu,
// sem precisar do nível de confiança (ex: encontrarCategoriaCorrespondente).
function textoContemOuEhContido(a, b) {
    return avaliarCorrespondencia(a, b).match;
}

// ══════════════════════════════════════════════════════════════
// GRUPOS SEMÂNTICOS — VÁRIOS TERMOS DIFERENTES, UMA SÓ CATEGORIA
// ══════════════════════════════════════════════════════════════
/**
 * Resolve o caso de itens que são conceitualmente a mesma coisa mas
 * não compartilham NENHUM texto em comum (ex: "Celular" e
 * "Smartwatch" não têm nada de parecido como string — nem match por
 * substring nem por radical vai funcionar aqui, porque não é uma
 * questão de TEXTO parecido, é de SIGNIFICADO parecido).
 *
 * Cada grupo tem um nome de categoria CANÔNICO/"guarda-chuva" (ex:
 * "Eletrônicos") e uma lista de termos que pertencem a ele. Quando a
 * descrição bate com um desses termos, o sistema procura se já existe
 * uma categoria REAL cadastrada com esse nome canônico (ou algo bem
 * parecido) e usa ela — se não existir ainda, não inventa nada, só
 * fica disponível pra sugerir ao CRIAR uma categoria nova (ver
 * categoria-personalizada.js).
 *
 * Esta lista é só um PONTO DE PARTIDA com os grupos mais comuns pra um
 * uso pessoal/familiar — adicione mais grupos/termos aqui conforme
 * surgirem casos parecidos no seu uso real. O padrão de cada linha é
 * sempre o mesmo: nome canônico + tipo + grupo do BI + lista de termos
 * (tudo minúsculo e sem acento já ajuda a leitura, mas não é
 * obrigatório — normalizarTexto() cuida disso em tempo de execução).
 */
const GRUPOS_SEMANTICOS_CATEGORIA = [
    {
        categoria: 'Eletrônicos',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'celular', 'smartphone', 'smartwatch', 'relogio inteligente',
            'fone de ouvido', 'fone bluetooth', 'fone sem fio', 'headset',
            'notebook', 'laptop', 'computador', 'tablet', 'ipad',
            'impressora', 'caixa de som', 'caixa de som portatil',
            'video game', 'videogame', 'console', 'carregador',
            'mouse', 'teclado', 'monitor', 'hd externo', 'pendrive'
        ]
    },
    {
        categoria: 'Beleza e Estética',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'manicure', 'pedicure', 'unha', 'maquiagem', 'sobrancelha',
            'depilacao', 'estetica', 'spa', 'massagem', 'salao de beleza',
            'cilios', 'design de sobrancelha', 'skincare', 'cosmetico'
        ]
    },
    {
        categoria: 'Vestuário e Calçados',
        tipo: 'despesa',
        grupo: 'estilo_de_vida',
        termos: [
            'roupa', 'sapato', 'tenis', 'calcado', 'vestido', 'camisa',
            'camiseta', 'calca', 'jaqueta', 'casaco', 'bolsa', 'mochila',
            'mala de viagem', 'cinto', 'meia', 'sunga', 'biquini'
        ]
    },
    {
        categoria: 'Manutenção Automotiva',
        tipo: 'despesa',
        grupo: 'essencial',
        termos: [
            'oficina', 'mecanico', 'revisao do carro', 'troca de oleo',
            'pneu', 'alinhamento', 'balanceamento', 'bateria do carro',
            'seguro do carro', 'ipva', 'licenciamento'
        ]
    }
];

/**
 * Procura, na lista curada acima, um grupo semântico cujo termo bata
 * com o texto digitado (substring bidirecional simples — aqui não
 * precisa de radical, porque os termos já são curados e específicos o
 * bastante pra não gerar falso positivo). Retorna o grupo inteiro
 * ({ categoria, tipo, grupo, termos }) ou null.
 */
function encontrarGrupoSemantico(texto) {
    const alvo = normalizarTexto(texto);
    if (!alvo) return null;

    for (const grupoSemantico of GRUPOS_SEMANTICOS_CATEGORIA) {
        const bateu = grupoSemantico.termos.some(termo => {
            const termoNormalizado = normalizarTexto(termo);
            return alvo.includes(termoNormalizado) || termoNormalizado.includes(alvo);
        });
        if (bateu) return grupoSemantico;
    }

    return null;
}

// ══════════════════════════════════════════════════════════════
// PLANO DE CONTAS ROBUSTO — MATCH POR PALAVRA-CHAVE/SINÔNIMO
// ══════════════════════════════════════════════════════════════
/**
 * Procura, dentre as categorias REAIS já cadastradas, alguma que
 * reconheça a descrição digitada, em 3 passadas (da mais pra menos
 * confiável):
 *   1. Sinônimo cadastrado pelo admin em `palavras_chave`.
 *   2. Nome da própria categoria.
 *   3. Grupo semântico curado (GRUPOS_SEMANTICOS_CATEGORIA) — só entra
 *      em ação se existir uma categoria real com o nome guarda-chuva
 *      do grupo (ex: "Eletrônicos").
 *
 * Retorna a categoria encontrada com um campo extra `_confiancaAlta`
 * (true = correspondência exata de texto; false = match aproximado —
 * por radical OU por grupo semântico, precisa de confirmação visual).
 * Retorna null se nada bater em nenhuma das 3 passadas.
 */
function encontrarCategoriaPorPalavraChave(categorias, descricao) {
    const alvo = normalizarTexto(descricao);
    if (!alvo || !categorias || !categorias.length) return null;

    const melhorPorPassada = (fonteDeTermo) => {
        let melhorMatch = null; // { cat, confiancaAlta }
        for (const cat of categorias) {
            const termos = fonteDeTermo(cat);
            for (const termoBruto of termos) {
                const termo = normalizarTexto(termoBruto);
                if (!termo) continue;
                const resultado = avaliarCorrespondencia(alvo, termo);
                if (!resultado.match) continue;

                if (resultado.confiancaAlta) {
                    return { cat, confiancaAlta: true }; // não dá pra achar melhor que isso — encerra já
                }
                if (!melhorMatch) melhorMatch = { cat, confiancaAlta: false };
            }
        }
        return melhorMatch;
    };

    // 1ª passada: sinônimos cadastrados pelo admin (palavras_chave)
    const porSinonimo = melhorPorPassada(cat => Array.isArray(cat.palavras_chave) ? cat.palavras_chave : []);
    if (porSinonimo) return { ...porSinonimo.cat, _confiancaAlta: porSinonimo.confiancaAlta };

    // 2ª passada: nome da própria categoria (fallback quando não há
    // sinônimo cadastrado ou nenhum bateu) — é aqui que "cabelo" passa
    // a reconhecer diretamente uma categoria chamada "Cabeleireiro".
    const porNome = melhorPorPassada(cat => [cat.nome]);
    if (porNome) return { ...porNome.cat, _confiancaAlta: porNome.confiancaAlta };

    // 3ª passada: GRUPO SEMÂNTICO — cobre itens que são a mesma coisa
    // mas não compartilham texto nenhum (ex: "Notebook" -> categoria
    // "Eletrônicos"). Só entra em ação se já existir uma categoria
    // REAL cadastrada com o nome canônico do grupo (ou parecido) —
    // nunca inventa uma categoria. Sempre confiança aproximada, mesmo
    // que o nome da categoria bata exato — é uma inferência de
    // significado, não um texto batendo com certeza.
    const grupoSemantico = encontrarGrupoSemantico(alvo);
    if (grupoSemantico) {
        const nomeCanonico = normalizarTexto(grupoSemantico.categoria);
        const categoriaCanonica = categorias.find(c =>
            c.tipo === grupoSemantico.tipo && textoContemOuEhContido(normalizarTexto(c.nome), nomeCanonico)
        );
        if (categoriaCanonica) {
            return { ...categoriaCanonica, _confiancaAlta: false };
        }
    }

    return null;
}

// ══════════════════════════════════════════════════════════════
// CLASSIFICADOR LOCAL POR PALAVRAS-CHAVE (heurística fixa no código)
// ══════════════════════════════════════════════════════════════
const REGRAS_CLASSIFICACAO_LOCAL = [
    // ── Receitas (renda) ──
    [/sal[aá]rio|holerite|pr[oó]-labore/i,                          'receita', 'Salário'],
    [/freelance|freela|bico|consultoria/i,                          'receita', 'Freelance'],
    [/dividendo|jcp|rendimento/i,                                   'receita', 'Dividendos'],
    [/renda extra|extra\b/i,                                        'receita', 'Renda Extra'],

    // ── Investimento ──
    [/previd[eê]ncia/i,                                             'despesa', 'Previdência Privada'],
    [/reserva|poupan[çc]a|emerg[eê]ncia/i,                          'despesa', 'Reserva de Emergência'],
    [/investimento|aporte/i,                                        'despesa', 'Aporte em Investimentos'],

    // ── Essencial ──
    [/luz|energia|[aá]gua|g[aá]s\b|internet|telefone|celular/i,     'despesa', 'Contas e Utilidades'],
    [/aluguel|condom[ií]nio|financiamento|iptu/i,                   'despesa', 'Moradia'],
    [/mercado|supermercado|feira|a[çc]ougue|padaria|hortifruti|hortifruti|quitanda/i, 'despesa', 'Alimentação'],
    [/biscoito|bolacha|arroz|feij[aã]o|macarr[aã]o|massa\b|carne|frango|peixe|leite|p[aã]o\b|queijo|presunto|manteiga|margarina|caf[eé]\b|a[çc][uú]car|[oó]leo|tempero|fruta|verdura|legume|ovo\b|iogurte/i, 'despesa', 'Alimentação'],
    [/farm[aá]cia|m[eé]dico|consulta|plano de sa[uú]de|hospital|dentista|rem[eé]dio/i, 'despesa', 'Saúde'],
    [/escola|faculdade|curso|mensalidade|material escolar|livro did[aá]tico/i, 'despesa', 'Educação'],
    [/[oô]nibus|uber|99\b|combust[ií]vel|gasolina|posto|estacionamento|pedagio|pedágio|metr[oô]|passagem de [oô]nibus/i, 'despesa', 'Transporte'],
    [/oficina|mec[aâ]nico|revis[aã]o do carro|troca de [oó]leo|pneu|alinhamento|balanceamento/i, 'despesa', 'Manutenção Automotiva'],

    // ── Estilo de vida ──
    [/restaurante|ifood|delivery|lanche|lanchonete|pizza|hamb[uú]rguer|bar\b/i, 'despesa', 'Delivery'],
    [/streaming|netflix|spotify|assinatura/i,                       'despesa', 'Streaming e Assinaturas'],
    [/viagem|hotel|passagem|airbnb/i,                                'despesa', 'Viagens'],
    [/shopping|roupa|cal[çc]ado|compra/i,                            'despesa', 'Compras'],
    [/cinema|show|festa|balada|lazer|cabel[eo]/i,                    'despesa', 'Lazer'],
    [/celular|smartphone|notebook|tablet|fone de ouvido|video ?game/i, 'despesa', 'Eletrônicos'],
    [/manicure|pedicure|unha|maquiagem|sobrancelha|estetica/i,      'despesa', 'Beleza e Estética'],
];

function classificarLocalmente(descricao) {
    const regra = REGRAS_CLASSIFICACAO_LOCAL.find(([regex]) => regex.test(descricao));

    if (!regra) return null;

    const [, tipo, nomeCategoria] = regra;
    return {
        tipo,
        categoriaNome: nomeCategoria,
        fallback: true,
        local:    true
    };
}

// ══════════════════════════════════════════════════════════════
// SMART DATE
// ══════════════════════════════════════════════════════════════
function getDataDeHojeFormatoInput() {
    const agora = new Date();
    const ano   = agora.getFullYear();
    const mes   = String(agora.getMonth() + 1).padStart(2, '0');
    const dia   = String(agora.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function setSmartDate(forcar = false) {
    const campoData = document.getElementById('transDate');
    if (!campoData) return;

    if (forcar || !campoData.value) {
        campoData.value = getDataDeHojeFormatoInput();
    }

    TransactionFormState.data = campoData.value;
}

// ══════════════════════════════════════════════════════════════
// CATEGORIAS: BUSCA COM CACHE + MATCHING SEGURO
// ══════════════════════════════════════════════════════════════

async function getCategoriasParaClassificacao(forcarRecarga = false) {
    if (!forcarRecarga && smartInputCategoriasCache && smartInputCategoriasCache.length) {
        return smartInputCategoriasCache;
    }
    try {
        smartInputCategoriasCache = await DatabaseModule.getCategorias();
    } catch (err) {
        console.error('❌ getCategoriasParaClassificacao:', err.message);
        smartInputCategoriasCache = smartInputCategoriasCache || [];
    }
    return smartInputCategoriasCache;
}

function encontrarCategoriaCorrespondente(categorias, nomeSugerido, tipoSugerido) {
    if (!categorias || !categorias.length) return null;
    const nomeAlvo = normalizarTexto(nomeSugerido);

    let match = categorias.find(c =>
        c.tipo === tipoSugerido && normalizarTexto(c.nome) === nomeAlvo
    );
    if (match) return match;

    // Match bidirecional + radical (mesma lógica de
    // encontrarCategoriaPorPalavraChave) — cobre variações entre o
    // nome sugerido pela IA/classificador local e o nome real
    // cadastrado (ex: sugestão "Cabelo" vs categoria "Cabeleireiro").
    match = categorias.find(c => {
        if (c.tipo !== tipoSugerido) return false;
        return textoContemOuEhContido(nomeAlvo, normalizarTexto(c.nome));
    });
    if (match) return match;

    return null;
}

// ══════════════════════════════════════════════════════════════
// FEEDBACK VISUAL NO DROPDOWN DE CATEGORIA
// ══════════════════════════════════════════════════════════════

function setSmartInputEstadoVisual(estado, texto) {
    const trigger     = document.getElementById('transCategoryTrigger');
    const triggerText = document.getElementById('transCategoryTriggerText');
    if (!trigger || !triggerText) return;

    if (estado === 'carregando') {
        triggerText.textContent = '🤖 Analisando descrição...';
        trigger.disabled = true;
    } else if (estado === 'sugestao') {
        triggerText.textContent = `🤖 ${texto}`;
        trigger.disabled = false;
    } else if (estado === 'sem-match') {
        triggerText.textContent = texto || 'Não identifiquei a categoria — selecione manualmente';
        trigger.disabled = false;
    } else {
        trigger.disabled = false;
    }
}

function marcarOpcaoSelecionadaNoPainel(categoriaId) {
    const panel = document.getElementById('transCategoryPanel');
    if (!panel) return;
    panel.querySelectorAll('.custom-select__option.selected')
        .forEach(el => el.classList.remove('selected'));
    panel.querySelector(`.custom-select__option[data-id="${categoriaId}"]`)
        ?.classList.add('selected');
}

async function preencherFormularioComClassificacao(resultado) {
    const hiddenInput = document.getElementById('transCategory');
    if (!hiddenInput) return;

    const categorias = await getCategoriasParaClassificacao();
    const match = encontrarCategoriaCorrespondente(categorias, resultado.categoriaNome, resultado.tipo);

    if (match) {
        hiddenInput.value = match.id;
        marcarOpcaoSelecionadaNoPainel(match.id);

        // Confiança aproximada (radical OU grupo semântico) — o texto
        // do botão já avisa "(confira)" ao lado do nome, pra não passar
        // despercebido mesmo se a pessoa não ler a mensagem toast.
        const nomeExibido = resultado.confiancaAlta === false ? `${match.nome} (confira)` : match.nome;
        setSmartInputEstadoVisual('sugestao', nomeExibido);

        TransactionFormState.tipo          = match.tipo;
        TransactionFormState.categoriaId   = match.id;
        TransactionFormState.categoriaNome = match.nome;

        if (resultado.palavraChave) {
            if (resultado.confiancaAlta === false) {
                UIModule.showMessage(`🔎 Sugestão por semelhança: ${match.nome} — confira antes de salvar`, 'info', 4500);
            } else {
                UIModule.showMessage(`🔑 Categoria reconhecida por sinônimo: ${match.nome}`, 'success', 2500);
            }
        } else if (resultado.local) {
            UIModule.showMessage(`🤖 Categoria sugerida: ${match.nome}`, 'success', 2500);
        } else if (resultado.fallback) {
            UIModule.showMessage(
                'Não consegui identificar a categoria com certeza. Confira antes de salvar.',
                'info',
                4000
            );
        } else {
            UIModule.showMessage(`🤖 Categoria sugerida: ${match.nome}`, 'success', 2500);
        }

        if (typeof atualizarSeletorDeMeta === 'function') {
            atualizarSeletorDeMeta('transCategory', 'transMetaWrapper', 'transMeta');
        }
    } else {
        hiddenInput.value = '';
        setSmartInputEstadoVisual('sem-match');

        TransactionFormState.tipo          = null;
        TransactionFormState.categoriaId   = null;
        TransactionFormState.categoriaNome = null;

        UIModule.showError('Não consegui sugerir uma categoria para essa descrição. Selecione manualmente.');
    }
}

// ══════════════════════════════════════════════════════════════
// AUTOCLASSIFY — núcleo do Smart Input
// ══════════════════════════════════════════════════════════════
/**
 * Ordem de tentativa (ver nota completa no cabeçalho do arquivo):
 *   1. Palavras-chave/sinônimos/nome/grupo semântico (todos dentro de
 *      encontrarCategoriaPorPalavraChave), com distinção de confiança
 *      alta vs aproximada.
 *   2. Endpoint /api/classify (placeholder).
 *   3. Classificador local por palavras-chave fixas no código.
 *   4. Nenhum match — seleção manual.
 */
async function autoClassify(description) {
    const descricao = (description || '').trim();
    TransactionFormState.descricao = descricao;

    if (descricao.length < 3) {
        return null;
    }

    if (descricao === smartInputUltimaDescricao) {
        return null;
    }

    const execucao = (async () => {
        setSmartInputEstadoVisual('carregando');

        let resultado = null;

        // 1) Palavras-chave/sinônimos/nome/grupo semântico
        const categoriasDisponiveis = await getCategoriasParaClassificacao();
        const categoriaPorSinonimo  = encontrarCategoriaPorPalavraChave(categoriasDisponiveis, descricao);
        if (categoriaPorSinonimo) {
            resultado = {
                tipo:          categoriaPorSinonimo.tipo,
                categoriaNome: categoriaPorSinonimo.nome,
                fallback:      false,
                local:         false,
                palavraChave:  true,
                confiancaAlta: categoriaPorSinonimo._confiancaAlta
            };
        }

        // 2) Tenta o endpoint de IA real (placeholder por enquanto)
        if (!resultado) {
            try {
                const response = await fetch('/api/classify', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ description: descricao })
                });

                if (!response.ok) {
                    throw new Error(`Endpoint /api/classify retornou HTTP ${response.status}`);
                }

                const data = await response.json();

                const tipoValido     = data?.type === 'receita' || data?.type === 'despesa';
                const grupoValido    = GRUPOS_VALIDOS.includes(data?.group);
                const categoriaOk    = typeof data?.category === 'string' && data.category.trim().length > 0;
                const confiancaBaixa = typeof data?.confidence === 'number' && data.confidence < 0.4;

                if (!tipoValido || !grupoValido || !categoriaOk || confiancaBaixa) {
                    throw new Error('Resposta da IA incompleta ou de baixa confiança.');
                }

                resultado = {
                    tipo:          data.type,
                    categoriaNome: data.category.trim(),
                    fallback:      false,
                    local:         false
                };
            } catch (err) {
                console.warn('⚠️ /api/classify indisponível, tentando classificador local:', err.message);
            }
        }

        // 3) Endpoint falhou (ou ainda não existe) — tenta o classificador local
        if (!resultado) {
            resultado = classificarLocalmente(descricao);
        }

        // 4) Nada reconheceu a descrição — não inventa nada
        if (!resultado) {
            setSmartInputEstadoVisual('sem-match');
            TransactionFormState.tipo          = null;
            TransactionFormState.categoriaId   = null;
            TransactionFormState.categoriaNome = null;
            smartInputUltimaDescricao = descricao;
            return null;
        }

        smartInputUltimaDescricao = descricao;
        await preencherFormularioComClassificacao(resultado);
        return resultado;
    })();

    smartInputPromisePendente = execucao;
    const resultadoFinal = await execucao;
    if (smartInputPromisePendente === execucao) smartInputPromisePendente = null;
    return resultadoFinal;
}

async function autoClassifyTransaction(description) {
    return autoClassify(description);
}

async function aguardarClassificacaoSmartInputPendente() {
    if (smartInputPromisePendente) {
        try { await smartInputPromisePendente; } catch (_) { /* já tratado internamente */ }
    }
}

// ══════════════════════════════════════════════════════════════
// SINCRONIZAÇÃO DO ESTADO COM O DOM (data, descrição, categoria)
// ══════════════════════════════════════════════════════════════

let smartInputSincronizacaoLigada = false;

function ligarSincronizacaoDeEstado() {
    if (smartInputSincronizacaoLigada) return;
    smartInputSincronizacaoLigada = true;

    const campoData = document.getElementById('transDate');
    campoData?.addEventListener('change', () => {
        TransactionFormState.data = campoData.value;
    });

    const campoDescricao = document.getElementById('transDescription');
    campoDescricao?.addEventListener('input', () => {
        TransactionFormState.descricao = campoDescricao.value;
    });

    const panel = document.getElementById('transCategoryPanel');
    panel?.addEventListener('click', async (e) => {
        const opcao = e.target.closest('.custom-select__option');
        if (!opcao) return;

        TransactionFormState.categoriaId   = opcao.dataset.id;
        TransactionFormState.categoriaNome = opcao.dataset.nome;

        const categorias = await getCategoriasParaClassificacao();
        const cat = categorias.find(c => c.id === opcao.dataset.id);
        TransactionFormState.tipo = cat?.tipo || null;
    });
}

// ══════════════════════════════════════════════════════════════
// INITFORM — ponto de entrada do módulo
// ══════════════════════════════════════════════════════════════

function initForm(forcarData = false) {
    setSmartDate(forcarData);

    const campoDescricao = document.getElementById('transDescription');
    if (campoDescricao && !campoDescricao.dataset.smartInputListenerLigado) {
        campoDescricao.addEventListener('blur', () => {
            const valor = campoDescricao.value.trim();
            if (!valor) return;

            if (typeof registerTransaction === 'function' && typeof ClientModule !== 'undefined') {
                registerTransaction({ clienteId: ClientModule.getClientId(), descricao: valor });
            } else {
                autoClassify(valor);
            }
        });
        campoDescricao.dataset.smartInputListenerLigado = 'true';
    }

    ligarSincronizacaoDeEstado();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initForm(false));
} else {
    initForm(false);
}

console.log('✅ smart-input.js carregado (Smart Date + Smart Input + sinônimos + radical + grupos semânticos)');
