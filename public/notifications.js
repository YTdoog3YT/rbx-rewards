// =================== POWIADOMIENIA NA STRONIE (dzwonek) ===================
// Pobiera powiadomienia zalogowanego gracza, pokazuje licznik nieprzeczytanych i listę z datą i godziną.
// Tekst jest w języku wybranym na stronie.
(function () {
    const TXT = {
        en: { title: 'Notifications', empty: 'No notifications yet', bell: 'Notifications',
            ticket_reply: 'You got a new message in ticket #{n}', announcement: 'A new announcement has been posted',
            payout_done: 'Payout completed: {r} R$ = ${usd} USD', payout_rejected: 'Payout rejected: {r} R$ = ${usd} USD (R$ returned to your balance)',
            bundle_done: 'Bundle delivered: {t}', bundle_rejected: 'Bundle rejected: {t} (R$ returned to your balance)' },
        pl: { title: 'Powiadomienia', empty: 'Brak powiadomień', bell: 'Powiadomienia',
            ticket_reply: 'Dostałeś/aś nową wiadomość w tickecie #{n}', announcement: 'Zostało dodane nowe ogłoszenie',
            payout_done: 'Zrealizowano wypłatę: {r} R$ = {usd} USD', payout_rejected: 'Odrzucono wypłatę: {r} R$ = {usd} USD (R$ wróciły na konto)',
            bundle_done: 'Zrealizowano pakiet {t}', bundle_rejected: 'Odrzucono pakiet {t} (R$ wróciły na konto)' },
        de: { title: 'Benachrichtigungen', empty: 'Noch keine Benachrichtigungen', bell: 'Benachrichtigungen',
            ticket_reply: 'Du hast eine neue Nachricht in Ticket #{n}', announcement: 'Eine neue Ankündigung wurde veröffentlicht',
            payout_done: 'Auszahlung abgeschlossen: {r} R$ = {usd} USD', payout_rejected: 'Auszahlung abgelehnt: {r} R$ = {usd} USD (R$ wurden zurückgebucht)',
            bundle_done: 'Paket geliefert: {t}', bundle_rejected: 'Paket abgelehnt: {t} (R$ wurden zurückgebucht)' },
        ru: { title: 'Уведомления', empty: 'Уведомлений пока нет', bell: 'Уведомления',
            ticket_reply: 'Новое сообщение в тикете #{n}', announcement: 'Опубликовано новое объявление',
            payout_done: 'Выплата выполнена: {r} R$ = {usd} USD', payout_rejected: 'Выплата отклонена: {r} R$ = {usd} USD (R$ возвращены на баланс)',
            bundle_done: 'Пакет выдан: {t}', bundle_rejected: 'Пакет отклонён: {t} (R$ возвращены на баланс)' }
    };
    const ICON = { ticket_reply: '💬', announcement: '📢', payout_done: '💸', payout_rejected: '❌', bundle_done: '📦', bundle_rejected: '❌' };
    const LOCALES = { en: 'en-GB', pl: 'pl-PL', de: 'de-DE', ru: 'ru-RU' };
    const CAT = { robux: 'Robux', wt: 'War Thunder', ss: 'Star Stable' };
    const POLL_MS = 60 * 1000;

    const lang = () => { let l = 'en'; try { l = localStorage.getItem('rbx_lang') || 'en'; } catch (e) {} return TXT[l] ? l : 'en'; };
    const t = k => TXT[lang()][k] || TXT.en[k] || k;
    const username = () => { try { return localStorage.getItem('rbx_username') || ''; } catch (e) { return ''; } };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = n => (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
    const when = d => { try { return new Date(d).toLocaleString(LOCALES[lang()], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };

    function bundleName(d) {
        let title = String(d.title || '');
        if (d.category === 'wt') title = title.replace(/\bGE\b/, 'Golden Eagles');
        if (/^custom/i.test(title) && CAT[d.category]) title += ' (' + CAT[d.category] + ')';
        return title;
    }
    function textOf(n) {
        const d = n.data || {};
        return t(n.type)
            .replace('{n}', String(parseInt(d.number, 10) || 0).padStart(4, '0'))
            .replace('{r}', money(d.points))
            .replace('{usd}', money(d.usd))
            .replace('{t}', bundleName(d));
    }

    let state = { items: [], unread: 0, seenAt: null, openSeenAt: null };
    let wrap, badge, panel, list, head, bell;

    function build() {
        const host = document.querySelector('header .user-info');
        if (!host || document.getElementById('ntfWrap')) return;
        wrap = document.createElement('div');
        wrap.className = 'ntf-wrap'; wrap.id = 'ntfWrap';
        wrap.innerHTML =
            '<button type="button" class="ntf-bell" id="ntfBell" aria-haspopup="true" aria-expanded="false">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
            '<span class="ntf-badge" id="ntfBadge"></span></button>' +
            '<div class="ntf-panel" id="ntfPanel" role="dialog"><div class="ntf-head" id="ntfHead"></div><ul class="ntf-list" id="ntfList"></ul></div>';
        host.insertBefore(wrap, host.firstChild);
        bell = wrap.querySelector('#ntfBell'); badge = wrap.querySelector('#ntfBadge');
        panel = wrap.querySelector('#ntfPanel'); list = wrap.querySelector('#ntfList'); head = wrap.querySelector('#ntfHead');
        bell.addEventListener('click', e => { e.stopPropagation(); panel.classList.contains('is-open') ? close() : open(); });
        panel.addEventListener('click', e => e.stopPropagation());
        document.addEventListener('click', close);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
        const sel = document.getElementById('langSelect');
        if (sel) sel.addEventListener('change', () => setTimeout(render, 0));
    }

    function renderBadge() {
        if (!badge) return;
        badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
        badge.classList.toggle('is-on', state.unread > 0);
        bell.setAttribute('aria-label', t('bell') + (state.unread ? ' (' + state.unread + ')' : ''));
        bell.title = t('bell');
    }

    function render() {
        if (!list) return;
        head.textContent = t('title');
        renderBadge();
        if (!state.items.length) { list.innerHTML = '<li class="ntf-empty">' + esc(t('empty')) + '</li>'; return; }
        const seen = state.openSeenAt ? new Date(state.openSeenAt).getTime() : 0;
        list.innerHTML = state.items.map(n => {
            const isNew = new Date(n.createdAt).getTime() > seen;
            return '<li class="ntf-item' + (isNew ? ' is-new' : '') + '">' +
                '<span class="ntf-ico">' + (ICON[n.type] || '🔔') + '</span>' +
                '<div class="ntf-body"><div class="ntf-text">' + esc(textOf(n)) + (isNew ? '<span class="ntf-dot"></span>' : '') + '</div>' +
                '<div class="ntf-time">' + esc(when(n.createdAt)) + '</div></div></li>';
        }).join('');
    }

    async function load() {
        const u = username();
        if (!u) { if (wrap) { wrap.classList.remove('is-on'); close(); } return; }
        build();
        if (!wrap) return;
        try {
            const res = await fetch('/api/notifications/' + encodeURIComponent(u));
            if (res.status === 401) { wrap.classList.remove('is-on'); return; }
            const data = await res.json();
            state.items = Array.isArray(data.items) ? data.items : [];
            state.unread = parseInt(data.unread, 10) || 0;
            state.seenAt = data.seenAt || null;
            if (!panel.classList.contains('is-open')) state.openSeenAt = state.seenAt;
            wrap.classList.add('is-on');
            render();
        } catch (e) {}
    }

    async function open() {
        state.openSeenAt = state.seenAt; // nowe podświetlone, dopóki panel jest otwarty
        render();
        panel.classList.add('is-open'); bell.setAttribute('aria-expanded', 'true');
        if (state.unread > 0) {
            state.unread = 0; renderBadge();
            try { await fetch('/api/notifications/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); state.seenAt = new Date().toISOString(); } catch (e) {}
        }
    }
    function close() {
        if (!panel || !panel.classList.contains('is-open')) return;
        panel.classList.remove('is-open'); bell.setAttribute('aria-expanded', 'false');
        state.openSeenAt = state.seenAt; render();
    }

    function start() {
        load();
        setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
        // po zalogowaniu / wylogowaniu
        let last = username();
        setInterval(() => { const u = username(); if (u !== last) { last = u; state = { items: [], unread: 0, seenAt: null, openSeenAt: null }; load(); } }, 2000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
