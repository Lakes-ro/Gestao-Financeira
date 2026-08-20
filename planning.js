/**
 * PLANNING.JS - LÓGICA DE PLANEJAMENTOS
 * ================================================
 */

const PlanningModule = (() => {
    let allPlannings = [];

    return {
        async loadAdminPlannings(adminId) {
            try {
                allPlannings = await DatabaseModule.getPlanningsByAdmin(adminId);
                return allPlannings;
            } catch (error) {
                console.error('❌ Erro ao carregar planejamentos:', error);
                throw error;
            }
        },

        async loadClientPlannings(clientId) {
            try {
                return await DatabaseModule.getPlanningsByClient(clientId);
            } catch (error) {
                console.error('❌ Erro ao carregar planejamentos:', error);
                throw error;
            }
        },

        async addPlanning(planningData) {
            try {
                const result = await DatabaseModule.addPlanning(planningData);
                allPlannings.push(result);
                UIModule.showSuccess('Planejamento criado!');
                return result;
            } catch (error) {
                UIModule.showError('Erro ao criar planejamento');
                throw error;
            }
        },

        renderAdminPlannings(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const html = allPlannings
                .map(p => `
                    <div class="planning-card">
                        <h3>${p.titulo}</h3>
                        <p>${p.cliente?.nome || 'Cliente'}</p>
                        <div class="planning-details">
                            <p><strong>Recomendações:</strong></p>
                            <p>${p.recomendacoes || '-'}</p>
                        </div>
                    </div>
                `)
                .join('');

            UIModule.setHTML(containerId, html || '<p class="empty-state">Nenhum planejamento</p>');
        },

        getPlannings: () => allPlannings
    };
})();

console.log('✅ planning.js carregado');
