// =================== EKRAN BLOKADY KONTA ===================
// Zablokowany gracz widzi tylko: na ile jest blokada, swoje saldo R$ i przycisk "Utwórz ticket".
(function () {
    const TXT = {
        en: { title: 'Your account is blocked', forever: 'Blocked permanently', until: 'Blocked until {d}', left: 'Time left: {t}', balance: 'Your balance', info: 'If you think this is a mistake, create a ticket. We will reply on our Discord.', ph: 'Describe your situation...', create: 'Create ticket', link: 'Connect Discord', linkInfo: 'To create a ticket, connect your Discord account first (you must be on our Discord server).', open: 'You have an open ticket:', openLink: 'Open on Discord', wait: 'Wait for the administration reply on Discord.', logout: 'Log out', sent: 'Ticket created! Check our Discord.', short: 'Describe it in more detail (min. 10 characters).', err: 'Something went wrong. Try again.' },
        pl: { title: 'Twoje konto jest zablokowane', forever: 'Blokada na zawsze', until: 'Blokada do {d}', left: 'Pozostało: {t}', balance: 'Twoje saldo', info: 'Jeśli uważasz, że to pomyłka, utwórz ticket. Odpowiemy na naszym Discordzie.', ph: 'Opisz swoją sytuację...', create: 'Utwórz ticket', link: 'Połącz z Discordem', linkInfo: 'Żeby utworzyć ticket, najpierw połącz konto z Discordem (musisz być na naszym serwerze).', open: 'Masz otwarty ticket:', openLink: 'Otwórz na Discordzie', wait: 'Poczekaj na odpowiedź administracji na Discordzie.', logout: 'Wyloguj', sent: 'Ticket utworzony! Zajrzyj na Discorda.', short: 'Opisz to dokładniej (min. 10 znaków).', err: 'Coś poszło nie tak. Spróbuj ponownie.' },
        de: { title: 'Dein Konto ist gesperrt', forever: 'Dauerhaft gesperrt', until: 'Gesperrt bis {d}', left: 'Verbleibend: {t}', balance: 'Dein Kontostand', info: 'Wenn du denkst, dass das ein Fehler ist, erstelle ein Ticket. Wir antworten auf unserem Discord.', ph: 'Beschreibe deine Situation...', create: 'Ticket erstellen', link: 'Mit Discord verbinden', linkInfo: 'Um ein Ticket zu erstellen, verbinde zuerst dein Discord-Konto (du musst auf unserem Server sein).', open: 'Du hast ein offenes Ticket:', openLink: 'Auf Discord öffnen', wait: 'Warte auf die Antwort der Administration auf Discord.', logout: 'Abmelden', sent: 'Ticket erstellt! Schau auf Discord.', short: 'Beschreibe es genauer (mind. 10 Zeichen).', err: 'Etwas ist schiefgelaufen. Versuche es erneut.' },
        ru: { title: 'Ваш аккаунт заблокирован', forever: 'Блокировка навсегда', until: 'Блокировка до {d}', left: 'Осталось: {t}', balance: 'Ваш баланс', info: 'Если вы считаете, что это ошибка, создайте тикет. Мы ответим в нашем Discord.', ph: 'Опишите ситуацию...', create: 'Создать тикет', link: 'Подключить Discord', linkInfo: 'Чтобы создать тикет, сначала подключите Discord (нужно быть на нашем сервере).', open: 'У вас открыт тикет:', openLink: 'Открыть в Discord', wait: 'Дождитесь ответа администрации в Discord.', logout: 'Выйти', sent: 'Тикет создан! Загляните в Discord.', short: 'Опишите подробнее (мин. 10 символов).', err: 'Что-то пошло не так. Попробуйте ещё раз.' }
    };
    const UNITS = { en: ['d', 'h', 'min', 's'], pl: ['d', 'godz.', 'min', 's'], de: ['T', 'Std.', 'Min.', 's'], ru: ['д', 'ч', 'мин', 'с'] };
    const LOCALES = { en: 'en-GB', pl: 'pl-PL', de: 'de-DE', ru: 'ru-RU' };
    const lang = () => { let l = 'en'; try { l = localStorage.getItem('rbx_lang') || 'en'; } catch (e) {} return TXT[l] ? l : 'en'; };
    const t = k => TXT[lang()][k] || TXT.en[k];
    const username = () => { try { return localStorage.getItem('rbx_username') || ''; } catch (e) { return ''; } };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    let state = null, overlay = null, timer = null;

    function leftText(ms) {
        const u = UNITS[lang()];
        const s = Math.max(0, Math.floor(ms / 1000));
        const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
        const parts = [];
        if (d) parts.push(d + ' ' + u[0]);
        if (d || h) parts.push(h + ' ' + u[1]);
        if (d || h || m) parts.push(m + ' ' + u[2]);
        parts.push(sec + ' ' + u[3]);
        return parts.join(' ');
    }

    function render() {
        if (!state || !state.blocked) return;
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'blk-overlay'; overlay.id = 'blkOverlay';
            overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
            document.body.appendChild(overlay);
            document.body.classList.add('blk-locked');
        }
        const untilTxt = state.until ? t('until').replace('{d}', new Date(state.until).toLocaleString(LOCALES[lang()], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })) : t('forever');
        let ticket;
        if (state.openTicket) {
            ticket = `<div class="blk-ticket">${esc(t('open'))} <b>${esc(state.openTicket.name)}</b><br><span style="color:#8a90a0;">${esc(t('wait'))}</span></div>
                <a class="blk-btn discord" href="${esc(state.openTicket.url)}" target="_blank" rel="noopener">${esc(t('openLink'))}</a>`;
        } else if (!state.linked) {
            ticket = `<p class="blk-info">${esc(t('linkInfo'))}</p><button class="blk-btn discord" id="blkLink">${esc(t('link'))}</button>`;
        } else {
            ticket = `<p class="blk-info">${esc(t('info'))}</p><textarea id="blkMsg" maxlength="1500" placeholder="${esc(t('ph'))}"></textarea><button class="blk-btn primary" id="blkCreate">${esc(t('create'))}</button>`;
        }
        const keep = overlay.querySelector('#blkMsg');
        const draft = keep ? keep.value : '';
        overlay.innerHTML = `<div class="blk-card">
            <div class="blk-icon">🔒</div>
            <div class="blk-title">${esc(t('title'))}</div>
            <div class="blk-until">${esc(untilTxt)}</div>
            <div class="blk-left" id="blkLeft">${state.until ? esc(t('left').replace('{t}', leftText(new Date(state.until) - Date.now()))) : '&nbsp;'}</div>
            <div class="blk-balance"><span>${esc(t('balance'))}</span><b>${(parseFloat(state.points) || 0).toFixed(2)} R$</b></div>
            ${ticket}
            <div class="blk-msg" id="blkStatus"></div>
            <button class="blk-btn ghost" id="blkLogout">${esc(t('logout'))}</button>
        </div>`;
        const ta = overlay.querySelector('#blkMsg'); if (ta && draft) ta.value = draft;
        const c = overlay.querySelector('#blkCreate'); if (c) c.onclick = createTicket;
        const l = overlay.querySelector('#blkLink'); if (l) l.onclick = linkDiscord;
        overlay.querySelector('#blkLogout').onclick = () => { if (typeof window.logoutUser === 'function') window.logoutUser(); setTimeout(() => location.reload(), 300); };
    }

    function setStatus(text, ok) { const el = document.getElementById('blkStatus'); if (el) { el.textContent = text || ''; el.className = 'blk-msg ' + (ok ? 'ok' : 'err'); } }

    async function createTicket() {
        const ta = document.getElementById('blkMsg'), btn = document.getElementById('blkCreate');
        const message = ta ? ta.value.trim() : '';
        if (message.length < 10) return setStatus(t('short'));
        btn.disabled = true;
        try {
            const res = await fetch('/api/support-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
            const data = await res.json();
            if (data.success) { setStatus(t('sent'), true); await load(); setStatus(t('sent'), true); }
            else { setStatus(data.error || t('err')); btn.disabled = false; }
        } catch (e) { setStatus(t('err')); btn.disabled = false; }
    }

    async function linkDiscord() {
        const btn = document.getElementById('blkLink'); if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/discord/link-start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const data = await res.json();
            if (data.url) { location.href = data.url; return; }
            setStatus(data.error || t('err'));
        } catch (e) { setStatus(t('err')); }
        if (btn) btn.disabled = false;
    }

    function close() {
        if (overlay) { overlay.remove(); overlay = null; }
        document.body.classList.remove('blk-locked');
    }

    async function load() {
        const u = username();
        if (!u) { const was = !!overlay; state = null; close(); return was; }
        try {
            const res = await fetch('/api/block-status/' + encodeURIComponent(u));
            if (!res.ok) return;
            const data = await res.json();
            const wasBlocked = !!(state && state.blocked);
            state = data;
            if (data.blocked) render();
            else if (wasBlocked) { close(); location.reload(); } // blokada minęła albo odblokowano
        } catch (e) {}
    }

    function tick() {
        if (!state || !state.blocked || !state.until) return;
        const ms = new Date(state.until) - Date.now();
        const el = document.getElementById('blkLeft');
        if (el) el.textContent = t('left').replace('{t}', leftText(ms));
        if (ms <= 0) { state.until = null; state.blocked = false; close(); location.reload(); }
    }

    function start() {
        load();
        timer = setInterval(tick, 1000);
        setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
        let last = username();
        setInterval(() => { const u = username(); if (u !== last) { last = u; load(); } }, 2000);
        const sel = document.getElementById('langSelect');
        if (sel) sel.addEventListener('change', () => setTimeout(render, 0));
        // każda akcja odrzucona przez serwer jako BLOCKED -> od razu pokaż ekran blokady
        const _fetch = window.fetch;
        window.fetch = function () {
            return _fetch.apply(this, arguments).then(res => {
                if (res.status === 403) res.clone().json().then(d => { if (d && d.code === 'BLOCKED' && !overlay) load(); }).catch(() => {});
                return res;
            });
        };
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
