// =================== PANEL ADMINA: SEKCJE ROZSZERZONE ===================
// wykres zysku, partnerzy, cofnięcia, revtagi, tickety, blokada wypłat
const admToken = () => localStorage.getItem('rbx_admin_token');
async function admGet(url) {
    const res = await fetch(url, { headers: { 'Authorization': admToken() } });
    return res.json();
}
async function admPost(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': admToken() }, body: JSON.stringify(body) });
    return res.json();
}
const usd = n => '$' + (parseFloat(n) || 0).toFixed(2);
const rs = n => (parseFloat(n) || 0).toFixed(2) + ' R$';
const plDate = d => { try { return new Date(d).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
const errRow = (cols, text) => `<tr><td colspan="${cols}" class="adm-muted">${escHtml(text)}</td></tr>`;

// /admin?user=Nick (kliknięty nick na stronie): zapamiętaj i po zalogowaniu od razu wyszukaj gracza
(function () {
    try {
        const p = new URLSearchParams(location.search), u = p.get('user');
        if (u) {
            sessionStorage.setItem('adm_open_user', u);
            p.delete('user');
            history.replaceState({}, document.title, location.pathname + (p.toString() ? '?' + p.toString() : ''));
        }
    } catch (e) {}
})();
function openPendingUser() {
    let u = null;
    try { u = sessionStorage.getItem('adm_open_user'); sessionStorage.removeItem('adm_open_user'); } catch (e) {}
    if (!u) return;
    const input = document.getElementById('adminSearchUser');
    if (input) input.value = u;
    if (typeof fetchUserDetails === 'function') fetchUserDetails(u);
    setTimeout(() => { const box = document.getElementById('adminSearchUser'); if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 400);
}

function adminExtraRefresh() {
    openPendingUser();
    loadAdminHistory(); loadAdminPartners(); loadAdminReversals(); loadAdminDupes(); loadAdminTickets();
    if (ADMIN.role === 'owner') loadReferralFix();
}

// --- 1. wykres ---
async function loadAdminHistory() {
    const box = document.getElementById('admHistChart'), totals = document.getElementById('admHistTotals');
    if (!box) return;
    const days = document.getElementById('admHistDays').value;
    try {
        const data = await admGet('/api/admin/history?days=' + days);
        if (!Array.isArray(data)) throw new Error();
        const sum = k => data.reduce((s, d) => s + (d[k] || 0), 0);
        const profit = sum('profitUsd');
        totals.innerHTML = [
            ['💰 Przychód', usd(sum('revenueUsd')), '#00e676'],
            ['💸 Koszt', usd(sum('costUsd')), '#ff5c5c'],
            ['⭐ w tym bonus właściciela', usd(sum('ownerBonusUsd')), '#ffb703'],
            ['👑 Czysty zysk', usd(profit), profit >= 0 ? '#ffb703' : '#ff5c5c']
        ].map(([l, v, c]) => `<div class="adm-total"><span>${l}</span><b style="color:${c}">${v}</b></div>`).join('');
        box.innerHTML = drawChart(data);
    } catch (e) { box.innerHTML = '<p class="adm-muted">Błąd ładowania wykresu.</p>'; totals.innerHTML = ''; }
}

function drawChart(data) {
    const W = 760, H = 260, L = 48, R = 10, T = 12, B = 34;
    const vals = data.flatMap(d => [d.revenueUsd, d.costUsd, d.profitUsd]);
    let max = Math.max(0.01, ...vals), min = Math.min(0, ...vals);
    const span = max - min, y = v => T + (max - v) / span * (H - T - B);
    const n = data.length, slot = (W - L - R) / n, bw = Math.max(2, Math.min(14, slot * 0.3));
    let g = '';
    for (let i = 0; i <= 4; i++) {
        const v = min + span * i / 4, yy = y(v);
        g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#2a2e39" stroke-width="1"/><text x="${L - 6}" y="${yy + 4}" fill="#8a90a0" font-size="11" text-anchor="end">$${v.toFixed(2)}</text>`;
    }
    const pts = [];
    data.forEach((d, i) => {
        const cx = L + slot * i + slot / 2;
        const bar = (v, x, color, name) => { const y0 = y(0), yv = y(v); return `<rect x="${x}" y="${Math.min(y0, yv)}" width="${bw}" height="${Math.max(1, Math.abs(y0 - yv))}" fill="${color}" rx="2"><title>${d.day} • ${name}: $${v.toFixed(2)}</title></rect>`; };
        g += bar(d.revenueUsd, cx - bw - 1, '#00e676', 'Przychód') + bar(d.costUsd, cx + 1, '#ff5c5c', 'Koszt');
        pts.push([cx, y(d.profitUsd), d]);
        const every = n > 10 ? Math.ceil(n / 10) : 1;
        if (i % every === 0 || i === n - 1) g += `<text x="${cx}" y="${H - 12}" fill="#8a90a0" font-size="11" text-anchor="middle">${d.day.slice(8, 10)}.${d.day.slice(5, 7)}</text>`;
    });
    g += `<polyline points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}" fill="none" stroke="#ffb703" stroke-width="2"/>`;
    g += pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#ffb703"><title>${p[2].day} • Zysk: $${p[2].profitUsd.toFixed(2)}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Wykres zysku">${g}</svg>
        <div class="adm-legend"><span><i style="background:#00e676"></i>Przychód</span><span><i style="background:#ff5c5c"></i>Koszt</span><span><i style="background:#ffb703"></i>Czysty zysk</span></div>`;
}

// --- 2. partnerzy ---
async function loadAdminPartners() {
    const body = document.getElementById('admPartnersBody'); if (!body) return;
    try {
        const list = await admGet('/api/admin/partners?period=' + document.getElementById('admPartnersPeriod').value);
        if (!Array.isArray(list)) throw new Error();
        body.innerHTML = list.map(p => `<tr><td style="font-weight:bold;">${escHtml(p.partner)}</td><td>${p.completes}</td><td style="color:#00e676;">${rs(p.earnedRobux)}</td><td style="color:#ff5c5c;">${p.reversedRobux ? '-' + rs(p.reversedRobux) : rs(0)}</td><td style="color:#ffb703;font-weight:bold;">${usd(p.revenueUsd)}</td></tr>`).join('');
    } catch (e) { body.innerHTML = errRow(5, 'Błąd ładowania'); }
}

// --- 3. cofnięcia ---
async function loadAdminReversals() {
    const body = document.getElementById('admRevBody'); if (!body) return;
    try {
        const list = await admGet('/api/admin/reversals?period=' + document.getElementById('admRevPeriod').value);
        if (!Array.isArray(list)) throw new Error();
        if (!list.length) { body.innerHTML = errRow(6, 'Brak cofniętych ankiet w tym okresie 🎉'); return; }
        body.innerHTML = list.map(r => `<tr><td style="font-weight:bold;">👤 ${escHtml(r.username)}${r.payoutBlocked ? ' <span class="adm-badge-red">🔒</span>' : ''}</td><td>${r.count}</td><td style="color:#ff5c5c;">-${rs(r.robux)}</td><td style="color:#ff5c5c;">-${usd(r.usd)}</td><td style="color:${r.balance < 0 ? '#ff5c5c' : '#00e676'};font-weight:bold;">${rs(r.balance)}</td><td style="color:#a0a0b0;">${escHtml((r.partners || []).join(', '))}</td></tr>`).join('');
    } catch (e) { body.innerHTML = errRow(6, 'Błąd ładowania'); }
}

// --- 4. ten sam revtag ---
async function loadAdminDupes() {
    const body = document.getElementById('admDupesBody'); if (!body) return;
    try {
        const list = await admGet('/api/admin/revtag-dupes');
        if (!Array.isArray(list)) throw new Error();
        if (!list.length) { body.innerHTML = errRow(2, 'Brak powtórzonych Revtagów 👍'); return; }
        body.innerHTML = list.map(g => `<tr><td style="font-weight:bold;color:#ffb703;">${escHtml(g.revtag)}</td><td class="adm-wrap-cell">${g.users.map(u => `<span class="adm-chip${u.payoutBlocked ? ' is-blocked' : ''}">${escHtml(u.username)} <small style="color:#8a90a0;">${rs(u.points)}</small> ${blockBtn(u.username, u.payoutBlocked)}</span>`).join('')}</td></tr>`).join('');
    } catch (e) { body.innerHTML = errRow(2, 'Błąd ładowania'); }
}

// --- 6. blokada wypłat ---
function blockBtn(username, blocked) {
    return blocked
        ? `<button class="adm-mini green" data-perm="block" data-user="${escHtml(username)}" onclick="adminSetPayoutBlock(this.dataset.user, false, this)">Odblokuj wypłaty</button>`
        : `<button class="adm-mini red" data-perm="block" data-user="${escHtml(username)}" onclick="adminSetPayoutBlock(this.dataset.user, true, this)">Zablokuj wypłaty</button>`;
}
function renderUserBlock(data) {
    const val = document.getElementById('adminSelectedValue');
    if (val) {
        const v = data.value || {};
        let html = `<div><span>💰 Ile warte jest to saldo</span><b style="color:#00e676;">${usd(v.worthUsd)}</b></div>`;
        if (v.userUsd !== undefined) {
            html += `<div><span>💵 Gracz dostanie przy wypłacie</span><b style="color:#4dabf7;">${usd(v.userUsd)}</b></div>`;
            html += `<div><span>👑 Twój czysty zysk${v.bonusShare ? ' (gracz z bonusem ' + Math.round(v.bonusShare * 100) + '%)' : ''}</span><b style="color:#ffb703;">${usd(v.profitUsd)}</b></div>`;
        }
        val.innerHTML = html;
    }
    const rev = document.getElementById('adminSelectedRevtag'); if (rev) rev.innerText = data.revtag || 'brak';
    renderAccountBlock(data);
    const el = document.getElementById('adminSelectedBlock'); if (!el) return;
    el.innerHTML = 'Wypłaty: ' + (data.payoutBlocked ? '<span class="adm-badge-red">🔒 zablokowane</span>' : '<span class="adm-badge-green">✔ dozwolone</span>') + ' ' + blockBtn(data.username, data.payoutBlocked);
}
// --- zaległe bonusy z poleceń (tylko właściciel) ---
async function loadReferralFix() {
    const box = document.getElementById('admRefFixBox'), body = document.getElementById('admRefFixBody'), btn = document.getElementById('admRefFixBtn');
    if (!box) return;
    box.style.display = 'block';
    try {
        const list = await admGet('/api/admin/referral-fix');
        if (!Array.isArray(list)) throw new Error();
        if (!list.length) { body.innerHTML = errRow(3, 'Wszyscy polecający mają dopisane, co im się należy 👍'); btn.style.display = 'none'; return; }
        body.innerHTML = list.map(e => `<tr><td style="font-weight:bold;">👤 ${escHtml(e.referrer)}</td><td class="adm-wrap-cell" style="color:#a0a0b0;">${e.people.map(p => escHtml(p.username) + ' <span style="color:#ffb703;">+' + p.missing.toFixed(2) + '</span>').join(', ')}</td><td style="color:#00e676;font-weight:bold;">+${rs(e.total)}</td></tr>`).join('');
        const total = list.reduce((s, e) => s + e.total, 0);
        btn.innerText = `💸 Dopisz wszystkim (${list.length} os., razem ${total.toFixed(2)} R$)`;
        btn.style.display = 'inline-block';
    } catch (e) { body.innerHTML = errRow(3, 'Błąd ładowania'); btn.style.display = 'none'; }
}
async function applyReferralFix(btn) {
    if (!confirm('Dopisać wszystkim polecającym zaległe bonusy? Każdy dostanie jeden wpis w historii „przepraszamy za błąd”.')) return;
    btn.disabled = true;
    try {
        const data = await admPost('/api/admin/referral-fix', {});
        if (data.error) alert('Błąd: ' + data.error);
        else alert(`Gotowe: dopisano ${data.total.toFixed(2)} R$ dla ${data.referrers} polecających.`);
    } catch (e) { alert('Błąd połączenia.'); }
    btn.disabled = false;
    loadReferralFix();
}

// --- blokada całego konta + usuwanie konta ---
let admChooserFor = null; // dla kogo jest otwarty wybór czasu blokady (zostaje otwarty po odświeżeniu danych)
function toggleBlockChooser(username, open) {
    admChooserFor = open ? String(username).toLowerCase() : null;
    const c = document.getElementById('admBlockChooser'); if (c) c.style.display = open ? 'flex' : 'none';
}
function renderAccountBlock(data) {
    const el = document.getElementById('adminSelectedAccountBlock'); if (!el) return;
    const u = escHtml(data.username);
    let status;
    if (!data.accountBlocked) status = '<span class="adm-badge-green">✔ aktywne</span>';
    else status = '<span class="adm-badge-red">🔒 zablokowane ' + (data.blockedUntil ? 'do ' + plDate(data.blockedUntil) : 'na zawsze') + '</span>';
    let html = `<div class="adm-acc-line">Konto: ${status} `;
    html += data.accountBlocked
        ? `<button class="adm-mini green" data-perm="block" data-user="${u}" onclick="adminSetAccountBlock(this.dataset.user, false, this)">Odblokuj konto</button>`
        : `<button class="adm-mini red" data-perm="block" data-user="${u}" onclick="toggleBlockChooser(this.dataset.user, true)">Zablokuj konto</button>`;
    if (ADMIN.role === 'owner') html += ` <button class="adm-mini dark" data-user="${u}" onclick="adminDeleteAccount(this.dataset.user, this)">🗑️ Usuń konto całkowicie</button>`;
    html += '</div>';
    if (!data.accountBlocked) {
        const openNow = admChooserFor === String(data.username).toLowerCase();
        html += `<div id="admBlockChooser" class="adm-block-chooser" style="display:${openNow ? 'flex' : 'none'};">
            <button class="adm-mini red" data-perm="block" data-user="${u}" onclick="adminSetAccountBlock(this.dataset.user, true, this, true)">Na zawsze</button>
            <span class="adm-muted-inline">albo na czas:</span>
            <input type="number" id="admBlockValue" min="1" value="1" class="adm-num">
            <select id="admBlockUnit" class="adm-select"><option value="seconds">sekundy</option><option value="minutes">minuty</option><option value="hours">godziny</option><option value="days" selected>dni</option><option value="months">miesiące</option><option value="years">lata</option></select>
            <button class="adm-mini red" data-perm="block" data-user="${u}" onclick="adminSetAccountBlock(this.dataset.user, true, this, false)">Zablokuj na ten czas</button>
            <button class="adm-mini dark" onclick="toggleBlockChooser('', false)">Anuluj</button>
        </div>`;
    }
    const keepVal = document.getElementById('admBlockValue'), keepUnit = document.getElementById('admBlockUnit');
    const v = keepVal ? keepVal.value : null, un = keepUnit ? keepUnit.value : null;
    el.innerHTML = html;
    if (v && document.getElementById('admBlockValue')) { document.getElementById('admBlockValue').value = v; document.getElementById('admBlockUnit').value = un; }
}
async function adminSetAccountBlock(username, blocked, btn, forever) {
    const body = { username, blocked };
    let label = 'Odblokować konto';
    if (blocked) {
        if (forever) { body.forever = true; label = 'Zablokować NA ZAWSZE konto'; }
        else {
            body.value = parseInt(document.getElementById('admBlockValue').value, 10);
            body.unit = document.getElementById('admBlockUnit').value;
            if (!(body.value >= 1)) return alert('Wpisz liczbę od 1.');
            const unitTxt = document.getElementById('admBlockUnit').selectedOptions[0].text;
            label = `Zablokować na ${body.value} (${unitTxt}) konto`;
        }
    }
    if (!confirm(`${label} gracza ${username}?`)) return;
    if (btn) btn.disabled = true;
    try {
        const data = await admPost('/api/admin/set-account-block', body);
        if (data.error) { alert('Błąd: ' + data.error); if (btn) btn.disabled = false; return; }
        admChooserFor = null;
        if (typeof fetchUserDetails === 'function') fetchUserDetails(username);
    } catch (e) { alert('Błąd połączenia.'); if (btn) btn.disabled = false; }
}
async function adminDeleteAccount(username, btn) {
    const typed = prompt(`UWAGA! To usunie konto ${username} i WSZYSTKO o nim: saldo, historię, wypłaty, pakiety, tickety, powiadomienia. Zniknie też z rankingów. Tego nie da się cofnąć.\n\nWpisz dokładnie nick gracza, żeby potwierdzić:`);
    if (typed === null) return;
    if (typed !== username) return alert('Nick się nie zgadza, nic nie usunięto.');
    if (btn) btn.disabled = true;
    try {
        const data = await admPost('/api/admin/delete-account', { username, confirm: typed });
        if (data.error) { alert('Błąd: ' + data.error); if (btn) btn.disabled = false; return; }
        alert(`Usunięto konto ${data.username}.`);
        document.getElementById('adminSelectedUserDetails').style.display = 'none';
        document.getElementById('adminSearchUser').value = '';
        if (typeof adminRefreshAll === 'function') adminRefreshAll();
    } catch (e) { alert('Błąd połączenia.'); if (btn) btn.disabled = false; }
}

async function adminSetPayoutBlock(username, blocked, btn) {
    if (!confirm(`${blocked ? 'Zablokować' : 'Odblokować'} wypłaty gracza ${username}?`)) return;
    if (btn) btn.disabled = true;
    try {
        const data = await admPost('/api/admin/set-payout-block', { username, blocked });
        if (data.error) { alert('Błąd: ' + data.error); if (btn) btn.disabled = false; return; }
        loadAdminDupes(); loadAdminReversals();
        const sel = document.getElementById('adminSelectedUsername');
        if (sel && sel.innerText.toLowerCase() === String(username).toLowerCase() && typeof fetchUserDetails === 'function') fetchUserDetails(username);
    } catch (e) { alert('Błąd połączenia.'); if (btn) btn.disabled = false; }
}

// --- 9. tickety ---
async function loadAdminTickets() {
    const box = document.getElementById('admTicketsList'); if (!box) return;
    try {
        const list = await admGet('/api/admin/tickets');
        if (!Array.isArray(list)) throw new Error();
        if (!list.length) { box.innerHTML = '<p class="adm-muted">Brak aktywnych ticketów 🎉</p>'; return; }
        box.innerHTML = list.map(t => `<div class="adm-ticket"><div class="adm-ticket-top"><div><b>#${String(t.number || 0).padStart(4, '0')}</b> · 👤 ${escHtml(t.username)}${t.discordName ? ' · @' + escHtml(t.discordName) : ''}</div><span>${plDate(t.createdAt)}</span></div><div class="adm-ticket-msg">${escHtml(t.message)}</div></div>`).join('');
    } catch (e) { box.innerHTML = '<p class="adm-muted">Błąd ładowania</p>'; }
}
