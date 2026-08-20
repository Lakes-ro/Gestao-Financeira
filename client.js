/**
 * CLIENT.JS — Módulo: Estado do Cliente Logado
 * ================================================
 * Usado por: index.html e client.html (via app.js)
 * Padrão: script global (IIFE). Sem import/export.
 *
 * NÃO CONFUNDIR com clientes.js (que é o CRUD de clientes feito
 * pelo administrador, usado em admin.html). Este ficheiro trata do
 * cliente que está autenticado na própria sessão — guarda o seu id
 * e expõe helpers que o app.js usa para registar/editar/excluir
 * transações e metas em nome desse cliente.
 *
 * ATUALIZAÇÃO — EDIÇÃO/EXCLUSÃO DE TRANSAÇÕES: updateTransaction() e
 * deleteTransaction() adicionados, espelhando addTransaction/addGoal
 * (delegam para DatabaseModule). Usados pelo modal de edição de
 * transação em app.js (handleSalvarEdicaoTransacao/handleDeletarTransacao).
 *
 * Depende de: DatabaseModule (definido em database.js — deve ser
 * carregado ANTES deste ficheiro no HTML).
 */

const ClientModule = (() => {
    let clientId = null;

    return {
        setClientId(id) {
            clientId = id;
        },

        getClientId() {
            return clientId;
        },

        async addTransaction(transactionData) {
            return await DatabaseModule.addTransaction(transactionData);
        },

        async updateTransaction(transactionId, updates) {
            return await DatabaseModule.updateTransaction(transactionId, updates);
        },

        async deleteTransaction(transactionId) {
            return await DatabaseModule.deleteTransaction(transactionId);
        },

        async addGoal(goalData) {
            return await DatabaseModule.addMeta(goalData);
        }
    };
})();

console.log('✅ client.js carregado');
