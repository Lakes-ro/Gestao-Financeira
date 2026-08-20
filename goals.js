/**
 * GOALS.JS - LÓGICA DE METAS
 * ================================================
 * ATUALIZAÇÃO — MOEDA NO PADRÃO BRASILEIRO:
 * formatGoal() usava `R$ ${valor.toFixed(2)}` — trocado por
 * `UIModule.formatCurrency()`.
 */

const GoalsModule = (() => {
    let allGoals = [];

    const formatGoal = (goal) => {
        const necessario   = parseFloat(goal.valor_necessario || 0);
        const economizado  = parseFloat(goal.valor_economizado || 0);
        const progress      = necessario > 0 ? (economizado / necessario) * 100 : 0;
        const progressColor = progress >= 100 ? '#64ff7a' : progress >= 50 ? '#ffd700' : '#6495ff';

        return `
            <div class="meta-card">
                <div class="meta-header">
                    <div>
                        <div class="meta-nome">${goal.nome}</div>
                        <div class="meta-client">${goal.clientes?.nome || ''}</div>
                    </div>
                </div>
                <div class="meta-progress-bar">
                    <div class="meta-progress-fill" style="width: ${Math.min(progress, 100)}%; background: ${progressColor};"></div>
                </div>
                <div class="meta-info">
                    <div class="meta-info-item">
                        <div class="meta-info-label">Economizado</div>
                        <div class="meta-info-value">${UIModule.formatCurrency(economizado)}</div>
                    </div>
                    <div class="meta-info-item">
                        <div class="meta-info-label">Necessário</div>
                        <div class="meta-info-value">${UIModule.formatCurrency(necessario)}</div>
                    </div>
                    <div class="meta-info-item">
                        <div class="meta-info-label">Progresso</div>
                        <div class="meta-info-value">${progress.toFixed(1)}%</div>
                    </div>
                </div>
            </div>
        `;
    };

    return {
        async loadAllGoals(adminId) {
            try {
                allGoals = await DatabaseModule.getMetasByAdmin(adminId);
                return allGoals;
            } catch (error) {
                console.error('❌ Erro ao carregar metas:', error);
                throw error;
            }
        },

        async loadClientGoals(clientId) {
            try {
                const goals = await DatabaseModule.getMetasByClient(clientId);
                return goals;
            } catch (error) {
                console.error('❌ Erro ao carregar metas do cliente:', error);
                throw error;
            }
        },

        async addGoal(goalData) {
            try {
                const result = await DatabaseModule.addMeta(goalData);
                allGoals.push(result);
                return result;
            } catch (error) {
                console.error('❌ Erro ao adicionar meta:', error);
                throw error;
            }
        },

        async updateGoal(goalId, updates) {
            try {
                const result = await DatabaseModule.updateMeta(goalId, updates);
                const index = allGoals.findIndex(g => g.id === goalId);
                if (index !== -1) {
                    allGoals[index] = result;
                }
                return result;
            } catch (error) {
                console.error('❌ Erro ao atualizar meta:', error);
                throw error;
            }
        },

        async deleteGoal(goalId) {
            try {
                await DatabaseModule.deleteMeta(goalId);
                allGoals = allGoals.filter(g => g.id !== goalId);
                return true;
            } catch (error) {
                console.error('❌ Erro ao deletar meta:', error);
                throw error;
            }
        },

        renderGoals(containerId, goals = null) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const goalsToRender = goals || allGoals;
            const html = goalsToRender
                .map(g => formatGoal(g))
                .join('');

            UIModule.setHTML(containerId, html || '<p class="empty-state">Nenhuma meta</p>');
        },

        getGoals: () => allGoals
    };
})();

console.log('✅ goals.js carregado');
