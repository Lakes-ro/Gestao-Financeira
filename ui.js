/**
 * UI.JS — UTILITÁRIOS DE INTERFACE
 * ================================================
 * Padrão: script global (IIFE). Sem import/export.
 */

const UIModule = (() => {
    return {
        /**
         * Exibe a tela correta e revela o body (anti-flicker).
         * Todas as telas ficam com visibility:hidden até esta chamada.
         */
        showScreen(screenId) {
            document.querySelectorAll('.screen').forEach(s => {
                s.classList.remove('active');
            });

            const screen = document.getElementById(screenId);
            if (screen) {
                screen.classList.add('active');
            }

            // Revela o body agora que a tela correta está ativa
            document.body.classList.add('app-ready');
        },

        showSection(sectionId) {
            document.querySelectorAll('.view-section').forEach(s => {
                s.classList.remove('active');
            });

            const section = document.getElementById(sectionId);
            if (section) {
                section.classList.add('active');
            }
        },

        showMessage(message, type = 'info', duration = 3000) {
            const msgDiv = document.createElement('div');
            msgDiv.className = `message message--${type}`;
            msgDiv.textContent = message;
            msgDiv.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 15px 20px;
                border-radius: 8px;
                z-index: 10000;
                background: rgba(26,26,46,0.97);
                border: 1px solid rgba(100,150,255,0.3);
                color: #e0e0e0;
                font-family: inherit;
                font-size: 14px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                animation: slideIn 0.3s ease;
            `;

            if (type === 'error')   { msgDiv.style.borderColor = 'rgba(255,100,100,0.5)'; msgDiv.style.color = '#ff6b6b'; }
            if (type === 'success') { msgDiv.style.borderColor = 'rgba(100,255,122,0.5)'; msgDiv.style.color = '#64ff7a'; }

            document.body.appendChild(msgDiv);

            setTimeout(() => {
                msgDiv.style.opacity = '0';
                msgDiv.style.transform = 'translateX(20px)';
                msgDiv.style.transition = 'opacity 0.3s, transform 0.3s';
                setTimeout(() => msgDiv.remove(), 320);
            }, duration);
        },

        showError(message)   { this.showMessage(message || '❌ Erro', 'error'); },
        showSuccess(message) { this.showMessage(message || '✅ Sucesso', 'success'); },

        openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove('hidden');
        },

        closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.add('hidden');
        },

        setText(elementId, text) {
            const el = document.getElementById(elementId);
            if (el) el.textContent = text;
        },

        setHTML(elementId, html) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = html;
        },

        addClass(elementId, className) {
            const el = document.getElementById(elementId);
            if (el) el.classList.add(className);
        },

        removeClass(elementId, className) {
            const el = document.getElementById(elementId);
            if (el) el.classList.remove(className);
        },

        setFormValue(formId, fieldId, value) {
            const form  = document.getElementById(formId);
            const field = form?.querySelector(`[name="${fieldId}"]`);
            if (field) field.value = value;
        },

        getFormData(formId) {
            const form = document.getElementById(formId);
            if (!form) return null;
            return Object.fromEntries(new FormData(form));
        },

        clearForm(formId) {
            const form = document.getElementById(formId);
            if (form) form.reset();
        },

        showLoading(elementId) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = '<p class="empty-state">⏳ Carregando...</p>';
        },

        hideLoading(elementId) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = '';
        }
    };
})();

// Fallback: se o JS falhar e nunca chamar showScreen(),
// revela o body após 2s para não deixar a tela em branco.
setTimeout(() => document.body.classList.add('app-ready'), 2000);

console.log('✅ ui.js carregado');