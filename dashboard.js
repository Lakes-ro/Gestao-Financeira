/**
 * DASHBOARD.JS - LÓGICA DO DASHBOARD
 * ================================================
 * ATUALIZAÇÃO — CAIXINHAS/METAS (ALOCAÇÃO DE SALDO):
 * A matemática do saldo NÃO mudou — ela já estava correta. Despesas de
 * categoria 'investimento' (Aporte em Investimentos, Previdência
 * Privada, Reserva de Emergência) já eram do tipo 'despesa' e já
 * entravam em totalDespesas, então o dinheiro alocado a elas já era
 * subtraído do saldo. O que estava faltando era o VÍNCULO entre essa
 * despesa e uma Meta específica (ver transacoes.meta_id e os triggers
 * `trg_validar_meta_id`/`trg_sync_valor_economizado_meta` no banco,
 * mais o seletor "Vincular a uma Meta" em app.js) — isso é o que agora
 * mantém `metas.valor_economizado` sincronizado automaticamente.
 *
 * Esta atualização só torna a decomposição EXPLÍCITA (nomeando
 * `saldoDisponivel` e `totalAlocado` em vez de só `saldo`), para que a
 * UI possa exibir com clareza "Saldo Disponível" já descontando o que
 * está protegido em metas/investimentos — sem subtrair esse valor
 * DUAS vezes (ele já está dentro de totalDespesas).
 */

const DashboardModule = (() => {
    let cachedData = null;

    const calculateMetrics = (transactions) => {
        const metrics = {
            custoDeSobrevivencia: 0,
            custoDeVida:          0,
            aportesInvestimento:  0, // categorias.grupo === 'investimento' — dinheiro já protegido/alocado
            rendaPassiva:         0, // categorias não distingue ativa/passiva hoje — fica sempre 0 (ver nota abaixo)
            rendaAtiva:           0,
            totalReceitas:        0,
            totalDespesas:        0, // essencial + estilo_de_vida + investimento (todas as despesas, sem exceção)
            saldo:                0, // ALIAS de saldoDisponivel — mantido para não quebrar quem já lê `.saldo`
            saldoDisponivel:      0, // = totalReceitas - totalDespesas (já exclui o alocado, pois investimento é uma despesa)
            totalAlocado:         0, // ALIAS de aportesInvestimento — nome explícito p/ exibição no dashboard
            cobertura:            0
        };

        // NOTA: a tabela `categorias` (correta, com RLS liberado pro
        // cliente) usa um único campo `grupo` para receitas: todas as
        // categorias de receita hoje vêm marcadas como 'renda', sem
        // separar renda ativa de passiva (diferente da extinta
        // `plano_de_contas`, que tinha `tipo_renda`). Por isso toda
        // receita entra como rendaAtiva; rendaPassiva fica em 0 até
        // que exista uma forma de marcar isso em `categorias`.
        transactions.forEach(t => {
            const valor = parseFloat(t.valor || 0);

            if (t.tipo === 'receita') {
                metrics.totalReceitas += valor;
                metrics.rendaAtiva    += valor;
            } else {
                metrics.totalDespesas += valor;
                const grupo = t.categorias?.grupo;
                if (grupo === 'essencial') {
                    metrics.custoDeSobrevivencia += valor;
                } else if (grupo === 'investimento') {
                    metrics.aportesInvestimento += valor;
                } else {
                    metrics.custoDeVida += valor;
                }
            }
        });

        // saldoDisponivel = tudo que entrou menos tudo que saiu. Como
        // 'investimento' já é uma despesa somada em totalDespesas, o
        // dinheiro alocado em metas/caixinhas JÁ está excluído aqui —
        // não subtraímos aportesInvestimento de novo (isso duplicaria
        // o desconto e mostraria um saldo menor do que o real).
        metrics.saldoDisponivel = metrics.totalReceitas - metrics.totalDespesas;
        metrics.saldo           = metrics.saldoDisponivel; // alias retrocompatível
        metrics.totalAlocado    = metrics.aportesInvestimento; // alias com nome explícito

        if (metrics.custoDeSobrevivencia > 0) {
            metrics.cobertura = (metrics.rendaPassiva / metrics.custoDeSobrevivencia) * 100;
        }

        return metrics;
    };

    const getCategoryBreakdown = (transactions) => {
        const breakdown = {};

        transactions
            .filter(t => t.tipo === 'despesa')
            .forEach(t => {
                const category = t.categorias?.nome || 'Sem Categoria';
                breakdown[category] = (breakdown[category] || 0) + parseFloat(t.valor || 0);
            });

        return Object.entries(breakdown)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10);
    };

    return {
        async load(clientId) {
            try {
                const transactions = await DatabaseModule.getTransactionsByClient(clientId);
                cachedData = {
                    metrics: calculateMetrics(transactions),
                    categories: getCategoryBreakdown(transactions),
                    transactions
                };
                return cachedData;
            } catch (error) {
                console.error('❌ Erro ao carregar dashboard:', error);
                throw error;
            }
        },

        async renderClientDashboard(clientId) {
            try {
                const data = await this.load(clientId);
                const m = data.metrics;

                UIModule.setText('totalReceitas', `R$ ${m.totalReceitas.toFixed(2)}`);
                UIModule.setText('totalDespesas', `R$ ${m.totalDespesas.toFixed(2)}`);
                UIModule.setText('saldo', `R$ ${m.saldoDisponivel.toFixed(2)}`);

                // Subtexto opcional sob o Saldo, mostrando quanto já
                // está protegido em metas/investimentos — só aparece se
                // o elemento existir no HTML (ver client.html/index.html,
                // classe .bi-detail reaproveitada dentro do resume-item
                // do saldo). Não quebra nada se o elemento não existir.
                UIModule.setText('saldoAlocadoDetalhe',
                    m.totalAlocado > 0 ? `já descontado R$ ${m.totalAlocado.toFixed(2)} em Metas/Investimentos` : '');

                UIModule.setText('biSurvivalCost', `R$ ${m.custoDeSobrevivencia.toFixed(2)}`);
                UIModule.setText('biLifestyleCost', `R$ ${m.custoDeVida.toFixed(2)}`);
                UIModule.setText('biInvestments', `R$ ${m.aportesInvestimento.toFixed(2)}`);
                UIModule.setText('biPassiveIncome', `R$ ${m.rendaPassiva.toFixed(2)}`);
                UIModule.setText('biCoverage', `${m.cobertura.toFixed(1)}%`);

                return data;
            } catch (error) {
                UIModule.showError('Erro ao carregar dashboard');
                throw error;
            }
        },

        getData: () => cachedData
    };
})();

console.log('✅ dashboard.js carregado');
