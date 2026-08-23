/**
 * SERVICE-WORKER.JS — MentorFin Push Notifications
 * ================================================
 * Roda em segundo plano, independente de o app estar aberto.
 * Registrado por notifications.js via navigator.serviceWorker.register().
 *
 * Eventos tratados:
 *   install   — ativa imediatamente (sem esperar abas fecharem)
 *   activate  — assume controle de todas as abas abertas
 *   push      — exibe a notificação recebida da Edge Function
 *   notificationclick — abre/foca o app quando o usuário toca na notificação
 */

const APP_ICON  = '/logo.png';
const APP_BADGE = '/logo.png';

// ── Ciclo de vida ──────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// ── Recebe push da Edge Function e exibe notificação ──────────
self.addEventListener('push', event => {
    let payload = {
        title: 'MentorFin',
        body:  'Você tem novidades no MentorFin!',
        url:   '/',
        tag:   'mentorfin-lembrete'
    };

    try {
        if (event.data) Object.assign(payload, event.data.json());
    } catch (_) {
        payload.body = event.data?.text() || payload.body;
    }

    const options = {
        body:               payload.body,
        icon:               APP_ICON,
        badge:              APP_BADGE,
        tag:                payload.tag,
        renotify:           true,
        requireInteraction: false,
        vibrate:            [200, 100, 200],
        data:               { url: payload.url }
    };

    event.waitUntil(
        self.registration.showNotification(payload.title, options)
    );
});

// ── Toque na notificação → abre ou foca o app ─────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.notification.data?.url || '/';

    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                // Se o app já está aberto em alguma aba, foca nela
                for (const client of clientList) {
                    if ('focus' in client) return client.focus();
                }
                // Senão, abre uma nova janela
                if (self.clients.openWindow) return self.clients.openWindow(url);
            })
    );
});
