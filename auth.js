/**
 * AUTH.JS - AUTENTICAÇÃO COM RBAC
 * ================================================
 * ALTERAÇÃO: com persistSession:true (config.js), a sessão do
 * Supabase agora é gravada em localStorage e sobrevive a reloads
 * e navegação entre páginas. checkSession() foi reescrito para
 * de facto consultar getSession() e restaurar o utilizador,
 * em vez de retornar null sempre.
 *
 * ATUALIZAÇÃO — METADADOS NO CADASTRO (evita pedir nome/apelido
 * duas vezes): register() agora aceita um segundo argumento
 * `metadata` (ex: { nome_completo, apelido }), passado como
 * `options.data` do signUp(). Isso grava essa informação DIRETO na
 * conta do Supabase Auth — não numa tabela separada — então ela:
 *   1. Não depende de nenhuma policy de RLS pra ser lida depois.
 *   2. Fica disponível na sessão em QUALQUER dispositivo, mesmo se a
 *      confirmação de e-mail acontecer num aparelho diferente de
 *      onde a conta foi criada.
 *   3. Não exige nenhuma chamada de rede extra pra ser consultada —
 *      já vem junto com `session.user.user_metadata`.
 * Isso resolve a causa raiz do onboarding pedir Nome/Apelido de novo
 * depois da confirmação de e-mail (ver checkOnboarding em app.js).
 *
 * Também adicionado atualizarMetadados(), usado pelo onboarding de
 * fallback (handleOnboarding em app.js) pra fazer o "backfill" desses
 * metadados em contas antigas que ainda não os têm.
 */

const AuthModule = (() => {
    let currentUser     = null;
    let userRole        = null; // 'admin' | 'client'
    let currentClientId = null;

    const notifyChange = () => {
        window.dispatchEvent(new CustomEvent('auth-changed', {
            detail: { user: currentUser, role: userRole, clientId: currentClientId }
        }));
    };

    return {
        /**
         * Verifica se existe uma sessão persistida (localStorage).
         * Se existir, restaura currentUser/userRole/currentClientId
         * e retorna o utilizador. Caso contrário, retorna null.
         */
        async checkSession() {
            try {
                const { data: { session }, error } = await supabaseClient.auth.getSession();

                if (error || !session) {
                    return null;
                }

                currentUser = session.user;
                const role  = await this.determineUserRole(session.user.id, session.user.email);

                if (!role) {
                    await supabaseClient.auth.signOut();
                    currentUser     = null;
                    userRole        = null;
                    currentClientId = null;
                    return null;
                }

                notifyChange();
                console.log('✅ Sessão restaurada:', session.user.email, '| Role:', role);
                return currentUser;
            } catch (err) {
                console.warn('⚠️ Erro ao verificar sessão:', err.message);
                return null;
            }
        },

        /**
         * Determina role com regras estritas:
         * 1. Se o email for ADMIN_EMAIL → 'admin'
         * 2. Se o user.id existir na tabela clientes → 'client'
         * 3. Qualquer outro caso → cliente novo (onboarding pendente)
         */
        async determineUserRole(userId, email) {
            // Guarda contra logins OAuth onde email pode ser null/undefined
            // (ex: login com Apple que permite ocultar o email)
            if (!email) {
                userRole        = 'client';
                currentClientId = userId;
                console.warn('⚠️ determineUserRole: email ausente — tratado como cliente novo.');
                return userRole;
            }

            // Regra 1: email admin hardcoded
            if (email === CONFIG.ADMIN.EMAIL) {
                userRole        = 'admin';
                currentClientId = null;
                console.log('✅ Role: Admin');
                return userRole;
            }

            // Regra 2: verifica se é cliente cadastrado
            try {
                const { data, error } = await supabaseClient
                    .from(CONFIG.TABLES.CLIENTES)
                    .select('id')
                    .eq('id', userId)
                    .maybeSingle();

                if (!error && data) {
                    userRole        = 'client';
                    currentClientId = userId;
                    console.log('✅ Role: Cliente', userId);
                    return userRole;
                }
            } catch (err) {
                console.warn('⚠️ Erro ao consultar clientes:', err.message);
            }

            // Regra 3: utilizador registado mas ainda sem perfil de cliente
            // → passa pelo onboarding e depois é inserido em clientes
            userRole        = 'client';
            currentClientId = userId;
            console.log('✅ Role: Novo cliente (onboarding pendente)', userId);
            return userRole;
        },

        async login(email, password) {
            try {
                const { data, error } = await supabaseClient.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) throw error;
                if (!data.user) throw new Error('Nenhum utilizador retornado');

                currentUser = data.user;
                const role  = await this.determineUserRole(data.user.id, data.user.email);

                if (!role) {
                    // Faz logout imediato — email não autorizado
                    await supabaseClient.auth.signOut();
                    currentUser = null;
                    throw new Error('Acesso não autorizado. Este email não está registado no sistema.');
                }

                notifyChange();
                console.log('✅ Login:', email, '| Role:', role);

                return { user: data.user, role };
            } catch (error) {
                console.error('❌ Erro login:', error);
                throw error;
            }
        },

        /**
         * @param {string} email
         * @param {string} password
         * @param {Object} [metadata] - dados extra gravados DIRETO na
         *   conta (ex: { nome_completo, apelido }) — ver nota no
         *   cabeçalho do ficheiro sobre por que isso evita pedir a
         *   mesma informação duas vezes.
         */
        async register(email, password, metadata = {}) {
            try {
                const { data, error } = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: { data: metadata }
                });

                if (error) throw error;
                if (!data.user) throw new Error('Nenhum utilizador retornado');

                currentUser     = data.user;
                userRole        = 'client';
                currentClientId = data.user.id;

                notifyChange();
                console.log('✅ Registo:', email);

                return data.user;
            } catch (error) {
                console.error('❌ Erro registo:', error);
                throw error;
            }
        },

        /**
         * Atualiza os metadados da conta já autenticada (ex: backfill
         * de nome_completo/apelido numa conta antiga que ainda não
         * tinha isso salvo — ver handleOnboarding em app.js). Diferente
         * de register(), aqui a pessoa já está logada.
         */
        async atualizarMetadados(metadata) {
            const { data, error } = await supabaseClient.auth.updateUser({ data: metadata });
            if (error) throw error;

            currentUser = data.user;
            notifyChange();
            return data.user;
        },

        async logout() {
            try {
                await supabaseClient.auth.signOut();
            } catch (_) {
                // ignora erro de signOut (sessão já expirada)
            }

            currentUser     = null;
            userRole        = null;
            currentClientId = null;
            notifyChange();

            console.log('✅ Logout');
            return true;
        },

        getUser:         () => currentUser,
        getUserRole:     () => userRole,
        getClientId:     () => currentClientId,
        getUserMetadata: () => currentUser?.user_metadata || {},
        isLogged:        () => currentUser !== null,
        isAdmin:         () => userRole === 'admin',
        isClient:        () => userRole === 'client'
    };
})();

console.log('✅ auth.js carregado');