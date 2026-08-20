/**
 * DATABASE.JS - CAMADA DE DADOS COM ANOTAÇÕES
 * ================================================
 * ATUALIZAÇÃO — EDIÇÃO/EXCLUSÃO DE TRANSAÇÕES:
 * Adicionados updateTransaction() e deleteTransaction(). A RLS de
 * `transacoes` já foi corrigida numa sessão anterior para permitir
 * UPDATE/DELETE do próprio cliente (client_id = auth.uid()) — sem essa
 * correção, estas duas funções falhariam com 403 do mesmo jeito que o
 * INSERT falhava antes.
 *
 * ATUALIZAÇÃO — ORDEM "RECEITA ANTES DE DESPESA":
 * getCategorias() ordenava por `tipo` ascendente — como 'despesa' vem
 * antes de 'receita' em ordem alfabética, toda lista que consumia essa
 * função (dropdown de transação, tabela de importação, listas do
 * admin) acabava mostrando Despesas primeiro. Trocado para
 * `ascending: false`, que — por 'receita' > 'despesa' alfabeticamente
 * — sempre traz Receita primeiro, em qualquer tela que use esta
 * função como fonte.
 */

const DatabaseModule = (() => {
    const executeQuery = async (fn, errorMsg) => {
        try {
            const result = await fn();
            return result;
        } catch (error) {
            console.error(`❌ ${errorMsg}:`, error);
            throw error;
        }
    };

    return {
        async getCategorias() {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CATEGORIAS)
                .select('*')
                .order('tipo', { ascending: false }) // receita antes de despesa
                .order('grupo')
                .order('nome');
            if (error) throw error;
            return data || [];
        },

        async getClients(adminId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .select('*')
                .eq('admin_id', adminId)
                .order('nome');
            if (error) throw error;
            return data || [];
        },

        async getClientById(clientId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .select('*')
                .eq('id', clientId)
                .single();
            if (error) throw error;
            return data;
        },

        async addClient(clientData) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .insert([clientData])
                .select();
            if (error) throw error;
            return data?.[0];
        },

        async updateClient(clientId, updates) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .update(updates)
                .eq('id', clientId)
                .select();
            if (error) throw error;
            return data?.[0];
        },

        async deleteClient(clientId) {
            const { error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .delete()
                .eq('id', clientId);
            if (error) throw error;
            return true;
        },

        async getClientComments(clientId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .select('comentarios')
                .eq('id', clientId)
                .single();
            if (error) throw error;
            return data?.comentarios || '';
        },

        async saveClientComments(clientId, comments) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.CLIENTES)
                .update({ comentarios: comments })
                .eq('id', clientId)
                .select();
            if (error) throw error;
            return data?.[0];
        },

        async getTransactionsByClient(clientId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .select(`
                    *,
                    categorias(id, nome, tipo, grupo)
                `)
                .eq('client_id', clientId)
                .order('data_competencia', { ascending: false });
            if (error) throw error;
            return data || [];
        },

        async getAllTransactions(adminId) {
            const clients = await this.getClients(adminId);
            if (clients.length === 0) return [];

            const clientIds = clients.map(c => c.id);
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .select(`
                    *,
                    clientes(id, nome),
                    categorias(id, nome, tipo, grupo)
                `)
                .in('client_id', clientIds)
                .order('data_competencia', { ascending: false });
            if (error) throw error;
            return data || [];
        },

        async addTransaction(transactionData) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .insert([transactionData])
                .select();
            if (error) throw error;
            return data?.[0];
        },

        /**
         * Atualiza uma transação existente. `updates` pode incluir
         * qualquer subconjunto de { categoria_id, valor, data_competencia,
         * descricao, tipo }. Retorna a linha já atualizada, com o join de
         * `categorias` incluso (mesmo formato de getTransactionsByClient),
         * para poder substituir a entrada no cache local sem precisar
         * refazer a consulta inteira.
         */
        async updateTransaction(transactionId, updates) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .update(updates)
                .eq('id', transactionId)
                .select(`
                    *,
                    categorias(id, nome, tipo, grupo)
                `);
            if (error) throw error;
            return data?.[0];
        },

        async deleteTransaction(transactionId) {
            const { error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .delete()
                .eq('id', transactionId);
            if (error) throw error;
            return true;
        },

        /**
         * Insere várias transações de uma vez (usado pela importação de
         * extrato OFX/CSV — ver importacao-extrato.js). Uma ÚNICA
         * chamada de rede para N linhas, em vez de N chamadas
         * sequenciais — essencial para performance quando o extrato tem
         * dezenas/centenas de lançamentos.
         *
         * IMPORTANTE — DUPLICADOS: `transacoes` tem uma constraint
         * `UNIQUE (client_id, import_hash)` já existente no banco. Se
         * ALGUMA linha do lote violar essa constraint (o cliente já
         * importou aquele lançamento antes), o Postgres rejeita o
         * INSERT inteiro (todas as linhas, não só a duplicada — é uma
         * única instrução SQL). Por isso este método é chamado pelo
         * importador linha por linha quando há risco de duplicata (ver
         * `salvarLoteComTratamentoDeDuplicados` em importacao-extrato.js),
         * e em lote único apenas quando o chamador já garantiu que não
         * há duplicados no lote.
         */
        async addTransactionsBulk(transactionsData) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.TRANSACOES)
                .insert(transactionsData)
                .select();
            if (error) throw error;
            return data || [];
        },

        async getMetasByClient(clientId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.METAS)
                .select('*')
                .eq('client_id', clientId);
            if (error) throw error;
            return data || [];
        },

        async getMetasByAdmin(adminId) {
            const clients = await this.getClients(adminId);
            if (clients.length === 0) return [];

            const clientIds = clients.map(c => c.id);
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.METAS)
                .select('*, clientes(id, nome)')
                .in('client_id', clientIds);
            if (error) throw error;
            return data || [];
        },

        async addMeta(metaData) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.METAS)
                .insert([metaData])
                .select();
            if (error) throw error;
            return data?.[0];
        },

        async updateMeta(metaId, updates) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.METAS)
                .update(updates)
                .eq('id', metaId)
                .select();
            if (error) throw error;
            return data?.[0];
        },

        async deleteMeta(metaId) {
            const { error } = await supabaseClient
                .from(CONFIG.TABLES.METAS)
                .delete()
                .eq('id', metaId);
            if (error) throw error;
            return true;
        },

        /**
         * Planejamentos de um admin — feito via join com `clientes`
         * (filtrando pelos client_id que pertencem a este admin), NÃO
         * por uma coluna `planejamentos.admin_id` — essa coluna NÃO
         * EXISTE na tabela (confirmado via Supabase MCP). Qualquer
         * consulta direta a `planejamentos` filtrando por `admin_id`
         * falha com erro 400 "column does not exist" — foi o que
         * quebrava a aba Planejamentos do admin. planejamentos.js
         * segue exatamente este mesmo padrão (client_id IN clientIds).
         */
        async getPlanningsByAdmin(adminId) {
            const clients = await this.getClients(adminId);
            if (clients.length === 0) return [];

            const clientIds = clients.map(c => c.id);
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.PLANEJAMENTOS)
                .select('*, clientes(id, nome)')
                .in('client_id', clientIds)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },

        async getPlanningsByClient(clientId) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.PLANEJAMENTOS)
                .select('*')
                .eq('client_id', clientId)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },

        async addPlanning(planningData) {
            const { data, error } = await supabaseClient
                .from(CONFIG.TABLES.PLANEJAMENTOS)
                .insert([planningData])
                .select();
            if (error) throw error;
            return data?.[0];
        }
    };
})();

console.log('✅ database.js carregado');
