/**
 * NOTIFICATIONS.JS — Módulo de Notificações Push + Lembretes In-App
 * ================================================
 * Padrão: script global. Sem import/export.
 * Depende de: supabaseClient, ClientModule (carregados antes deste arquivo).
 *
 * COMO FUNCIONA — DOIS CANAIS:
 *
 * 1) LEMBRETE IN-APP (funciona imediatamente, sem configuração extra)
 *    Quando o cliente abre o app e não tem lançamento nos últimos
 *    DIAS_SEM_LANCAMENTO dias, um toast aparece na tela com uma
 *    mensagem de incentivo. Sem permissão, sem push, zero setup.
 *
 * 2) NOTIFICAÇÃO PUSH WEB (requer VAPID + Edge Function)
 *    Chega mesmo com o app fechado. Funciona no Android (Chrome/Firefox)
 *    e no iOS 16.4+ com o app instalado como PWA.
 *    Setup necessário:
 *    a) Gere as chaves VAPID:  npx web-push generate-vapid-keys
 *    b) Cole a PUBLIC KEY em VAPID_PUBLIC_KEY abaixo.
 *    c) Cole a PRIVATE KEY nas env vars da Edge Function no Supabase.
 *    d) Execute o SQL de migração (ao final deste arquivo).
 *    e) Deploy da Edge Function enviar-lembretes (ao final deste arquivo).
 *
 * INTEGRAÇÃO NO APP:
 *    Chame `NotificacoesModule.inicializar(clienteId)` após o login
 *    do cliente. Já foi adicionado em app.js (routeByRole + handleOnboarding).
 */

// ── ⚠️ CONFIGURE AQUI ─────────────────────────────────────────
// Cole a PUBLIC KEY gerada por: npx web-push generate-vapid-keys
// Enquanto não configurar, só o lembrete in-app vai funcionar.
const VAPID_PUBLIC_KEY = 'COLE_SUA_VAPID_PUBLIC_KEY_AQUI';
// ─────────────────────────────────────────────────────────────

/** Dias sem lançamento que dispara o lembrete in-app. */
const DIAS_SEM_LANCAMENTO = 3;

/** Frases sorteadas nos lembretes — edite à vontade. */
const FRASES_LEMBRETE = [
    { title: 'MentorFin 💰', body: 'Comprou ou vendeu? Registre aqui e tenha seu relatório mensal!' },
    { title: 'MentorFin 📊', body: 'Não se esqueça de registrar suas receitas e despesas de hoje.' },
    { title: 'MentorFin 🎯', body: 'Seu controle financeiro te espera! Atualize seus lançamentos.' },
    { title: 'MentorFin 💳', body: 'Semana passando — seus gastos estão registrados?' },
    { title: 'MentorFin 📋', body: 'Um lançamento não registrado distorce todo o seu relatório. Confere lá!' },
    { title: 'MentorFin 🏦', body: 'Mês quase acabando! Seus lançamentos estão em dia?' },
    { title: 'MentorFin 📈', body: 'Receita ou despesa de hoje? Registre agora e mantenha o controle!' },
];

// ── Helper: converte VAPID key de base64url para Uint8Array ───
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// ── Helper: frase aleatória ────────────────────────────────────
function sortearFrase() {
    return FRASES_LEMBRETE[Math.floor(Math.random() * FRASES_LEMBRETE.length)];
}

// ══════════════════════════════════════════════════════════════
// MÓDULO PRINCIPAL
// ══════════════════════════════════════════════════════════════
const NotificacoesModule = (() => {

    let swRegistration = null;

    // ─────────────────────────────────────────────────────────
    // CANAL 1 — LEMBRETE IN-APP
    // Não depende de push, permissão ou VAPID.
    // ─────────────────────────────────────────────────────────

    /**
     * Consulta o último lançamento do cliente. Se passaram mais de
     * DIAS_SEM_LANCAMENTO dias, exibe um toast de lembrete.
     */
    async function verificarLembreteInApp(clienteId) {
        if (!clienteId) return;
        try {
            const { data } = await supabaseClient
                .from('transacoes')
                .select('data_competencia')
                .eq('client_id', clienteId)
                .order('data_competencia', { ascending: false })
                .limit(1)
                .maybeSingle();

            const hoje  = new Date();
            const ultimo = data?.data_competencia
                ? new Date(data.data_competencia + 'T00:00:00')
                : null;
            const diasDesdeUltimo = ultimo
                ? Math.floor((hoje - ultimo) / 86_400_000)
                : Infinity;

            if (diasDesdeUltimo >= DIAS_SEM_LANCAMENTO) {
                // Pequeno delay para o dashboard terminar de renderizar
                setTimeout(() => exibirToastLembrete(sortearFrase().body), 2800);
            }
        } catch (_) { /* não crítico — lembrete é opcional */ }
    }

    /** Toast fixo na parte inferior da tela, fecha em 9s ou pelo ✕. */
    function exibirToastLembrete(mensagem) {
        if (document.getElementById('mf-lembrete-inapp')) return; // não empilha

        const el = document.createElement('div');
        el.id = 'mf-lembrete-inapp';
        el.setAttribute('role', 'alert');
        el.style.cssText = `
            position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            width:calc(100% - 32px);max-width:440px;
            background:rgba(26,26,46,.97);backdrop-filter:blur(12px);
            border:1px solid rgba(100,149,255,.3);border-radius:14px;
            padding:14px 16px;z-index:9998;
            box-shadow:0 8px 32px rgba(0,0,0,.55);
            display:flex;align-items:center;gap:12px;
            font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
            animation:slideUp .3s ease;
        `;
        el.innerHTML = `
            <span style="font-size:22px;flex-shrink:0">💰</span>
            <p style="margin:0;font-size:13px;color:#e0e0e0;line-height:1.45;flex:1">${mensagem}</p>
            <button
                aria-label="Fechar lembrete"
                onclick="document.getElementById('mf-lembrete-inapp')?.remove()"
                style="background:none;border:none;color:#a0a0b0;font-size:20px;
                       cursor:pointer;padding:0 4px;flex-shrink:0;line-height:1;">✕</button>`;

        document.body.appendChild(el);
        setTimeout(() => el.remove(), 9000);
    }

    // ─────────────────────────────────────────────────────────
    // CANAL 2 — WEB PUSH (Android/iOS PWA, app fechado)
    // ─────────────────────────────────────────────────────────

    /** Registra o Service Worker na raiz do domínio. */
    async function registrarSW() {
        if (!('serviceWorker' in navigator)) {
            console.warn('⚠️ Notificações: Service Worker não suportado neste browser.');
            return null;
        }
        try {
            swRegistration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
            console.log('✅ Service Worker registrado.');
            return swRegistration;
        } catch (err) {
            console.error('❌ Falha ao registrar SW:', err.message);
            return null;
        }
    }

    /**
     * Mostra um banner convidativo ANTES do prompt nativo do browser.
     * Aumenta significativamente a taxa de aceitação por ser mais amigável
     * do que o prompt genérico "exemplo.com quer enviar notificações".
     */
    function mostrarBannerConvite() {
        return new Promise(resolve => {
            if (Notification.permission !== 'default') { resolve(false); return; }

            const banner = document.createElement('div');
            banner.id = 'mf-notif-banner';
            banner.style.cssText = `
                position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
                width:calc(100% - 32px);max-width:440px;
                background:rgba(26,26,46,.97);backdrop-filter:blur(12px);
                border:1px solid rgba(100,149,255,.35);border-radius:16px;
                padding:18px;z-index:9999;
                box-shadow:0 8px 40px rgba(0,0,0,.6);
                display:flex;flex-direction:column;gap:14px;
                font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
                animation:slideUp .3s ease;
            `;
            banner.innerHTML = `
                <div style="display:flex;align-items:flex-start;gap:14px;">
                    <span style="font-size:30px;line-height:1;flex-shrink:0">🔔</span>
                    <div>
                        <p style="margin:0;font-size:14px;font-weight:700;color:#e0e0e0;">
                            Ativar lembretes do MentorFin?
                        </p>
                        <p style="margin:5px 0 0;font-size:12.5px;color:#a0a0b0;line-height:1.45;">
                            Te avisamos quando esqueceu de registrar receitas e despesas —
                            mesmo com o app fechado.
                        </p>
                    </div>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="mf-notif-nao" style="
                        padding:9px 18px;background:transparent;cursor:pointer;
                        border:1px solid rgba(100,149,255,.3);border-radius:8px;
                        color:#a0a0b0;font-size:13px;font-family:inherit;">
                        Agora não
                    </button>
                    <button id="mf-notif-sim" style="
                        padding:9px 22px;cursor:pointer;
                        background:linear-gradient(135deg,#6495ff,#4a7dff);
                        border:none;border-radius:8px;
                        color:#fff;font-size:13px;font-weight:700;font-family:inherit;">
                        ✓ Ativar lembretes
                    </button>
                </div>`;

            document.body.appendChild(banner);

            const fechar = ok => { banner.remove(); resolve(ok); };
            document.getElementById('mf-notif-sim')?.addEventListener('click', () => fechar(true));
            document.getElementById('mf-notif-nao')?.addEventListener('click', () => fechar(false));
            // Auto-descarta em 20s sem interação
            setTimeout(() => { if (document.getElementById('mf-notif-banner')) fechar(false); }, 20000);
        });
    }

    /** Solicita permissão nativa, precedida pelo banner amigável. */
    async function solicitarPermissao() {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission === 'granted') return 'granted';
        if (Notification.permission === 'denied')  return 'denied';

        const aceito = await mostrarBannerConvite();
        if (!aceito) return 'dismissed';

        const resultado = await Notification.requestPermission();
        console.log('🔔 Permissão de notificação:', resultado);
        return resultado;
    }

    /** Cria a PushSubscription usando a VAPID_PUBLIC_KEY configurada. */
    async function criarSubscription() {
        if (!swRegistration) return null;
        if (VAPID_PUBLIC_KEY === 'COLE_SUA_VAPID_PUBLIC_KEY_AQUI') {
            console.warn('⚠️ VAPID_PUBLIC_KEY não configurada — push desativado, só in-app ativo.');
            return null;
        }
        try {
            const sub = await swRegistration.pushManager.subscribe({
                userVisibleOnly:    true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
            console.log('✅ PushSubscription criada.');
            return sub;
        } catch (err) {
            console.error('❌ Falha ao criar PushSubscription:', err.message);
            return null;
        }
    }

    /**
     * Salva/atualiza a subscription no Supabase.
     * Usa upsert com onConflict:'client_id' para manter apenas 1
     * subscription ativa por cliente (o device mais recente vence).
     */
    async function salvarSubscription(subscription, clienteId) {
        if (!subscription || !clienteId) return;
        const keys = subscription.toJSON().keys || {};
        try {
            const { error } = await supabaseClient
                .from('push_subscriptions')
                .upsert({
                    client_id:  clienteId,
                    endpoint:   subscription.endpoint,
                    p256dh:     keys.p256dh,
                    auth:       keys.auth,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'client_id' });

            if (error) throw error;
            console.log('✅ Subscription salva no Supabase.');
        } catch (err) {
            console.error('❌ Falha ao salvar subscription:', err.message);
        }
    }

    // ─────────────────────────────────────────────────────────
    // PONTO DE ENTRADA PÚBLICO
    // ─────────────────────────────────────────────────────────

    /**
     * Inicializa ambos os canais de notificação.
     * Chamado em app.js logo após o login bem-sucedido do cliente.
     *
     * @param {string} clienteId - auth.uid() do cliente logado
     */
    async function inicializar(clienteId) {
        // Canal 1: lembrete in-app — funciona sempre, sem permissão
        await verificarLembreteInApp(clienteId);

        // Canal 2: Web Push — requer HTTPS + browser compatível
        if (!('PushManager' in window)) {
            console.log('ℹ️ Push não suportado neste browser/OS.');
            return;
        }

        const sw = await registrarSW();
        if (!sw) return;

        // Não re-solicita permissão se o usuário já negou
        if (Notification.permission === 'denied') return;

        // Aguarda 4s para o usuário se ambientar no app antes do banner
        await new Promise(r => setTimeout(r, 4000));

        const permissao = await solicitarPermissao();
        if (permissao !== 'granted') return;

        const sub = await criarSubscription();
        if (sub) await salvarSubscription(sub, clienteId);
    }

    return { inicializar, frases: FRASES_LEMBRETE };
})();

/* ════════════════════════════════════════════════════════════════
   PASSO 1 — SQL DE MIGRAÇÃO
   Execute no Supabase Dashboard → SQL Editor
   ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id  uuid        NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    endpoint   text        NOT NULL,
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (client_id)
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Cliente gerencia a própria subscription
CREATE POLICY "cliente_gerencia_propria_subscription"
    ON push_subscriptions FOR ALL
    USING     (client_id = auth.uid())
    WITH CHECK (client_id = auth.uid());

-- Service Role (Edge Function) lê todas para enviar lembretes
CREATE POLICY "service_role_le_subscriptions"
    ON push_subscriptions FOR SELECT
    USING (auth.role() = 'service_role');


   ════════════════════════════════════════════════════════════════
   PASSO 2 — GERAR CHAVES VAPID
   Execute no terminal (Node.js necessário)
   ════════════════════════════════════════════════════════════════

npx web-push generate-vapid-keys

Resultado:
  Public Key:  BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxA
  Private Key: yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

→ Cole a Public Key  em VAPID_PUBLIC_KEY no topo deste arquivo.
→ Cole a Private Key nas variáveis de ambiente da Edge Function (Passo 3).


   ════════════════════════════════════════════════════════════════
   PASSO 3 — EDGE FUNCTION (Deno / Supabase Functions)
   Arquivo: supabase/functions/enviar-lembretes/index.ts
   Deploy:  supabase functions deploy enviar-lembretes
   ════════════════════════════════════════════════════════════════

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webPush          from "npm:web-push";

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_EMAIL       = Deno.env.get("VAPID_EMAIL")!;   // ex: mailto:admin@mentorfin.com

webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const FRASES = [
    { title: "MentorFin 💰", body: "Comprou ou vendeu? Registre aqui e tenha seu relatório mensal!" },
    { title: "MentorFin 📊", body: "Não se esqueça de registrar suas receitas e despesas de hoje." },
    { title: "MentorFin 🎯", body: "Seu controle financeiro te espera! Atualize seus lançamentos." },
    { title: "MentorFin 💳", body: "Semana passando — seus gastos estão registrados?" },
    { title: "MentorFin 📋", body: "Um lançamento não registrado distorce todo o seu relatório. Confere lá!" },
    { title: "MentorFin 🏦", body: "Mês quase acabando! Seus lançamentos estão em dia?" },
    { title: "MentorFin 📈", body: "Receita ou despesa de hoje? Registre agora e mantenha o controle!" },
];

serve(async () => {
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: subs, error } = await supabase
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth, client_id");

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    const frase   = FRASES[Math.floor(Math.random() * FRASES.length)];
    const payload = JSON.stringify({ title: frase.title, body: frase.body, url: "/" });

    let enviados = 0, erros = 0;

    for (const sub of subs ?? []) {
        try {
            await webPush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                payload
            );
            enviados++;
        } catch (err: any) {
            erros++;
            // Endpoint expirado (410 Gone) — remove do banco automaticamente
            if (err.statusCode === 410) {
                await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
            }
        }
    }

    return new Response(
        JSON.stringify({ enviados, erros, total: (subs ?? []).length }),
        { headers: { "Content-Type": "application/json" } }
    );
});

-- Variáveis de ambiente (Supabase Dashboard → Functions → enviar-lembretes → Secrets):
-- VAPID_PUBLIC_KEY   = (a public key gerada no Passo 2)
-- VAPID_PRIVATE_KEY  = (a private key gerada no Passo 2)
-- VAPID_EMAIL        = mailto:seuemail@mentorfin.com


   ════════════════════════════════════════════════════════════════
   PASSO 4 — AGENDAMENTO (Cron Job)
   Supabase Dashboard → Database → Extensions → habilite pg_cron
   Depois no SQL Editor:
   ════════════════════════════════════════════════════════════════

-- Dispara toda segunda e quinta às 18h (BRT = 21h UTC)
SELECT cron.schedule(
    'mentorfin-lembretes-push',
    '0 21 * * 1,4',
    $$
    SELECT net.http_post(
        url     := 'https://SEU_PROJECT_REF.supabase.co/functions/v1/enviar-lembretes',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || 'SEU_ANON_KEY',
            'Content-Type',  'application/json'
        ),
        body    := '{}'::jsonb
    );
    $$
);

-- Para pausar: SELECT cron.unschedule('mentorfin-lembretes-push');
-- Para ver jobs: SELECT * FROM cron.job;

*/

console.log('✅ notifications.js carregado (in-app + Web Push)');
