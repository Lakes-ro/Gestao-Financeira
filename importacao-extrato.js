/**
 * IMPORTACAO-EXTRATO.JS — Importação de Extrato Bancário (OFX/CSV)
 * ================================================
 * Fluxo completo:
 *   1. Cliente escolhe um arquivo .ofx ou .csv e clica "Processar Arquivo".
 *   2. O arquivo é normalizado em linhas { data, descricao, valor, tipo }.
 *   3. Cada linha passa por uma classificação de categoria, na ordem:
 *        a) regras_aprendidas (RegrasAprendidasModule.buscarRegra) —
 *           se o cliente já classificou esse termo antes, usa direto;
 *        b) classificador local por palavras-chave (classificarLocalmente,
 *           de smart-input.js) — cobre termos comuns mesmo sem histórico;
 *        c) se nada reconhecer, fica em aberto para seleção manual.
 *      NENHUMA chamada de rede é feita por linha nesta etapa (nem ao
 *      endpoint /api/classify, que é só placeholder) — com um extrato de
 *      centenas de linhas, esperar N requisições que sempre falham (404)
 *      seria lento e inútil; regra aprendida + heurística local já
 *      resolvem a maioria dos casos reais instantaneamente.
 *   4. Uma tabela de revisão aparece — NADA foi salvo no banco ainda.
 *      O cliente confere/corrige cada linha (data, descrição, valor,
 *      tipo, categoria) e pode desmarcar linhas que não quer importar.
 *   5. Só ao clicar "Confirmar Importação" é que os dados são gravados
 *      (em lote, numa única chamada de rede) — e a partir daí o sistema
 *      aprende cada classificação confirmada/corrigida, exatamente como
 *      já acontece no formulário manual de transação.
 *
 * Padrão: script global (sem import/export), igual ao resto do projeto.
 * Depende de (devem estar carregados ANTES): config.js, database.js,
 * ui.js, client.js, app.js, smart-input.js, regras-aprendidas.js, e a
 * biblioteca externa PapaParse (CDN, só usada para o parser de CSV).
 *
 * ⚠️ SOBRE O DROPDOWN DE CATEGORIA NESTA TABELA:
 * O resto do sistema usa um dropdown customizado (.custom-select) para
 * poder estilizar o Darktech corretamente no mobile — um <select>
 * nativo com <optgroup> não pode ser restilizado pelo SO (já
 * documentado em categoria-personalizada.js). Só que aqui, numa tabela
 * de revisão com potencialmente dezenas/centenas de linhas, instanciar
 * um dropdown customizado completo (com painel flutuante reposicionado
 * via JS) POR LINHA seria caro e complexo sem necessidade real. Por
 * isso esta tabela usa <select> NATIVO, mas SEM <optgroup> (o grupo vai
 * embutido no texto da opção, ex: "🟠 Alimentação") — evita exatamente
 * o problema documentado (optgroup não estilizável), mantendo a tabela
 * leve e performática. É uma exceção deliberada e isolada a este
 * contexto específico (edição tabular densa), não uma mudança no
 * padrão do resto do app.
 */

// ── Estado do módulo ────────────────────────────────────────────
let linhasImportacao        = [];  // linhas normalizadas + classificadas, ainda não salvas
let categoriasCacheImportacao = null; // cache local das categorias (evita refetch por linha)
let hashesJaImportadosCache  = new Set(); // import_hash já existentes no banco para este cliente (dedup)

const GRUPO_LABEL_IMPORTACAO = {
    essencial:      '🟠 Essencial',
    estilo_de_vida: '🎯 Estilo de Vida',
    investimento:   '💰 Investimento',
    renda:          '📈 Renda'
};

// ══════════════════════════════════════════════════════════════
// UTILITÁRIOS DE HASH E NORMALIZAÇÃO
// ══════════════════════════════════════════════════════════════

/**
 * Hash determinístico simples (FNV-1a de 32 bits) — usado para gerar o
 * `import_hash` de linhas de CSV, que não têm um identificador único
 * de banco como o FITID do OFX. Duas linhas com a mesma data+valor+
 * descrição (normalizada) sempre geram o mesmo hash — é isso que a
 * constraint `UNIQUE (client_id, import_hash)` do banco usa para
 * impedir importar o mesmo lançamento duas vezes.
 */
function hashFNV1a(texto) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < texto.length; i++) {
        hash ^= texto.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function gerarImportHashCsv(data, valorAbs, descricao) {
    const chave = `${data}|${valorAbs.toFixed(2)}|${normalizarTexto(descricao)}`;
    return `csv:${hashFNV1a(chave)}`;
}

/**
 * Converte data em vários formatos comuns de extrato para 'YYYY-MM-DD'.
 * Aceita: 'YYYY-MM-DD' (já correto), 'DD/MM/YYYY', 'DD/MM/YY'.
 * Retorna null se não conseguir reconhecer o formato — quem chama trata
 * isso descartando a linha (não adivinha uma data errada).
 */
function normalizarDataImportacao(valorBruto) {
    const v = (valorBruto || '').trim();
    if (!v) return null;

    // Já no formato ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

    // DD/MM/YYYY ou DD/MM/YY
    const matchBr = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (matchBr) {
        let [, dia, mes, ano] = matchBr;
        if (ano.length === 2) ano = `20${ano}`;
        return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }

    // DTPOSTED do OFX: YYYYMMDD... (com hora/timezone opcional depois)
    const matchOfx = v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (matchOfx) {
        const [, ano, mes, dia] = matchOfx;
        return `${ano}-${mes}-${dia}`;
    }

    return null;
}

/**
 * Converte um valor monetário de texto para número, tolerando os dois
 * formatos comuns em extratos brasileiros: "1234.56" (ponto decimal,
 * comum em OFX) e "1.234,56" ou "1234,56" (vírgula decimal, comum em
 * CSV exportado de internet banking BR).
 */
function normalizarValorImportacao(valorBruto) {
    let v = String(valorBruto ?? '').trim();
    if (!v) return NaN;

    // Remove símbolo de moeda e espaços, mantém sinal e dígitos/pontuação
    v = v.replace(/[^\d,.\-+]/g, '');

    const temVirgula = v.includes(',');
    const temPonto   = v.includes('.');

    if (temVirgula && temPonto) {
        // "1.234,56" -> ponto é milhar, vírgula é decimal
        v = v.replace(/\./g, '').replace(',', '.');
    } else if (temVirgula && !temPonto) {
        // "1234,56" -> vírgula é decimal
        v = v.replace(',', '.');
    }
    // Só ponto, ou nenhum separador: já está no formato que parseFloat entende

    return parseFloat(v);
}

// ══════════════════════════════════════════════════════════════
// PARSER OFX
// ══════════════════════════════════════════════════════════════
// Cobre tanto OFX 1.x (SGML — tags muitas vezes sem fechamento, valor
// vai até a quebra de linha ou próxima tag) quanto OFX 2.x (XML — tags
// sempre fechadas). A extração por regex abaixo funciona para os dois,
// porque busca o valor entre a tag de abertura e o próximo '<'.

function extrairTagOfx(bloco, tag) {
    const regex = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i');
    const match = bloco.match(regex);
    return match ? match[1].trim() : '';
}

function parsearOfx(textoOfx) {
    const blocos = textoOfx.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi) || [];

    if (!blocos.length) {
        throw new Error('Nenhuma transação encontrada no arquivo OFX (tag <STMTTRN> não localizada). Confirme se é um extrato OFX válido.');
    }

    return blocos.map(bloco => {
        const dtposted = extrairTagOfx(bloco, 'DTPOSTED');
        const trnamt   = extrairTagOfx(bloco, 'TRNAMT');
        const memo     = extrairTagOfx(bloco, 'MEMO') || extrairTagOfx(bloco, 'NAME');
        const fitid    = extrairTagOfx(bloco, 'FITID');

        const data      = normalizarDataImportacao(dtposted);
        const valorBrut = parseFloat((trnamt || '').replace(',', '.'));

        return {
            dataValida:  !!data && !isNaN(valorBrut),
            data,
            descricao:   memo || '(sem descrição)',
            valorAbs:    Math.abs(valorBrut),
            tipo:        valorBrut < 0 ? 'despesa' : 'receita',
            importHash:  fitid ? `ofx:${fitid}` : null // se faltar FITID, cai no hash sintético depois
        };
    });
}

// ══════════════════════════════════════════════════════════════
// PARSER CSV (via PapaParse, carregado por CDN no HTML)
// ══════════════════════════════════════════════════════════════
// Detecta automaticamente qual coluna é qual pelo NOME do cabeçalho
// (tolerante a variações comuns em português/inglês). Se o CSV não
// tiver cabeçalho reconhecível, lança um erro claro em vez de adivinhar
// e importar dados errados.

const COLUNAS_DATA_ACEITAS      = ['data', 'date', 'dt'];
const COLUNAS_DESCRICAO_ACEITAS = ['descricao', 'descrição', 'historico', 'histórico', 'memo', 'lancamento', 'lançamento', 'title', 'description'];
const COLUNAS_VALOR_ACEITAS     = ['valor', 'amount', 'value', 'montante'];
const COLUNAS_TIPO_ACEITAS      = ['tipo', 'type'];

function encontrarColuna(headers, candidatos) {
    const headersNormalizados = headers.map(h => normalizarTexto(h));
    for (const candidato of candidatos) {
        const idx = headersNormalizados.indexOf(candidato);
        if (idx !== -1) return headers[idx];
    }
    return null;
}

function parsearCsv(textoCsv) {
    if (typeof Papa === 'undefined') {
        throw new Error('Biblioteca de leitura de CSV não carregou (PapaParse). Verifica a conexão e recarrega a página.');
    }

    const resultado = Papa.parse(textoCsv.trim(), { header: true, skipEmptyLines: true });

    if (resultado.errors?.length) {
        console.warn('⚠️ PapaParse relatou avisos:', resultado.errors);
    }

    const headers = resultado.meta?.fields || [];
    const colData      = encontrarColuna(headers, COLUNAS_DATA_ACEITAS);
    const colDescricao = encontrarColuna(headers, COLUNAS_DESCRICAO_ACEITAS);
    const colValor      = encontrarColuna(headers, COLUNAS_VALOR_ACEITAS);
    const colTipo        = encontrarColuna(headers, COLUNAS_TIPO_ACEITAS); // opcional

    if (!colData || !colDescricao || !colValor) {
        throw new Error(
            `Não reconheci as colunas do CSV. Encontrado: [${headers.join(', ')}]. ` +
            `Preciso de uma coluna de Data, uma de Descrição e uma de Valor (os nomes podem variar, ex: "Data"/"Date", "Descrição"/"Histórico", "Valor"/"Amount").`
        );
    }

    return resultado.data.map(linha => {
        const data       = normalizarDataImportacao(linha[colData]);
        const valorBruto = normalizarValorImportacao(linha[colValor]);
        const descricao  = (linha[colDescricao] || '(sem descrição)').trim();

        // Se o CSV tiver uma coluna de tipo explícita e ela disser
        // "receita"/"despesa" (ou credit/debit), respeita isso em vez de
        // inferir só pelo sinal do valor — mais confiável quando existe.
        let tipo = valorBruto < 0 ? 'despesa' : 'receita';
        if (colTipo) {
            const tipoTexto = normalizarTexto(linha[colTipo]);
            if (tipoTexto.includes('receita') || tipoTexto.includes('credit')) tipo = 'receita';
            else if (tipoTexto.includes('despesa') || tipoTexto.includes('debit')) tipo = 'despesa';
        }

        return {
            dataValida: !!data && !isNaN(valorBruto),
            data,
            descricao,
            valorAbs:   Math.abs(valorBruto),
            tipo,
            importHash: null // CSV não tem ID de banco — hash sintético calculado depois
        };
    });
}

// ══════════════════════════════════════════════════════════════
// CLASSIFICAÇÃO POR LINHA (regra aprendida -> heurística local)
// ══════════════════════════════════════════════════════════════

/**
 * Classifica uma linha já normalizada, tentando na ordem: regra
 * aprendida do cliente, depois heurística local por palavras-chave.
 * NÃO chama nenhum endpoint de rede (ver nota no cabeçalho do arquivo).
 * Retorna { categoriaId, categoriaNome, origem } — categoriaId fica
 * null se nada reconhecer a descrição (precisa de seleção manual).
 */
async function classificarLinhaImportacao(clienteId, descricao, tipoSugerido) {
    // 1) Regra aprendida — um termo aprendido vale mesmo que o sinal do
    // valor no extrato pareça contradizer (o cliente já confirmou essa
    // classificação antes; extratos às vezes têm sinais inconsistentes
    // em estornos/transferências, e a regra aprendida é mais confiável
    // que a heurística de sinal nesse caso).
    if (typeof RegrasAprendidasModule !== 'undefined') {
        const regra = await RegrasAprendidasModule.buscarRegra(clienteId, descricao);
        if (regra) {
            const cat = categoriasCacheImportacao.find(c => c.id === regra.categoria_id);
            if (cat) return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'aprendida' };
        }
    }

    // 2) Heurística local — só aceita o match se o tipo sugerido pela
    // regra de palavra-chave BATER com o tipo já inferido pelo sinal do
    // valor no extrato. Se não bater, não força uma categoria
    // inconsistente — deixa em aberto para seleção manual em vez de
    // arriscar salvar uma despesa com categoria de renda (ou vice-versa).
    if (typeof classificarLocalmente === 'function') {
        const resultadoLocal = classificarLocalmente(descricao);
        if (resultadoLocal && resultadoLocal.tipo === tipoSugerido) {
            const cat = categoriasCacheImportacao.find(c =>
                c.tipo === resultadoLocal.tipo && normalizarTexto(c.nome) === normalizarTexto(resultadoLocal.categoriaNome)
            );
            if (cat) return { categoriaId: cat.id, categoriaNome: cat.nome, origem: 'local' };
        }
    }

    // 3) Nada reconheceu (ou o tipo não batia) — precisa de seleção manual
    return { categoriaId: null, categoriaNome: null, origem: 'manual' };
}

// ══════════════════════════════════════════════════════════════
// PROCESSAMENTO DO ARQUIVO
// ══════════════════════════════════════════════════════════════

async function processarArquivoImportacao() {
    const input = document.getElementById('importFileInput');
    const arquivo = input?.files?.[0];

    if (!arquivo) {
        UIModule.showError('Escolhe um arquivo .ofx ou .csv primeiro.');
        return;
    }

    const btn = document.getElementById('btnProcessarImportacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Processando...'; }

    exibirStatusImportacao('Lendo e classificando o arquivo...', false);
    esconderTabelaRevisao();

    try {
        const texto      = await arquivo.text();
        const ehOfx       = /\.ofx$|\.qbo$/i.test(arquivo.name) || /<OFX>/i.test(texto);
        const linhasBrutas = ehOfx ? parsearOfx(texto) : parsearCsv(texto);

        const linhasValidas    = linhasBrutas.filter(l => l.dataValida);
        const linhasDescartadas = linhasBrutas.length - linhasValidas.length;

        if (!linhasValidas.length) {
            exibirStatusImportacao('Nenhuma linha válida foi encontrada no arquivo (datas ou valores não reconhecidos).', true);
            return;
        }

        const clienteId = ClientModule.getClientId();
        categoriasCacheImportacao = await DatabaseModule.getCategorias();

        // Dedup: busca de uma vez só os import_hash que JÁ existem no
        // banco para este cliente, entre os hashes conhecidos deste
        // arquivo (linhas OFX com FITID já têm hash pronto; linhas sem
        // hash pronto — CSV, ou OFX sem FITID — recebem um hash
        // sintético ANTES desta consulta, para que a checagem cubra
        // 100% das linhas).
        linhasValidas.forEach(l => {
            if (!l.importHash) l.importHash = gerarImportHashCsv(l.data, l.valorAbs, l.descricao);
        });

        const hashesDoArquivo = linhasValidas.map(l => l.importHash);
        hashesJaImportadosCache = await buscarHashesJaImportados(clienteId, hashesDoArquivo);

        // Classifica cada linha (regra aprendida -> heurística local)
        linhasImportacao = [];
        for (const linha of linhasValidas) {
            const duplicada = hashesJaImportadosCache.has(linha.importHash);
            const classificacao = duplicada
                ? { categoriaId: null, categoriaNome: null, origem: 'duplicada' }
                : await classificarLinhaImportacao(clienteId, linha.descricao, linha.tipo);

            linhasImportacao.push({
                idTemp:      (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `tmp-${Date.now()}-${Math.random()}`,
                data:        linha.data,
                descricao:   linha.descricao,
                valor:       linha.valorAbs,
                tipo:        linha.tipo,
                categoriaId: classificacao.categoriaId,
                origem:      classificacao.origem,
                importHash:  linha.importHash,
                duplicada,
                incluir:     !duplicada
            });
        }

        renderizarTabelaRevisao();

        const totalDuplicadas = linhasImportacao.filter(l => l.duplicada).length;
        let mensagem = `${linhasImportacao.length} lançamento(s) encontrado(s) e pronto(s) para revisão.`;
        if (linhasDescartadas > 0) mensagem += ` ${linhasDescartadas} linha(s) foram ignoradas por falta de data/valor reconhecíveis.`;
        if (totalDuplicadas > 0)   mensagem += ` ${totalDuplicadas} já tinham sido importado(s) antes e vêm desmarcado(s) por padrão.`;
        exibirStatusImportacao(mensagem, false);

    } catch (err) {
        console.error('❌ processarArquivoImportacao:', err);
        exibirStatusImportacao(err.message || 'Erro ao processar o arquivo.', true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Processar Arquivo'; }
    }
}

async function buscarHashesJaImportados(clienteId, hashes) {
    if (!hashes.length) return new Set();
    try {
        const { data, error } = await supabaseClient
            .from('transacoes')
            .select('import_hash')
            .eq('client_id', clienteId)
            .in('import_hash', hashes);
        if (error) throw error;
        return new Set((data || []).map(r => r.import_hash));
    } catch (err) {
        console.warn('⚠️ Não foi possível checar duplicados — prosseguindo sem essa checagem:', err.message);
        return new Set();
    }
}

function exibirStatusImportacao(mensagem, ehErro) {
    const el = document.getElementById('importResumoStatus');
    if (!el) return;
    el.textContent = mensagem;
    el.classList.remove('hidden');
    el.classList.toggle('import-status--error', !!ehErro);
}

function esconderTabelaRevisao() {
    document.getElementById('importReviewContainer')?.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════
// RENDERIZAÇÃO DA TABELA DE REVISÃO
// ══════════════════════════════════════════════════════════════

function montarOpcoesCategoriaImportacao(categoriaSelecionadaId) {
    const porGrupo = {};
    categoriasCacheImportacao.forEach(c => {
        const chave = `${c.tipo}__${c.grupo}`;
        if (!porGrupo[chave]) porGrupo[chave] = [];
        porGrupo[chave].push(c);
    });

    const ordemGrupos = ['despesa__essencial', 'despesa__estilo_de_vida', 'despesa__investimento', 'receita__renda'];
    const chaves = [...ordemGrupos.filter(k => porGrupo[k]), ...Object.keys(porGrupo).filter(k => !ordemGrupos.includes(k))];

    let html = '<option value="">Selecione...</option>';
    chaves.forEach(chave => {
        const [, grupo] = chave.split('__');
        const label = GRUPO_LABEL_IMPORTACAO[grupo] || grupo;
        porGrupo[chave]
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
            .forEach(c => {
                const selecionado = c.id === categoriaSelecionadaId ? 'selected' : '';
                html += `<option value="${c.id}" data-tipo="${c.tipo}" ${selecionado}>${label} — ${c.nome}</option>`;
            });
    });
    return html;
}

const ORIGEM_BADGE_LABEL = {
    aprendida: { texto: '🧠 Aprendida', classe: 'aprendida' },
    local:     { texto: '🤖 Sugerida',  classe: 'local' },
    manual:    { texto: '✋ Manual',    classe: 'manual' },
    duplicada: { texto: '⚠️ Já importada', classe: 'duplicada' }
};

function renderizarTabelaRevisao() {
    const corpo = document.getElementById('importReviewTableBody');
    if (!corpo) return;

    corpo.innerHTML = linhasImportacao.map(linha => {
        const badge = ORIGEM_BADGE_LABEL[linha.origem] || ORIGEM_BADGE_LABEL.manual;
        const classeLinha = linha.duplicada ? 'import-row--duplicada' : '';

        return `
            <tr class="${classeLinha}" data-id-temp="${linha.idTemp}">
                <td><input type="checkbox" class="import-check-incluir" ${linha.incluir ? 'checked' : ''} ${linha.duplicada ? 'disabled' : ''}></td>
                <td><input type="date" class="import-input-data" value="${linha.data}"></td>
                <td><input type="text" class="import-input-descricao import-descricao-input" value="${escaparHtmlAtributo(linha.descricao)}"></td>
                <td><input type="number" class="import-input-valor" value="${linha.valor.toFixed(2)}" step="0.01" min="0"></td>
                <td>
                    <select class="import-select-tipo">
                        <option value="despesa" ${linha.tipo === 'despesa' ? 'selected' : ''}>Despesa</option>
                        <option value="receita" ${linha.tipo === 'receita' ? 'selected' : ''}>Receita</option>
                    </select>
                </td>
                <td>
                    <select class="import-select-categoria">
                        ${montarOpcoesCategoriaImportacao(linha.categoriaId)}
                    </select>
                </td>
                <td><span class="import-review__origem-badge import-review__origem-badge--${badge.classe}">${badge.texto}</span></td>
            </tr>
        `;
    }).join('');

    document.getElementById('importReviewContainer')?.classList.remove('hidden');
    document.getElementById('importSelecionarTodas').checked = linhasImportacao.some(l => l.incluir);

    ligarEventosLinhasImportacao();
}

// Escapa aspas para não quebrar o atributo value="..." quando a
// descrição do banco contiver aspas (acontece com alguma frequência).
function escaparHtmlAtributo(texto) {
    return (texto || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Liga os eventos de cada linha renderizada (checkbox, campos
// editáveis) — precisa ser chamado toda vez que a tabela é recriada,
// já que o innerHTML novo descarta os listeners anteriores.
function ligarEventosLinhasImportacao() {
    document.querySelectorAll('#importReviewTableBody tr').forEach(tr => {
        const idTemp = tr.dataset.idTemp;
        const linha  = linhasImportacao.find(l => l.idTemp === idTemp);
        if (!linha) return;

        tr.querySelector('.import-check-incluir')?.addEventListener('change', (e) => {
            linha.incluir = e.target.checked;
        });
        tr.querySelector('.import-input-data')?.addEventListener('change', (e) => {
            linha.data = e.target.value;
        });
        tr.querySelector('.import-input-descricao')?.addEventListener('input', (e) => {
            linha.descricao = e.target.value;
        });
        tr.querySelector('.import-input-valor')?.addEventListener('input', (e) => {
            linha.valor = parseFloat(e.target.value) || 0;
        });
        tr.querySelector('.import-select-tipo')?.addEventListener('change', (e) => {
            linha.tipo = e.target.value;
        });
        tr.querySelector('.import-select-categoria')?.addEventListener('change', (e) => {
            linha.categoriaId = e.target.value || null;
        });
    });
}

function initImportacaoExtrato() {
    document.getElementById('btnProcessarImportacao')?.addEventListener('click', processarArquivoImportacao);
    document.getElementById('btnCancelarImportacao')?.addEventListener('click', cancelarImportacao);
    document.getElementById('btnConfirmarImportacao')?.addEventListener('click', confirmarImportacao);

    document.getElementById('importSelecionarTodas')?.addEventListener('change', (e) => {
        const marcarTodas = e.target.checked;
        linhasImportacao.forEach(l => { if (!l.duplicada) l.incluir = marcarTodas; });
        document.querySelectorAll('.import-check-incluir:not(:disabled)').forEach(chk => { chk.checked = marcarTodas; });
    });
}

function cancelarImportacao() {
    linhasImportacao = [];
    hashesJaImportadosCache = new Set();
    esconderTabelaRevisao();
    document.getElementById('importResumoStatus')?.classList.add('hidden');
    const input = document.getElementById('importFileInput');
    if (input) input.value = '';
}

// ══════════════════════════════════════════════════════════════
// CONFIRMAÇÃO: SALVA NO BANCO + APRENDE AS CORREÇÕES
// ══════════════════════════════════════════════════════════════

async function confirmarImportacao() {
    const clientId = ClientModule.getClientId();
    const linhasParaSalvar = linhasImportacao.filter(l => l.incluir && !l.duplicada);

    if (!linhasParaSalvar.length) {
        UIModule.showError('Nenhuma linha selecionada para importar.');
        return;
    }

    // Validação: toda linha incluída precisa ter categoria escolhida, E
    // essa categoria precisa bater com o tipo (receita/despesa) da
    // linha — evita salvar uma inconsistência (ex: categoria de receita
    // numa linha marcada como despesa).
    for (const linha of linhasParaSalvar) {
        if (!linha.categoriaId) {
            UIModule.showError(`Falta escolher a categoria de "${linha.descricao}" antes de confirmar.`);
            return;
        }
        const cat = categoriasCacheImportacao.find(c => c.id === linha.categoriaId);
        if (!cat) { UIModule.showError(`Categoria inválida em "${linha.descricao}".`); return; }
        if (cat.tipo !== linha.tipo) {
            UIModule.showError(`A categoria de "${linha.descricao}" é de ${cat.tipo}, mas a linha está marcada como ${linha.tipo}. Corrige o tipo ou a categoria.`);
            return;
        }
    }

    const btn = document.getElementById('btnConfirmarImportacao');
    if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

    try {
        const payload = linhasParaSalvar.map(linha => ({
            client_id:        clientId,
            categoria_id:     linha.categoriaId,
            valor:            linha.valor,
            data_competencia: linha.data,
            descricao:        linha.descricao,
            tipo:             linha.tipo,
            origem:           'importacao',
            import_hash:      linha.importHash
        }));

        const { inseridas, duplicadasNoMomentoDeSalvar } = await salvarLoteComTratamentoDeDuplicados(payload);

        // Aprendizado de Categorias: para cada linha realmente salva,
        // grava/reforça a regra termo -> categoria, exatamente como o
        // formulário manual já faz — assim a próxima importação (ou
        // lançamento manual) do mesmo termo já vem pronta.
        if (typeof RegrasAprendidasModule !== 'undefined') {
            for (const linha of linhasParaSalvar) {
                if (!linha.descricao?.trim()) continue;
                try {
                    await RegrasAprendidasModule.salvarOuAtualizarRegra({
                        clienteId:   clientId,
                        termoBusca:  linha.descricao,
                        categoriaId: linha.categoriaId,
                        tipo:        linha.tipo
                    });
                } catch (_) { /* falha ao aprender não deve travar a importação */ }
            }
        }

        let mensagem = `${inseridas} lançamento(s) importado(s) com sucesso!`;
        if (duplicadasNoMomentoDeSalvar > 0) {
            mensagem += ` ${duplicadasNoMomentoDeSalvar} foram ignorado(s) por já existirem (detectados só no momento de salvar).`;
        }
        UIModule.showSuccess(mensagem);

        cancelarImportacao(); // limpa a tabela/estado
        await loadClientDashboard();
    } catch (err) {
        console.error('❌ confirmarImportacao:', err);
        UIModule.showError(err.message || 'Erro ao importar os lançamentos.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✓ Confirmar Importação'; }
    }
}

/**
 * Tenta inserir todas as linhas de uma vez (rápido, 1 chamada de
 * rede). Se o Postgres rejeitar por causa da constraint UNIQUE
 * (client_id, import_hash) — código 23505 — significa que PELO MENOS
 * UMA linha do lote já existe (pode ter sido importada em outra aba,
 * ou entre o momento da checagem de duplicados e agora). Nesse caso,
 * refaz a inserção LINHA A LINHA, pulando só as que colidirem — mais
 * lento, mas só acontece nesse caso de borda; o caminho feliz (sem
 * duplicados) continua sendo uma única chamada.
 */
async function salvarLoteComTratamentoDeDuplicados(payload) {
    try {
        const inseridas = await DatabaseModule.addTransactionsBulk(payload);
        return { inseridas: inseridas.length, duplicadasNoMomentoDeSalvar: 0 };
    } catch (err) {
        const ehConflitoDeDuplicado = err.code === '23505' || /duplicate key|unique_import_hash/i.test(err.message || '');
        if (!ehConflitoDeDuplicado) throw err;

        console.warn('⚠️ Conflito de duplicado no lote — refazendo linha a linha.');
        let inseridas = 0;
        let duplicadas = 0;

        for (const linha of payload) {
            try {
                await DatabaseModule.addTransaction(linha);
                inseridas++;
            } catch (erroLinha) {
                const duplicada = erroLinha.code === '23505' || /duplicate key|unique_import_hash/i.test(erroLinha.message || '');
                if (duplicada) duplicadas++;
                else throw erroLinha;
            }
        }

        return { inseridas, duplicadasNoMomentoDeSalvar: duplicadas };
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImportacaoExtrato);
} else {
    initImportacaoExtrato();
}

console.log('✅ importacao-extrato.js carregado');
