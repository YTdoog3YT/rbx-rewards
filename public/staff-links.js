// =================== KLIKALNE NICKI (tylko właściciel i admini) ===================
// Gdy w przeglądarce jest ważne logowanie do panelu admina, nicki graczy (czat, ranking, na żywo, wypłaty, polecenia)
// prowadzą do /admin z wyszukanym graczem. Zwykli gracze nie mają tej opcji ani zmiany kursora.
(function () {
    let on = false;
    function enable() {
        if (on) return; on = true;
        document.body.classList.add('is-staff');
        const ci = document.getElementById('chatInput'); if (ci) ci.removeAttribute('maxlength'); // CEO/ADMIN: bez limitu długości
        const st = document.createElement('style');
        st.textContent = 'body.is-staff [data-player]{cursor:pointer}body.is-staff [data-player]:hover{text-decoration:underline;text-underline-offset:3px}';
        document.head.appendChild(st);
        document.addEventListener('click', e => {
            const el = e.target && e.target.closest ? e.target.closest('[data-player]') : null;
            if (!el) return;
            const name = el.getAttribute('data-player');
            if (!name) return;
            e.preventDefault(); e.stopPropagation();
            location.href = '/admin?user=' + encodeURIComponent(name);
        }, true);
    }
    async function check() {
        let token = null;
        try { token = localStorage.getItem('rbx_admin_token'); } catch (e) {}
        if (!token) return;
        try {
            const res = await fetch('/api/admin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
            const data = await res.json();
            if (data && data.success) enable();
        } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
})();
