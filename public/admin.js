// =================== PANEL ADMINA (strona /admin) ===================
let ADMIN = { role: null, name: '', permissions: [], ready: false };

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// przyciski z data-perm są aktywne tylko, gdy zalogowany ma to uprawnienie
function applyPerms(root) {
    if (!ADMIN.ready) return;
    (root || document).querySelectorAll('[data-perm]').forEach(el => {
        const ok = ADMIN.permissions.includes(el.getAttribute('data-perm'));
        if (!ok) { el.disabled = true; el.classList.add('adm-locked'); el.title = 'Brak uprawnień – tylko podgląd'; }
    });
}
new MutationObserver(() => applyPerms()).observe(document.documentElement, { childList: true, subtree: true });

function showLogin(errorText) {
    document.getElementById('admPanel').style.display = 'none';
    document.getElementById('admWho').style.display = 'none';
    document.getElementById('admViewOnly').style.display = 'none';
    document.getElementById('admLogin').style.display = 'block';
    const e = document.getElementById('admError');
    if (errorText) { e.innerText = errorText; e.style.display = 'block'; } else e.style.display = 'none';
}

function adminRefreshAll() {
    loadAdminStats();
    loadAdminTop10Payouts();
    loadAdminTop5Codes();
    loadAdminBundleUsers();
}

async function adminLogout() {
    const token = localStorage.getItem('rbx_admin_token');
    try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); } catch (e) {}
    localStorage.removeItem('rbx_admin_token');
    showLogin('');
}

document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token'); const err = params.get('error');
    if (urlToken) localStorage.setItem('rbx_admin_token', urlToken);
    if (urlToken || err) window.history.replaceState({}, document.title, window.location.pathname);
    const errors = { Unauthorized: 'To konto Discord nie ma dostępu do panelu (potrzebna rola administracji).', AuthFailed: 'Logowanie przez Discord nie powiodło się. Spróbuj ponownie.', NoCode: 'Logowanie przez Discord zostało przerwane.', ServerError: 'Błąd serwera przy logowaniu. Spróbuj za chwilę.' };

    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return showLogin(err ? (errors[err] || 'Błąd logowania.') : '');
    try {
        const res = await fetch('/api/admin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const data = await res.json();
        if (!data.success) { localStorage.removeItem('rbx_admin_token'); return showLogin('Sesja panelu wygasła. Zaloguj się ponownie.'); }
        ADMIN = { role: data.role, name: data.name || '', permissions: data.permissions || [], ready: true };
    } catch (e) { return showLogin('Brak połączenia z serwerem.'); }

    document.getElementById('admLogin').style.display = 'none';
    document.getElementById('admWho').style.display = 'flex';
    document.getElementById('admWhoName').innerText = ADMIN.name;
    document.getElementById('admWhoRole').innerText = ADMIN.role === 'owner' ? 'Właściciel' : 'Administrator';
    document.getElementById('admWhoRole').classList.add(ADMIN.role === 'owner' ? 'is-owner' : 'is-admin');
    document.getElementById('admViewOnly').style.display = ADMIN.permissions.length < 4 ? 'block' : 'none';
    document.getElementById('admPanel').style.display = 'block';
    applyPerms();
    adminRefreshAll();
    setInterval(loadAdminStats, 30000);
});

// --- ADMIN: weryfikacja graczy ---
async function loadAdminBundleUsers() {
const token = localStorage.getItem('rbx_admin_token'); if (!token) return;
const tbody = document.getElementById('adminBundleUsersBody'); if (!tbody) return;
try {
    const res = await fetch('/api/admin/bundle-users', { headers: { 'Authorization': token } });
    const users = await res.json();
    if (!Array.isArray(users) || users.length === 0) { tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #888;">Brak graczy z pakietami.</td></tr>`; return; }
    tbody.innerHTML = users.map(u => {
        const ids = [u.robloxName ? 'RB: ' + u.robloxName : '', u.gaijinId ? 'WT: ' + u.gaijinId : ''].filter(Boolean).join(' • ');
        const status = u.verified ? '<span style="color: #00e676; font-weight: bold;">✔ Verified</span>' : '<span style="color: #a0a0a0;">✖ Not verified</span>';
        const btn = u.verified
            ? `<button style="background: #ff3333; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;" data-user="${escHtml(u.username)}" data-perm="verify" onclick="adminSetVerified(this.dataset.user, false, this)">Cofnij</button>`
            : `<button style="background: #00e676; color: #000; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;" data-user="${escHtml(u.username)}" data-perm="verify" onclick="adminSetVerified(this.dataset.user, true, this)">Zweryfikuj</button>`;
        return `<tr style="border-bottom: 1px solid #2a2e39;"><td style="font-weight: bold; color: #fff;">👤 ${escHtml(u.username)}</td><td style="color: #a0a0b0;">${escHtml(ids)}</td><td style="color: #fff;">${escHtml(u.discordName || '')}</td><td>${status}</td><td>${btn}</td></tr>`;
    }).join('');
} catch (e) { tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">Błąd ładowania</td></tr>`; }
}

async function adminSetVerified(username, verified, btn) {
const token = localStorage.getItem('rbx_admin_token'); if (!token) return;
if (btn) btn.disabled = true;
try {
    const res = await fetch('/api/admin/set-verified', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify({ username, verified }) });
    const data = await res.json();
    if (data.error) { alert('Błąd: ' + data.error); if (btn) btn.disabled = false; return; }
    loadAdminBundleUsers();
} catch (e) { alert('Błąd połączenia.'); if (btn) btn.disabled = false; }
}


// --- SKRYPTY PANELU ADMINA (Z PODWÓJNYM PRZELICZNIKIEM) ---
async function loadAdminStats() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    try {
        const res = await fetch('/api/admin/stats', { headers: { 'Authorization': token } });
        const data = await res.json();
        if (!data.error) {
            const dailyR = data.dailyRobux || 0;
            document.getElementById('adminStatOnline').innerText = data.online || 0;
            document.getElementById('adminStatDaily').innerText = dailyR.toFixed(2);
            
            // przychód = ankiety/offerwalle (15 R$ = 1 USD), koszt = wszystkie rozdane R$ (1 R$ = 0.025 USD)
            const revenueUsd = (data.revenueRobux || 0) / 15;
            const costUsd = (data.costRobux || 0) * 0.025;
            const bonusUsd = (data.ownerBonusRobux || 0) * 0.025;
            const profitUsd = revenueUsd - costUsd;

            const revEl = document.getElementById('adminStatDailyUsdRevenue');
            if(revEl) revEl.innerText = '💰 Przychód: $' + revenueUsd.toFixed(2) + ' USD';
            
            const costEl = document.getElementById('adminStatDailyUsdCost');
            if(costEl) costEl.innerText = '💸 Wypłaty: $' + costUsd.toFixed(2) + ' USD';

            const bonusEl = document.getElementById('adminStatDailyUsdOwnerBonus');
            if(bonusEl) bonusEl.innerText = '⭐ w tym bonus od właściciela: $' + bonusUsd.toFixed(2) + ' USD';

            const bundlesEl = document.getElementById('adminStatDailyBundles');
            if(bundlesEl) bundlesEl.innerText = '📦 Pakiety wydane dziś: ' + (data.bundlesDoneCount || 0) + ' szt. · ' + (data.bundlesDoneRobux || 0).toFixed(2) + ' R$ ($' + ((data.bundlesDoneRobux || 0) * 0.025).toFixed(2) + ' USD)';

            const profitEl = document.getElementById('adminStatDailyUsdProfit');
            if(profitEl) profitEl.innerText = '👑 Czysty Zysk: $' + profitUsd.toFixed(2) + ' USD';
            
            document.getElementById('adminStatPending').innerText = (data.pendingRobux || 0).toFixed(2);
        }
    } catch (e) {}
}

async function showAdminOnlineUsers() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    const box = document.getElementById('adminOnlineList');
    const content = document.getElementById('adminOnlineListContent');
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    
    box.style.display = 'block';
    content.innerHTML = "Ładowanie...";
    try {
        const res = await fetch('/api/admin/online', { headers: { 'Authorization': token } });
        const users = await res.json();
        if (users.length === 0) content.innerHTML = "Nikt nie jest teraz zalogowany.";
        else content.innerHTML = users.map(u => `<div>🟢 ${escHtml(u)}</div>`).join('');
    } catch (e) { content.innerHTML = "Błąd pobierania listy."; }
}

async function showAdminPendingPayouts() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    const box = document.getElementById('adminPendingList');
    const tbody = document.getElementById('adminPendingListContent');
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    
    box.style.display = 'block';
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">Ładowanie...</td></tr>`;
    try {
        const res = await fetch('/api/admin/pending-payouts', { headers: { 'Authorization': token } });
        const payouts = await res.json();
        if (payouts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#00e676;">Brak oczekujących wypłat! 🎉</td></tr>`; return;
        }
        let html = "";
        payouts.forEach(p => {
            const amount = (parseFloat(p.pointsWithdrawn) || 0).toFixed(2);
            html += `
            <tr style="border-bottom: 1px solid #2a2e39;">
                <td style="font-weight: bold; color: #fff;">👤 ${escHtml(p.username)}</td>
                <td style="color: #a0a0b0;">${p.payoutMethod || 'Revolut'}: ${escHtml(p.payoutAddress || p.paypalEmail)}</td>
                <td style="color: #ffb703; font-weight: bold;">${amount} R$</td>
                <td>
                    <button style="background: #00e676; color: #000; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer; margin-right: 5px;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'complete', this)">Wysłane</button>
                    <button style="background: #ff3333; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'reject', this)">Odrzuć</button>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red;">Błąd ładowania</td></tr>`; }
}

async function loadAdminTop10Payouts() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    const tbody = document.getElementById('adminTop10PayoutsBody');
    try {
        const res = await fetch('/api/admin/pending-payouts', { headers: { 'Authorization': token } });
        const payouts = await res.json();
        
        if (payouts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#00e676;">Brak oczekujących wypłat! 🎉</td></tr>`; return;
        }
        
        const top10 = payouts.slice(0, 10);
        let html = "";
        top10.forEach(p => {
            const amount = (parseFloat(p.pointsWithdrawn) || 0).toFixed(2);
            const date = new Date(p.createdAt); 
            const timeString = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            html += `
            <tr style="border-bottom: 1px solid #2a2e39;">
                <td style="font-weight: bold; color: #fff;">👤 ${escHtml(p.username)}</td>
                <td style="color: #a0a0b0;">${p.payoutMethod || 'Revolut'}: ${escHtml(p.payoutAddress || p.paypalEmail)}</td>
                <td style="color: #ffb703; font-weight: bold;">${amount} R$</td>
                <td style="color: #888; font-size: 0.85rem;">${timeString}</td>
                <td>
                    <button style="background: #00e676; color: #000; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer; margin-right: 5px;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'complete', this)">Wysłane</button>
                    <button style="background: #ff3333; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; font-weight: bold; cursor: pointer;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'reject', this)">Odrzuć</button>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) { tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:red;">Błąd ładowania</td></tr>`; }
}

async function resolvePayout(payoutId, action, btnElement) {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    if (action === 'reject' && !confirm("Na pewno odrzucić tę wypłatę? R$ wrócą na konto gracza.")) return;
    btnElement.disabled = true; btnElement.innerText = "...";
    try {
        const res = await fetch('/api/admin/resolve-payout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify({ payoutId, action }) });
        const data = await res.json();
        if (data.error) {
            alert('Błąd: ' + data.error); btnElement.disabled = false;
        } else {
            loadAdminStats();
            loadAdminTop10Payouts();
            if (document.getElementById('adminPendingList').style.display === 'block') {
                document.getElementById('adminPendingList').style.display = 'none';
                showAdminPendingPayouts();
            }
            const selectedUser = document.getElementById('adminSearchUser').value.trim();
            if (selectedUser) fetchUserDetails(selectedUser);
        }
    } catch (e) { alert("Błąd połączenia."); btnElement.disabled = false; }
}

async function searchAdminUsers() {
    const q = document.getElementById('adminSearchUser').value.trim();
    const dropdown = document.getElementById('adminUserDropdown');
    if (q.length < 1) { 
        dropdown.style.display = 'none'; 
        document.getElementById('adminSelectedUserDetails').style.display = 'none';
        return; 
    }
    const token = localStorage.getItem('rbx_admin_token');
    try {
        const res = await fetch(`/api/admin/users/search?q=${encodeURIComponent(q)}`, { headers: { 'Authorization': token }});
        const users = await res.json();
        dropdown.innerHTML = '';
        if (users.length > 0) {
            users.forEach(u => {
                const li = document.createElement('li');
                li.style.padding = '10px 15px';
                li.style.cursor = 'pointer';
                li.style.borderBottom = '1px solid #333';
                li.style.color = '#fff';
                li.innerText = u;
                li.onmouseover = () => li.style.background = '#252a34';
                li.onmouseout = () => li.style.background = 'transparent';
                li.onclick = () => {
                    document.getElementById('adminSearchUser').value = u;
                    dropdown.style.display = 'none';
                    fetchUserDetails(u);
                };
                dropdown.appendChild(li);
            });
            dropdown.style.display = 'block';

            const exactMatch = users.find(u => u.toLowerCase() === q.toLowerCase());
            if (exactMatch) fetchUserDetails(exactMatch);
        } else {
            dropdown.style.display = 'none';
            document.getElementById('adminSelectedUserDetails').style.display = 'none';
        }
    } catch (e) {}
}

async function fetchUserDetails(username) {
    if (!username) { document.getElementById('adminSelectedUserDetails').style.display = 'none'; return; }
    const token = localStorage.getItem('rbx_admin_token');
    try {
        const res = await fetch(`/api/admin/user-details/${encodeURIComponent(username.trim())}`, { headers: { 'Authorization': token }});
        const data = await res.json();
        if (data.error) {
            document.getElementById('adminSelectedUserDetails').style.display = 'none';
        } else {
            document.getElementById('adminSelectedUsername').innerText = data.username;
            document.getElementById('adminSelectedPoints').innerText = (data.points || 0).toFixed(2) + ' R$';
            document.getElementById('adminSelectedPending').innerText = (data.pendingSum || 0).toFixed(2) + ' R$ (Kliknij, aby pokazać wnioski)';
            
            const tbody = document.getElementById('adminSelectedUserPayoutsBody');
            if (!data.pendingRequests || data.pendingRequests.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#00e676;">Brak oczekujących wypłat tego gracza.</td></tr>';
            } else {
                tbody.innerHTML = data.pendingRequests.map(p => {
                    const d = new Date(p.createdAt);
                    const dStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    return `
                    <tr style="border-bottom: 1px solid #2a2e39;">
                        <td style="color: #a0a0b0;">${p.payoutMethod || 'Revolut'}: ${escHtml(p.payoutAddress || p.paypalEmail)}</td>
                        <td style="color: #ffb703; font-weight: bold;">${(parseFloat(p.pointsWithdrawn) || 0).toFixed(2)} R$</td>
                        <td style="color: #888; font-size: 0.85rem;">${dStr}</td>
                        <td>
                            <button style="background: #00e676; color: #000; border: none; padding: 5px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.8rem; margin-right: 5px;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'complete', this)">Wysłane</button>
                            <button style="background: #ff3333; color: #fff; border: none; padding: 5px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.8rem;" data-perm="payouts" onclick="resolvePayout('${p._id}', 'reject', this)">Odrzuć</button>
                        </td>
                    </tr>`;
                }).join('');
            }
            document.getElementById('adminSelectedUserDetails').style.display = 'block';
        }
    } catch(e) {}
}

function toggleSelectedUserPayouts() {
    const div = document.getElementById('adminSelectedUserPayouts');
    div.style.display = div.style.display === 'none' ? 'block' : 'none';
}

async function adminManageBalance(action) {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return alert('Brak autoryzacji administratora!');
    
    const username = document.getElementById('adminSearchUser').value.trim();
    const amount = document.getElementById('adminBalanceAmount').value;
    
    if (!username || !amount || amount <= 0) return alert('Wpisz prawidłową nazwę gracza i kwotę!');
    if (!confirm(`Na pewno chcesz ${action === 'add' ? 'DODAĆ' : 'ODJĄĆ'} ${amount} R$ z konta gracza ${username}?`)) return;

    try {
        const res = await fetch('/api/admin/manage-balance', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify({ username, amount, action }) });
        const data = await res.json();
        if (data.error) { alert('❌ Błąd: ' + data.error); } else {
            alert(`✅ Zakończono sukcesem! Nowy stan konta gracza ${username}: ${data.newBalance.toFixed(2)} R$`);
            document.getElementById('adminBalanceAmount').value = '';
            loadAdminStats(); 
            fetchUserDetails(username);
        }
    } catch (e) { alert('Błąd połączenia z serwerem.'); }
}

async function createAdminPromoCode() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return alert('Brak autoryzacji administratora!');
    const code = document.getElementById('adminPromoCode').value.trim();
    const reward = parseFloat(document.getElementById('adminPromoReward').value);
    const maxUses = parseInt(document.getElementById('adminPromoUses').value);
    
    if (!code || !reward || !maxUses) return alert('Uzupełnij wszystkie pola!');
    const btn = event.target; btn.disabled = true; btn.innerText = "⏳ Generowanie...";
    try {
        const res = await fetch('/api/admin/create-code', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify({ code, reward, maxUses }) });
        const data = await res.json();
        if (data.error) { alert('❌ Błąd: ' + data.error); } 
        else {
            alert('✅ Pomyślnie stworzono kod! Wysłano powiadomienie na Discord.');
            document.getElementById('adminPromoCode').value = ''; document.getElementById('adminPromoReward').value = ''; document.getElementById('adminPromoUses').value = '';
        }
    } catch (e) { alert('Błąd połączenia z serwerem.'); }
    btn.disabled = false; btn.innerText = "🚀 Wygeneruj Kod i Powiadom Discord";
}
async function loadAdminTop5Codes() {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    const tbody = document.getElementById('adminTop5CodesBody');
    try {
        const res = await fetch('/api/admin/promo-codes', { headers: { 'Authorization': token } });
        const codes = await res.json();
        
        if (codes.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#888;">Brak aktywnych kodów.</td></tr>`;
            return;
        }
        
        const top5 = codes.slice(0, 5); // Bierzemy maksymalnie 5 najnowszych
        let html = "";
        top5.forEach(c => {
            html += `
            <tr style="border-bottom: 1px solid #2a2e39;">
                <td style="font-weight: bold; color: #fff;">🎟️ ${c.code}</td>
                <td style="color: #ffb703; font-weight: bold;">${c.currentUses} / ${c.maxUses}</td>
                <td style="color: #00e676; font-weight: bold;">+${c.reward} R$</td>
                <td>
                    <button style="background: #ff3333; color: #fff; border: none; padding: 4px 8px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 0.8rem;" data-perm="promo" onclick="deleteAdminPromoCode('${c._id}', this)">Usuń</button>
                </td>
            </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red;">Błąd ładowania</td></tr>`;
    }
}

async function deleteAdminPromoCode(codeId, btnElement) {
    const token = localStorage.getItem('rbx_admin_token');
    if (!token) return;
    if (!confirm("Na pewno usunąć ten kod?")) return;
    
    btnElement.disabled = true;
    btnElement.innerText = "...";
    try {
        const res = await fetch('/api/admin/delete-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': token },
            body: JSON.stringify({ codeId })
        });
        const data = await res.json();
        if (data.error) {
            alert('Błąd: ' + data.error);
            btnElement.disabled = false;
        } else {
            loadAdminTop5Codes(); // Odświeża listę, a stara pozycja znika i dociąga kolejną z góry!
        }
    } catch (e) {
        alert('Błąd połączenia.');
        btnElement.disabled = false;
    }
}
