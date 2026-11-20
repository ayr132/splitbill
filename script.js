// ================= State =================
const { toCents, compute, expenseBreakdown } = window.Calc;
const { t } = window.I18n;
const STORAGE_KEY = "splitbill-trip-v2";
const TAB_KEY = "splitbill-tab";
const COLORS = ["#d8a7c0", "#f8c99a", "#b6d7a8", "#a2c4c9", "#c9b6e4", "#f5e08c", "#f4a6a6", "#9fc5e8", "#d5c4a1", "#b4e0d4"];

const emptyState = () => ({ title: "", currency: "RM", people: [], expenses: [] });
const AI_MAX_IMAGES = 4;
const AI_MAX_IMAGE_BYTES = 100 * 1024; // must match api/parse.js

let state = loadState();
let draft = null;        // expense being edited in the dialog
let lastResult = null;   // latest compute() output

function loadState() {
    try {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (s && Array.isArray(s.people) && Array.isArray(s.expenses)) return { ...emptyState(), ...s };
    } catch (_) { /* unavailable or corrupt */ }
    return emptyState();
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        return true;
    } catch (_) {
        return false;
    }
}

// ================= Helpers =================
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = obj => JSON.parse(JSON.stringify(obj));
const person = id => state.people.find(p => p.id === id);

function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// HTML-safe money string (currency symbol is escaped)
function money(cents) {
    const sign = cents < 0 ? "-" : "";
    return `${sign}${esc(state.currency)}${(Math.abs(cents) / 100).toFixed(2)}`;
}

function pill(id) {
    const p = person(id);
    if (!p) return `<span class="pill" style="--pc:#ccc">${esc(t("removed"))}</span>`;
    return `<span class="pill" style="--pc:${p.color}">${esc(p.name)}</span>`;
}

function moneyCell(cents, extraClass = "") {
    return `<td class="num ${cents === 0 ? "zero" : ""} ${extraClass}">${money(cents)}</td>`;
}

function netBadge(cents) {
    if (cents > 0) return `<span class="net-badge pos">${t("getsBack", { amt: money(cents) })}</span>`;
    if (cents < 0) return `<span class="net-badge neg">${t("owes", { amt: money(-cents) })}</span>`;
    return `<span class="net-badge even">${t("allSquare")}</span>`;
}

function nextColor(people = state.people) {
    const used = new Set(people.map(p => p.color));
    return COLORS.find(c => !used.has(c)) || COLORS[people.length % COLORS.length];
}

function updateDocTitle() {
    document.title = state.title ? `${state.title} · ${t("appName")}` : t("appName");
}

// ================= Language =================
function applyLanguage() {
    window.I18n.applyStatic();
    $("aiDropText").textContent = t("aiDrop", { n: AI_MAX_IMAGES });
    document.querySelectorAll("[data-lang]").forEach(b => {
        const on = b.dataset.lang === window.I18n.getLang();
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on);
    });
}

document.querySelectorAll("[data-lang]").forEach(b => b.addEventListener("click", () => {
    window.I18n.setLang(b.dataset.lang);
    applyLanguage();
    render();
    if ($("expenseDialog").open) {
        $("dialogTitle").textContent = t(draft.id ? "editExpenseTitle" : "addExpenseTitle");
        renderDraft();
    }
    if (aiData && $("aiDialog").open) renderAiPreview();
    if ($("exportDialog").open) openExport();
    // Re-translate any error message that's currently on screen.
    setDialogError(dialogErrorState.key, dialogErrorState.vars);
    aiError(aiErrorState.key, aiErrorState.vars);
}));

// Error messages remember their translation key so they can follow a language switch.
let dialogErrorState = { key: "", vars: {} };
let aiErrorState = { key: "", vars: {} };
function setDialogError(key, vars = {}) {
    dialogErrorState = { key, vars };
    $("dialogError").textContent = key ? t(key, vars) : "";
}
function aiError(key, vars = {}) {
    aiErrorState = { key, vars };
    $("aiError").textContent = key ? t(key, vars) : "";
}

// ================= Tabs =================
function currentTab() {
    try { return localStorage.getItem(TAB_KEY) || "shared"; } catch (_) { return "shared"; }
}
function showTab(tab) {
    document.querySelectorAll(".tab").forEach(el => {
        const on = el.dataset.tab === tab;
        el.classList.toggle("active", on);
        el.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== tab));
    try { localStorage.setItem(TAB_KEY, tab); } catch (_) { /* ignore */ }
}
document.querySelectorAll(".tab").forEach(el => el.addEventListener("click", () => showTab(el.dataset.tab)));

// ================= Render =================
function render() {
    lastResult = compute(state);
    $("tripTitle").value = state.title;
    $("currency").value = state.currency;
    updateDocTitle();
    renderPeople();
    renderShared();
    renderSpend();
    renderIndividual();
    renderOwe();
    renderSummary();
}

function commit() {
    const ok = saveState();
    render();
    if (!ok) alert(t("storageFull"));
    return ok;
}

// ---------- Friends ----------
function renderPeople() {
    $("peopleList").innerHTML = state.people.length
        ? state.people.map(p => `
            <li class="person-pill" style="--pc:${p.color}">
                <span class="avatar" aria-hidden="true"><span class="ico ico-user"></span></span>
                <button type="button" class="name-btn" data-rename="${p.id}" title="${esc(t("rename"))}">${esc(p.name)}</button>
                <button type="button" class="remove-btn" data-remove-person="${p.id}" aria-label="${esc(t("removeName", { name: p.name }))}" title="${esc(t("removeName", { name: p.name }))}"><span class="ico ico-user-minus" aria-hidden="true"></span></button>
            </li>`).join("")
        : `<li class="muted">${t("noFriendsYet")}</li>`;
    $("peopleCount").textContent = state.people.length ? t("peopleCount", { n: state.people.length }) : "";
    $("welcome").classList.toggle("hidden", state.people.length > 0);
}

// ---------- 1. Shared expenses ----------
function renderShared() {
    const list = $("expenseList");
    if (!state.people.length) {
        list.innerHTML = `<div class="empty">${t("emptyNoPeople")}<br><br>
            <button type="button" class="link-btn" data-action="example">${t("orExample")}</button></div>`;
        return;
    }
    if (!state.expenses.length) {
        list.innerHTML = `<div class="empty">${t("emptyShared")}</div>`;
        return;
    }
    list.innerHTML = state.expenses.map(exp => {
        const b = lastResult.perExpense.get(exp.id);
        const sharers = state.people.filter(p => b.shares.get(p.id) > 0);
        const splitText = exp.mode === "itemized"
            ? t("splitItems")
            : (sharers.length === state.people.length ? t("splitEveryone") : t("splitN", { n: sharers.length }));

        const chips = sharers.map(p =>
            `<span class="share-chip">${pill(p.id)} ${money(b.shares.get(p.id))}</span>`).join("");

        let items = "";
        if (exp.mode === "itemized" && exp.items.length) {
            const count = exp.items.length === 1 ? t("itemsOne") : t("itemsMany", { n: exp.items.length });
            items = `<details class="items"><summary>${count}</summary>
                <table><thead><tr><th>${t("thOrder")}</th><th>${t("thSharedBy")}</th><th class="num">${t("thPrice")}</th></tr></thead><tbody>
                ${exp.items.map(it => {
                    const who = it.people.filter(id => person(id));
                    const whoHtml = who.length === state.people.length && state.people.length > 1
                        ? `<span class="muted">${t("everyone")}</span>`
                        : (who.map(pill).join(" ") || `<span class="muted">${t("noOnePayerCovers")}</span>`);
                    return `<tr><td>${esc(it.name || t("defaultItem"))}</td><td>${whoHtml}</td>${moneyCell(toCents(it.price))}</tr>`;
                }).join("")}
                </tbody></table></details>`;
        }

        const warnings = [];
        if (exp.mode === "itemized" && b.itemsTotal !== b.total) {
            warnings.push(t("warnDiff", { items: money(b.itemsTotal), diff: money(Math.abs(b.total - b.itemsTotal)) }));
        }
        if (b.unassigned > 0) warnings.push(t("warnUnassigned", { amt: money(b.unassigned) }));

        return `
        <article class="card expense">
            <div class="expense-head">
                <div>
                    <h3 class="expense-name">${esc(exp.name)}</h3>
                    <div class="expense-meta">${t("paidBy")} ${pill(exp.payer)} · ${splitText}</div>
                </div>
                <div class="expense-right">
                    <span class="expense-amount"><span class="ico ico-money" aria-hidden="true"></span>${money(b.total)}</span>
                    <button type="button" class="btn soft small" data-edit="${exp.id}">✎ ${t("edit")}</button>
                </div>
            </div>
            <div class="expense-body">
                <div class="shares">
                    <div class="share-chips">${chips}</div>
                    ${items}
                    ${warnings.map(w => `<p class="warn">${w}</p>`).join("")}
                </div>
                ${exp.receipt ? `<img class="receipt-thumb" src="${exp.receipt}" alt="${esc(t("receiptFor", { name: exp.name }))}" data-view-receipt="${exp.id}">` : ""}
            </div>
        </article>`;
    }).join("");
}

// ---------- Spending pie (below the shared expenses) ----------
let spendSlices = [];   // what each pie slice stands for, for the tooltip

const pct = (part, whole) => `${(whole ? (part / whole) * 100 : 0).toFixed(1).replace(/\.0$/, "")}%`;

function renderSpend() {
    const r = lastResult;
    const order = new Map(state.people.map((p, i) => [p.id, i]));
    // One slice per bill, grouped by payer so each person's bills sit together.
    spendSlices = state.expenses
        .map(exp => ({ exp, total: r.perExpense.get(exp.id).total, payer: person(exp.payer) }))
        .filter(s => s.total > 0)
        .sort((a, b) => (order.get(a.exp.payer) ?? 1e9) - (order.get(b.exp.payer) ?? 1e9));
    const total = spendSlices.reduce((a, s) => a + s.total, 0);
    $("spendCard").classList.toggle("hidden", !total);
    hidePieTip();
    if (!total) return;

    const cx = 100, cy = 100, rad = 96;
    const point = a => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
    let angle = 0;
    const paths = spendSlices.map((s, i) => {
        const color = s.payer ? s.payer.color : "#ccc";
        const label = `${s.exp.name}: ${money(s.total)} (${pct(s.total, total)}), ${t("paidBy")} ${s.payer ? s.payer.name : t("removed")}`;
        const common = `class="slice" data-slice="${i}" fill="${color}" tabindex="0" aria-label="${esc(label)}"`;
        if (spendSlices.length === 1) return `<circle ${common} cx="${cx}" cy="${cy}" r="${rad}"/>`;
        const start = angle;
        angle += (s.total / total) * Math.PI * 2;
        const [x1, y1] = point(start), [x2, y2] = point(angle);
        const large = angle - start > Math.PI ? 1 : 0;
        return `<path ${common} d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${rad},${rad} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z"/>`;
    });
    const pie = $("spendPie");
    pie.innerHTML = paths.join("");
    pie.setAttribute("aria-label", t("spendAria", { n: spendSlices.length, amt: `${state.currency}${(total / 100).toFixed(2)}` }));

    // Legend: one group per payer, listing the bills they paid.
    const groups = [];
    spendSlices.forEach((s, i) => {
        const key = s.exp.payer;
        let g = groups.find(x => x.key === key);
        if (!g) groups.push(g = { key, payer: s.payer, sum: 0, rows: [] });
        g.sum += s.total;
        g.rows.push({ s, i });
    });
    $("spendLegend").innerHTML = groups.map(g => `
        <div class="spend-group">
            <div class="spend-payer">${pill(g.key)} <span class="muted">${t("spendPaidShare", { amt: money(g.sum), pct: pct(g.sum, total) })}</span></div>
            <ul>${g.rows.map(({ s, i }) => `
                <li data-slice="${i}">
                    <span class="swatch" style="--pc:${s.payer ? s.payer.color : "#ccc"}" aria-hidden="true"></span>
                    <span class="spend-name">${esc(s.exp.name)}</span>
                    <span class="num">${money(s.total)}</span>
                    <span class="num spend-pct">${pct(s.total, total)}</span>
                </li>`).join("")}
            </ul>
        </div>`).join("") + `
        <div class="spend-total"><span>${t("total")}</span><span class="num">${money(total)}</span><span class="num spend-pct">100%</span></div>`;
}

function showPieTip(i, evt) {
    const s = spendSlices[i];
    if (!s) return;
    const total = spendSlices.reduce((a, x) => a + x.total, 0);
    const tip = $("pieTip");
    tip.innerHTML = `<b>${esc(s.exp.name)}</b>
        <div class="tip-row"><span>${money(s.total)}</span><span class="muted">${pct(s.total, total)}</span></div>
        <div>${t("paidBy")} ${pill(s.exp.payer)}</div>`;
    tip.classList.remove("hidden");
    const wrap = $("spendPie").parentElement.getBoundingClientRect();
    let x, y;
    if (evt && evt.clientX !== undefined) { x = evt.clientX - wrap.left; y = evt.clientY - wrap.top; }
    else { const b = evt.target.getBoundingClientRect(); x = b.left + b.width / 2 - wrap.left; y = b.top + b.height / 2 - wrap.top; }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.max(0, Math.min(wrap.width - w, x + 12))}px`;
    tip.style.top = `${Math.max(0, y - h - 12)}px`;
    document.querySelectorAll("[data-slice]").forEach(el => el.classList.toggle("active", el.dataset.slice === String(i)));
}
function hidePieTip() {
    $("pieTip").classList.add("hidden");
    document.querySelectorAll("[data-slice].active").forEach(el => el.classList.remove("active"));
}
$("spendPie").addEventListener("pointermove", e => {
    const i = e.target.closest("[data-slice]")?.dataset.slice;
    i === undefined ? hidePieTip() : showPieTip(Number(i), e);
});
$("spendPie").addEventListener("pointerleave", hidePieTip);
$("spendPie").addEventListener("focusin", e => {
    const i = e.target.closest("[data-slice]")?.dataset.slice;
    if (i !== undefined) showPieTip(Number(i), { target: e.target });
});
$("spendPie").addEventListener("focusout", hidePieTip);
$("spendLegend").addEventListener("pointerover", e => {
    const i = e.target.closest("[data-slice]")?.dataset.slice;
    if (i === undefined) return hidePieTip();
    const slice = $("spendPie").querySelector(`[data-slice="${i}"]`);
    showPieTip(Number(i), { target: slice });
});
$("spendLegend").addEventListener("pointerleave", hidePieTip);

// ---------- 2. Individual expenses ----------
function renderIndividual() {
    const r = lastResult;
    if (!state.people.length) {
        $("individualList").innerHTML = `<div class="empty">${t("nobodyHere")}</div>`;
        return;
    }
    $("individualList").innerHTML = state.people.map((p, i) => {
        const rows = state.expenses.map(exp => {
            const b = r.perExpense.get(exp.id);
            const share = b.shares.get(p.id) || 0;
            const paid = exp.payer === p.id ? b.total : 0;
            if (!share && !paid) return "";
            return `<tr><td>${esc(exp.name)}</td>${moneyCell(share)}${moneyCell(paid)}</tr>`;
        }).join("");
        return `
        <article class="card person-card" style="--pc:${p.color}">
            <h3>${esc(p.name)} ${netBadge(r.net[i])}</h3>
            <table>
                <thead><tr><th>${t("thItem")}</th><th class="num">${t("thShare")}</th><th class="num">${t("thPaid")}</th></tr></thead>
                <tbody>${rows || `<tr><td colspan="3" class="muted">${t("notInAny")}</td></tr>`}</tbody>
                <tfoot><tr><td>${t("total")}</td>${moneyCell(r.spent[i])}${moneyCell(r.paid[i])}</tr></tfoot>
            </table>
        </article>`;
    }).join("");
}

// ---------- 3. Total amount owed ----------
function renderOwe() {
    const r = lastResult;
    const people = state.people;
    if (people.length < 2) {
        $("oweMatrix").innerHTML = `<p class="muted">${t("needTwo")}</p>`;
        $("simplifiedList").innerHTML = $("pairwiseList").innerHTML = "";
        $("flowList").innerHTML = "";
        $("exportImgBtn").disabled = true;
        return;
    }

    $("exportImgBtn").disabled = false;

    // Matrix: row owes column
    const head = `<tr><th class="corner">${t("owesArrow")}</th>${people.map(p => `<th>${pill(p.id)}</th>`).join("")}<th>${t("totalOwes")}</th></tr>`;
    const body = people.map((p, i) => `<tr><td>${pill(p.id)}</td>${
        people.map((_, j) => i === j ? `<td class="self"></td>` : moneyCell(r.matrix[i][j])).join("")
    }${moneyCell(r.owes[i])}</tr>`).join("");
    const owedRow = `<tr class="total"><td>${t("totalOwedTo")}</td>${people.map((_, j) => moneyCell(r.owedTo[j])).join("")}<td class="self"></td></tr>`;
    const netRow = `<tr><td><b>${t("net")}</b> <span class="muted">${t("netHint")}</span></td>${
        people.map((_, j) => `<td class="num ${r.net[j] > 0 ? "pos" : r.net[j] < 0 ? "neg" : "zero"}">${money(r.net[j])}</td>`).join("")
    }<td class="self"></td></tr>`;
    $("oweMatrix").innerHTML = `<table class="matrix"><thead>${head}</thead><tbody>${body}${owedRow}${netRow}</tbody></table>`;

    const transferList = list => list.length
        ? list.map(x => `<li>${pill(x.from)} <span class="arrow">${t("pays")}</span> ${pill(x.to)} <span class="amt">${money(x.amount)}</span></li>`).join("")
        : `<li class="muted">${t("everyoneSquare")}</li>`;
    $("simplifiedList").innerHTML = transferList(r.simplified);
    $("pairwiseList").innerHTML = transferList(r.pairwise);

    // Cash in / cash out per person (pair-by-pair netting)
    $("flowList").innerHTML = people.map((p, i) => {
        let inSum = 0, outSum = 0;
        const rows = people.map((q, j) => {
            if (i === j) return "";
            const n = r.matrix[j][i] - r.matrix[i][j]; // >0: q pays p
            const cin = n > 0 ? n : 0, cout = n < 0 ? n : 0;
            inSum += cin; outSum += cout;
            return `<tr><td>${pill(q.id)}</td>${moneyCell(cin, cin ? "pos" : "")}${moneyCell(cout, cout ? "neg" : "")}</tr>`;
        }).join("");
        const flow = inSum + outSum;
        const balanced = flow === r.net[i];
        return `
        <article class="card person-card" style="--pc:${p.color}">
            <h3>${esc(p.name)} ${netBadge(flow)}</h3>
            <table>
                <thead><tr><th></th><th class="num">${t("cashIn")}</th><th class="num">${t("cashOut")}</th></tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr><td>${t("sum")}</td>${moneyCell(inSum)}${moneyCell(outSum)}</tr></tfoot>
            </table>
            <p class="check ${balanced ? "ok" : "bad"}">${t(balanced ? "balancedOk" : "balancedBad")}</p>
        </article>`;
    }).join("");
}

// ---------- 4. Summary ----------
function renderSummary() {
    const r = lastResult;
    if (!state.expenses.length) {
        $("billSummary").innerHTML = `<p class="muted">${t("noExpenses")}</p>`;
        $("personSummary").innerHTML = "";
        return;
    }
    $("billSummary").innerHTML = `
        <table>
            <thead><tr><th>${t("thBillWhat")}</th><th>${t("thBillPayer")}</th><th class="num">${t("thAmount")}</th></tr></thead>
            <tbody>${state.expenses.map(exp =>
                `<tr><td>${esc(exp.name)}</td><td>${pill(exp.payer)}</td>${moneyCell(r.perExpense.get(exp.id).total)}</tr>`).join("")}
            </tbody>
            <tfoot><tr><td colspan="2">${t("total")}</td>${moneyCell(r.grandTotal)}</tr></tfoot>
        </table>`;

    $("personSummary").innerHTML = `
        <table>
            <thead><tr><th>${t("thName")}</th><th class="num">${t("thActual")}</th><th class="num">${t("thUpfront")}</th><th class="num">${t("thBalance")}</th></tr></thead>
            <tbody>${state.people.map((p, i) => `<tr><td>${pill(p.id)}</td>${moneyCell(r.spent[i])}${moneyCell(r.paid[i])}
                <td class="num ${r.net[i] > 0 ? "pos" : r.net[i] < 0 ? "neg" : "zero"}">${money(r.net[i])}</td></tr>`).join("")}
            </tbody>
            <tfoot><tr><td>${t("total")}</td>${moneyCell(r.spent.reduce((a, b) => a + b, 0))}${moneyCell(r.paid.reduce((a, b) => a + b, 0))}<td></td></tr></tfoot>
        </table>`;
}

// Plain-text version for pasting into a chat (no HTML escaping).
function settleUpText() {
    const r = lastResult;
    const fmt = c => `${state.currency}${(c / 100).toFixed(2)}`;
    const name = id => person(id)?.name ?? "?";
    const lines = [
        t("settleTitle", { title: state.title || t("defaultTrip") }),
        t("totalSpent", { amt: fmt(r.grandTotal) }),
        "",
    ];
    state.expenses.forEach(exp => lines.push(t("billLine", {
        name: exp.name, amt: fmt(r.perExpense.get(exp.id).total), payer: name(exp.payer),
    })));
    lines.push("", t("whoPaysWhom"));
    if (!r.simplified.length) lines.push(t("everyoneSquareExcl"));
    r.simplified.forEach(x => lines.push(t("transferLine", { from: name(x.from), to: name(x.to), amt: fmt(x.amount) })));
    return lines.join("\n");
}

// ================= Friends events =================
$("getStartedBtn").addEventListener("click", () => {
    const input = $("personName");
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    input.scrollIntoView({ behavior, block: "center" });
    input.focus({ preventScroll: true });
});

$("addPersonForm").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("personName").value.trim();
    if (!name) return;
    if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        alert(t("alreadyOnList", { name }));
        return;
    }
    state.people.push({ id: uid(), name, color: nextColor() });
    $("personName").value = "";
    commit();
    $("personName").focus();
});

$("peopleList").addEventListener("click", e => {
    const renameId = e.target.closest("[data-rename]")?.dataset.rename;
    const removeId = e.target.closest("[data-remove-person]")?.dataset.removePerson;
    if (renameId) {
        const p = person(renameId);
        const name = prompt(t("rename"), p.name)?.trim();
        if (name) { p.name = name; commit(); }
    } else if (removeId) {
        const p = person(removeId);
        const paidFor = state.expenses.filter(x => x.payer === removeId);
        if (paidFor.length) {
            alert(t("paidForFirst", { name: p.name, list: paidFor.map(x => x.name).join(", ") }));
            return;
        }
        const involved = state.expenses.some(x => x.participants?.includes(removeId) || x.items?.some(it => it.people.includes(removeId)));
        if (involved && !confirm(t("removeConfirm", { name: p.name }))) return;
        state.people = state.people.filter(x => x.id !== removeId);
        state.expenses.forEach(x => {
            x.participants = (x.participants || []).filter(id => id !== removeId);
            (x.items || []).forEach(it => { it.people = it.people.filter(id => id !== removeId); });
        });
        commit();
    }
});

// ================= Expense list events =================
$("addExpenseBtn").addEventListener("click", () => openExpense(null));

$("expenseList").addEventListener("click", e => {
    const edit = e.target.closest("[data-edit]")?.dataset.edit;
    const view = e.target.closest("[data-view-receipt]")?.dataset.viewReceipt;
    if (edit) openExpense(edit);
    else if (view) {
        $("imageView").src = state.expenses.find(x => x.id === view).receipt;
        $("imageDialog").showModal();
    } else if (e.target.closest("[data-action='example']")) loadExample();
});

// ================= Expense dialog =================
function openExpense(id) {
    if (!state.people.length) { alert(t("addFriendsFirst")); return; }
    const all = state.people.map(p => p.id);
    draft = id
        ? clone(state.expenses.find(x => x.id === id))
        : { id: null, name: "", payer: all[0], mode: "equal", amount: "", paidOverride: "", participants: all, items: [], receipt: null };
    $("dialogTitle").textContent = t(id ? "editExpenseTitle" : "addExpenseTitle");
    $("deleteExpenseBtn").classList.toggle("hidden", !id);
    setDialogError("");
    renderDraft();
    $("expenseDialog").showModal();
    if (!id) $("dialogBody").querySelector("[data-f='name']").focus();
}

function togglePills(selected, attr, extra = "") {
    return state.people.map(p => {
        const on = selected.includes(p.id);
        return `<button type="button" class="toggle ${on ? "on" : ""}" style="--pc:${p.color}" ${attr}="${p.id}" ${extra} aria-pressed="${on}">${esc(p.name)}</button>`;
    }).join("");
}

function renderDraft() {
    const d = draft;
    const payerOptions = state.people.map(p =>
        `<option value="${p.id}" ${p.id === d.payer ? "selected" : ""}>${esc(p.name)}</option>`).join("");

    const equalHtml = `
        <label class="field">${t("amountPaid")}
            <input type="number" data-f="amount" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${esc(d.amount)}">
        </label>
        <div class="field">
            <span class="field-label">${t("splitBetween")} <button type="button" class="link-btn" data-all="1">${t("everyoneLink")}</button> · <button type="button" class="link-btn" data-all="0">${t("noOneLink")}</button></span>
            <div class="toggle-row">${togglePills(d.participants, "data-participant")}</div>
        </div>`;

    const itemizedHtml = `
        <div class="field">
            <span class="field-label">${t("itemsHelp")}</span>
            <div class="item-rows">
                ${d.items.map(it => `
                <div class="item-row" data-item="${it.id}">
                    <div class="item-top">
                        <input type="text" data-if="name" placeholder="${esc(t("itemNamePh"))}" value="${esc(it.name)}" aria-label="${esc(t("itemNameAria"))}">
                        <input type="number" data-if="price" min="0" step="0.01" inputmode="decimal" placeholder="${esc(t("pricePh"))}" value="${esc(it.price)}" aria-label="${esc(t("pricePh"))}">
                        <button type="button" class="icon-btn" data-remove-item="${it.id}" aria-label="${esc(t("removeItem"))}">&times;</button>
                    </div>
                    <div class="toggle-row">
                        ${togglePills(it.people, "data-item-person", `data-item-id="${it.id}"`)}
                        <button type="button" class="link-btn" data-item-all="${it.id}">${t("all")}</button>
                    </div>
                </div>`).join("")}
            </div>
            <div><button type="button" class="btn ghost small" data-add-item>${t("addItem")}</button></div>
        </div>
        <label class="field">${t("receiptTotal")}
            <input type="number" data-f="paidOverride" min="0" step="0.01" inputmode="decimal" placeholder="${esc(t("receiptTotalPh"))}" value="${esc(d.paidOverride)}">
        </label>`;

    $("dialogBody").innerHTML = `
        <div style="display:flex;flex-direction:column;gap:14px">
            <label class="field">${t("whatFor")}
                <input type="text" data-f="name" placeholder="${esc(t("whatForPh"))}" value="${esc(d.name)}" autocomplete="off">
            </label>
            <div class="grid-2">
                <label class="field">${t("paidByLabel")} <select data-f="payer">${payerOptions}</select></label>
                <div class="field">${t("howSplit")}
                    <div class="seg">
                        <button type="button" data-mode="equal" class="${d.mode === "equal" ? "active" : ""}">${t("equally")}</button>
                        <button type="button" data-mode="itemized" class="${d.mode === "itemized" ? "active" : ""}">${t("byItems")}</button>
                    </div>
                </div>
            </div>
            ${d.mode === "equal" ? equalHtml : itemizedHtml}
            <div class="field">
                <span class="field-label">${t("receiptPhoto")}</span>
                <div class="receipt-row">
                    ${d.receipt ? `<img src="${d.receipt}" alt="${esc(t("receiptPreview"))}"><button type="button" class="link-btn" data-remove-receipt>${t("remove")}</button>` : ""}
                    <label class="btn ghost small file-btn">${t(d.receipt ? "replace" : "attachPhoto")}
                        <input type="file" accept="image/*" data-receipt hidden>
                    </label>
                </div>
            </div>
            <div class="preview" id="draftPreview"></div>
        </div>`;
    updatePreview();
}

function updatePreview() {
    const b = expenseBreakdown(draft, state.people);
    const chips = state.people.filter(p => b.shares.get(p.id) > 0)
        .map(p => `<span class="share-chip">${pill(p.id)} ${money(b.shares.get(p.id))}</span>`).join("");
    let note = "";
    if (draft.mode === "itemized" && toCents(draft.paidOverride) && b.itemsTotal !== b.total) {
        note = `<p class="warn">${t("previewDiff", { items: money(b.itemsTotal) })}</p>`;
    }
    $("draftPreview").innerHTML = `
        <div class="preview-total"><span>${t("total")}</span><span>${money(b.total)}</span></div>
        <div class="share-chips">${chips || `<span class="muted">${t("previewEmpty")}</span>`}</div>${note}`;
}

const dialogBody = $("dialogBody");

dialogBody.addEventListener("input", e => {
    const el = e.target;
    if (el.dataset.f) draft[el.dataset.f] = el.value;
    else if (el.dataset.if) {
        const item = draft.items.find(it => it.id === el.closest("[data-item]").dataset.item);
        item[el.dataset.if] = el.value;
    } else return;
    updatePreview();
});

dialogBody.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const all = state.people.map(p => p.id);
    const toggle = (arr, id) => arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];

    if (btn.dataset.mode) {
        draft.mode = btn.dataset.mode;
        if (draft.mode === "itemized" && !draft.items.length) {
            draft.items.push({ id: uid(), name: "", price: "", people: all });
        }
    } else if (btn.dataset.participant) {
        draft.participants = toggle(draft.participants, btn.dataset.participant);
    } else if (btn.dataset.all !== undefined) {
        draft.participants = btn.dataset.all === "1" ? all : [];
    } else if (btn.dataset.itemPerson) {
        const item = draft.items.find(it => it.id === btn.dataset.itemId);
        item.people = toggle(item.people, btn.dataset.itemPerson);
    } else if (btn.dataset.itemAll) {
        const item = draft.items.find(it => it.id === btn.dataset.itemAll);
        item.people = item.people.length === all.length ? [] : all;
    } else if (btn.dataset.removeItem) {
        draft.items = draft.items.filter(it => it.id !== btn.dataset.removeItem);
    } else if (btn.hasAttribute("data-add-item")) {
        const id = uid();
        draft.items.push({ id, name: "", price: "", people: all });
        renderDraft();
        dialogBody.querySelector(`[data-item="${id}"] [data-if="name"]`).focus();
        return;
    } else if (btn.hasAttribute("data-remove-receipt")) {
        draft.receipt = null;
    } else return;
    renderDraft();
});

dialogBody.addEventListener("change", async e => {
    if (!e.target.hasAttribute("data-receipt")) return;
    const file = e.target.files[0];
    if (!file) return;
    try {
        draft.receipt = await compressImage(file);
        renderDraft();
    } catch (_) {
        setDialogError("badImage");
    }
});

// Shrink photos so they fit in browser storage (about 100–200 KB each).
function compressImage(file, maxSide = 1100, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(img.src);
            resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

$("expenseForm").addEventListener("submit", e => {
    e.preventDefault();
    const d = draft;
    d.name = d.name.trim();
    if (d.mode === "itemized") d.items = d.items.filter(it => it.name.trim() || toCents(it.price));
    const b = expenseBreakdown(d, state.people);

    const err = !d.name ? "errName"
        : !person(d.payer) ? "errPayer"
        : d.mode === "equal" && !toCents(d.amount) ? "errAmount"
        : d.mode === "equal" && !d.participants.length ? "errParticipants"
        : d.mode === "itemized" && !b.total ? "errItems"
        : "";
    if (err) {
        setDialogError(err);
        if (d.mode === "itemized" && !d.items.length) {
            d.items.push({ id: uid(), name: "", price: "", people: state.people.map(p => p.id) });
            renderDraft();
        }
        return;
    }

    const backup = clone(state.expenses);
    const isNew = !d.id;
    if (isNew) {
        d.id = uid();
        state.expenses.push(d);
    } else {
        state.expenses = state.expenses.map(x => x.id === d.id ? d : x);
    }
    if (!saveState()) {
        state.expenses = backup;
        if (isNew) d.id = null;
        setDialogError("errStorageFull");
        return;
    }
    $("expenseDialog").close();
    render();
});

$("cancelBtn").addEventListener("click", () => $("expenseDialog").close());

$("deleteExpenseBtn").addEventListener("click", () => {
    if (!draft?.id || !confirm(t("deleteConfirm", { name: draft.name || t("thisExpense") }))) return;
    state.expenses = state.expenses.filter(x => x.id !== draft.id);
    $("expenseDialog").close();
    commit();
});

// ================= Toolbar =================
$("tripTitle").addEventListener("input", e => {
    state.title = e.target.value;
    updateDocTitle();
    saveState();
});

$("currency").addEventListener("input", e => {
    state.currency = e.target.value;
    saveState();
    lastResult = compute(state);
    renderShared(); renderIndividual(); renderOwe(); renderSummary();
});

function loadExample() {
    if ((state.people.length || state.expenses.length) && !confirm(t("replaceExample"))) return;
    state = clone(window.EXAMPLE_TRIP);
    commit();
}
$("exampleBtn").addEventListener("click", loadExample);

$("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.title || "splitbill").replace(/[^\w-]+/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("importInput").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.people) || !Array.isArray(data.expenses)) throw new Error("bad file");
        if ((state.people.length || state.expenses.length) && !confirm(t("replaceImport"))) return;
        state = { ...emptyState(), ...data };
        commit();
    } catch (_) {
        alert(t("badImport"));
    }
});

$("resetBtn").addEventListener("click", () => {
    if (!confirm(t("clearConfirm"))) return;
    state = emptyState();
    commit();
});

$("copyBtn").addEventListener("click", async () => {
    const text = settleUpText();
    try {
        await navigator.clipboard.writeText(text);
        $("copyStatus").textContent = t("copied");
    } catch (_) {
        prompt(t("copyThis"), text);
    }
    setTimeout(() => { $("copyStatus").textContent = ""; }, 3000);
});

// ================= Read with AI =================
let aiImages = [];   // { mediaType, data (base64), url (data URL for preview) }
let aiData = null;   // last result from /api/parse

function aiStep(step) {
    $("aiInputStep").classList.toggle("hidden", step !== "input");
    $("aiPreviewStep").classList.toggle("hidden", step !== "preview");
}


function renderAiThumbs() {
    $("aiThumbs").innerHTML = aiImages.map((img, i) => `
        <div class="ai-thumb">
            <img src="${img.url}" alt="">
            <button type="button" data-remove-ai-image="${i}" aria-label="${esc(t("aiRemoveImage"))}">&times;</button>
        </div>`).join("");
}

async function addAiFiles(files) {
    aiError("");
    for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        if (aiImages.length >= AI_MAX_IMAGES) { aiError("aiTooMany", { n: AI_MAX_IMAGES }); break; }
        try {
            const url = await compressToLimit(file, AI_MAX_IMAGE_BYTES);
            if (!url) { aiError("aiErr_image_too_large"); continue; }
            aiImages.push({ mediaType: "image/jpeg", data: url.split(",")[1], url });
        } catch (_) {
            aiError("badImage");
        }
    }
    renderAiThumbs();
}

// Re-encode an image as JPEG, stepping quality and then size down until it fits in maxBytes.
// Starts sharp so small handwriting and receipt text stay readable. Returns null if it can't fit.
function compressToLimit(file, maxBytes) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const bytesOf = url => Math.floor((url.length - url.indexOf(",") - 1) * 3 / 4);
            let side = Math.min(2000, Math.max(img.width, img.height));
            while (side >= 400) {
                const scale = side / Math.max(img.width, img.height);
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                for (const q of [0.85, 0.75, 0.65, 0.55]) {
                    const url = canvas.toDataURL("image/jpeg", q);
                    if (bytesOf(url) <= maxBytes) return resolve(url);
                }
                side = Math.floor(side * 0.8);
            }
            resolve(null);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

function openAi() {
    aiData = null;
    aiError("");
    aiStep("input");
    renderAiThumbs();
    $("aiDialog").showModal();
    $("aiText").focus();
}

function setAiLoading(on) {
    $("aiLoading").classList.toggle("hidden", !on);
    $("aiReadBtn").disabled = on;
    $("aiText").disabled = on;
}

async function callParse(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
        return await fetch("/api/parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                text,
                images: aiImages.map(({ mediaType, data }) => ({ mediaType, data })),
                lang: window.I18n.getLang(),
            }),
        });
    } finally {
        clearTimeout(timer);
    }
}

async function runAi() {
    const text = $("aiText").value.trim();
    if (!text && !aiImages.length) { aiError("aiNeedInput"); return; }
    aiError("");
    setAiLoading(true);
    try {
        const res = await callParse(text);
        // Vercel's own errors (timeouts, crashes) come back as HTML, not JSON.
        const body = await res.json().catch(() => ({ error: "failed", detail: `HTTP ${res.status}` }));
        if (!res.ok) {
            if (res.status === 504) { aiError("aiErr_timeout"); return; }
            const key = window.I18n.STRINGS.en[`aiErr_${body.error}`] ? `aiErr_${body.error}` : "aiErr_failed";
            const detail = body.detail || "";
            aiError(key, { detail, why: detail ? ` (${detail})` : "" });
            return;
        }
        if (!Array.isArray(body.expenses) || !body.expenses.length) {
            aiError("aiErrNothing");
            return;
        }
        aiData = body;
        renderAiPreview();
        aiStep("preview");
    } catch (_) {
        aiError("aiErrNetwork");
    } finally {
        setAiLoading(false);
    }
}

// Turn the AI's answer into app data, merged into `base` (people matched by name).
function mergeAiResult(data, base) {
    const trip = clone(base);
    const ids = new Map(trip.people.map(p => [p.name.trim().toLowerCase(), p.id]));
    const idFor = name => {
        const clean = String(name ?? "").trim();
        const key = clean.toLowerCase();
        if (!key) return null;
        if (!ids.has(key)) {
            const p = { id: uid(), name: clean, color: nextColor(trip.people) };
            trip.people.push(p);
            ids.set(key, p.id);
        }
        return ids.get(key);
    };
    const unique = list => [...new Set(list.filter(Boolean))];
    const amount = n => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n).toFixed(2) : "");

    const everyone = unique((data.people || []).map(idFor));
    for (const e of data.expenses || []) {
        const payer = idFor(e.payer) || everyone[0];
        if (!payer) continue;
        const exp = {
            id: uid(), name: String(e.name || "").trim() || t("defaultItem"), payer,
            mode: e.split === "itemized" ? "itemized" : "equal",
            amount: "", paidOverride: "", participants: [], items: [], receipt: null,
        };
        if (exp.mode === "equal") {
            const who = unique((e.participants || []).map(idFor));
            exp.participants = who.length ? who : everyone;
            exp.amount = amount(e.total);
            if (!toCents(exp.amount)) continue;
        } else {
            const items = (e.items || []).map(it => ({
                name: String(it.name || "").trim(),
                price: amount(it.price),
                people: unique((it.people || []).map(idFor)),
            })).filter(it => toCents(it.price));
            if (!items.length) continue;
            const group = unique(items.flatMap(it => it.people));
            exp.items = items.map(it => ({ id: uid(), ...it, people: it.people.length ? it.people : (group.length ? group : everyone) }));
            const itemsTotal = exp.items.reduce((a, it) => a + toCents(it.price), 0);
            if (toCents(e.total) && toCents(e.total) !== itemsTotal) exp.paidOverride = amount(e.total);
        }
        trip.expenses.push(exp);
    }
    if (!trip.title && data.title) trip.title = String(data.title).trim();
    return trip;
}

function aiFreshBase() {
    const cur = String(aiData?.currency || "").trim().slice(0, 4);
    return { ...emptyState(), currency: cur || state.currency };
}

function renderAiPreview() {
    const trip = mergeAiResult(aiData, aiFreshBase());
    const r = compute(trip);
    const fmt = c => `${c < 0 ? "-" : ""}${esc(trip.currency)}${(Math.abs(c) / 100).toFixed(2)}`;
    const tp = id => {
        const p = trip.people.find(x => x.id === id);
        return p ? `<span class="pill" style="--pc:${p.color}">${esc(p.name)}</span>` : "";
    };

    $("aiFound").textContent = t("aiFound", { people: trip.people.length, expenses: trip.expenses.length });

    const notes = (aiData.notes || []).filter(n => String(n).trim());
    const notesHtml = notes.length
        ? `<div class="ai-notes"><b>${t("aiNotes")}</b><ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>`
        : "";

    const expensesHtml = trip.expenses.map(exp => {
        const b = r.perExpense.get(exp.id);
        const sharers = trip.people.filter(p => b.shares.get(p.id) > 0);
        const splitText = exp.mode === "itemized" ? t("splitItems")
            : (sharers.length === trip.people.length ? t("splitEveryone") : t("splitN", { n: sharers.length }));
        const warn = exp.mode === "itemized" && b.itemsTotal !== b.total
            ? `<p class="warn">${t("warnDiff", { items: fmt(b.itemsTotal), diff: fmt(Math.abs(b.total - b.itemsTotal)) })}</p>` : "";
        return `
        <div class="ai-expense">
            <div class="expense-head">
                <div>
                    <b>${esc(exp.name)}</b>
                    <div class="expense-meta">${t("paidBy")} ${tp(exp.payer)} · ${splitText}</div>
                </div>
                <span class="expense-amount">${fmt(b.total)}</span>
            </div>
            <div class="share-chips">${sharers.map(p => `<span class="share-chip">${tp(p.id)} ${fmt(b.shares.get(p.id))}</span>`).join("")}</div>
            ${warn}
        </div>`;
    }).join("");

    const sharesHtml = `
        <div class="ai-shares">
            <h3>${t("aiShares")}</h3>
            <table>
                <thead><tr><th>${t("thName")}</th><th class="num">${t("thActual")}</th><th class="num">${t("thUpfront")}</th></tr></thead>
                <tbody>${trip.people.map((p, i) => `<tr><td>${tp(p.id)}</td><td class="num">${fmt(r.spent[i])}</td><td class="num">${fmt(r.paid[i])}</td></tr>`).join("")}</tbody>
                <tfoot><tr><td>${t("total")}</td><td class="num">${fmt(r.grandTotal)}</td><td></td></tr></tfoot>
            </table>
        </div>`;

    $("aiPreview").innerHTML = notesHtml + expensesHtml + sharesHtml;
}

function finishAi(newState) {
    state = newState;
    if (!commit()) return;
    aiData = null;
    aiImages = [];
    $("aiText").value = "";
    $("aiDialog").close();
    showTab("shared");
}

$("aiBtn").addEventListener("click", openAi);
$("aiCancelBtn").addEventListener("click", () => $("aiDialog").close());
$("aiReadBtn").addEventListener("click", runAi);
$("aiBackBtn").addEventListener("click", () => aiStep("input"));
$("aiAddBtn").addEventListener("click", () => finishAi(mergeAiResult(aiData, state)));
$("aiReplaceBtn").addEventListener("click", () => {
    if ((state.people.length || state.expenses.length) && !confirm(t("aiReplaceConfirm"))) return;
    finishAi(mergeAiResult(aiData, aiFreshBase()));
});

$("aiFiles").addEventListener("change", e => {
    addAiFiles([...e.target.files]);
    e.target.value = "";
});
$("aiThumbs").addEventListener("click", e => {
    const i = e.target.closest("[data-remove-ai-image]")?.dataset.removeAiImage;
    if (i === undefined) return;
    aiImages.splice(Number(i), 1);
    renderAiThumbs();
});

const drop = $("aiDrop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("over");
    addAiFiles([...e.dataTransfer.files]);
});

// Paste screenshots straight into the dialog (text pastes into the box as normal).
$("aiDialog").addEventListener("paste", e => {
    const files = [...(e.clipboardData?.items || [])]
        .filter(it => it.kind === "file" && it.type.startsWith("image/"))
        .map(it => it.getAsFile())
        .filter(Boolean);
    if (files.length) {
        e.preventDefault();
        addAiFiles(files);
    }
});

// ================= Export owed amounts as an image =================
// Drawn straight onto a canvas (always in the light theme) so it works offline and needs no library.
const IMG = {
    w: 1080, pad: 64, page: "#c8c0e2", card: "#ece8f5", bar: "#746895", line: "#d6cfe7", soft: "#e0dbee",
    text: "#3d3753", muted: "#6f6889", pos: "#2f7d4f", posBg: "#d7efe0", neg: "#a5531a", negBg: "#f8e3d1",
    font: '"Quicksand", system-ui, sans-serif',
};
let exportFormat = "png";

const moneyText = c => `${c < 0 ? "-" : ""}${state.currency}${(Math.abs(c) / 100).toFixed(2)}`;

function fitText(ctx, str, maxW) {
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 1 && ctx.measureText(str + "…").width > maxW) str = str.slice(0, -1);
    return str + "…";
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Lays the image out as a list of rows, then draws them; the canvas height follows the content.
function drawExport(canvas, who) {
    const r = lastResult;
    const people = state.people;
    const i = who === "all" ? -1 : (r.idx.get(who) ?? -1);
    const p = i >= 0 ? people[i] : null;
    const { w, pad } = IMG;
    const inner = w - pad * 2;
    const rows = [];   // { h, draw(ctx, y) }
    const font = (size, weight = 600) => `${weight} ${size}px ${IMG.font}`;
    const dot = (ctx, x, y, color, size = 22) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + size / 2, y, size / 2, 0, Math.PI * 2); ctx.fill();
    };
    const right = (ctx, text, x, y) => { ctx.textAlign = "right"; ctx.fillText(text, x, y); ctx.textAlign = "left"; };
    const sectionTitle = text => rows.push({ h: 72, draw(ctx, y) {
        ctx.fillStyle = IMG.text; ctx.font = font(32, 700); ctx.fillText(text, pad, y + 48);
    } });
    const rule = () => rows.push({ h: 2, draw(ctx, y) { ctx.fillStyle = IMG.line; ctx.fillRect(pad, y, inner, 2); } });
    const netColor = c => (c > 0 ? IMG.pos : c < 0 ? IMG.neg : IMG.muted);
    const transfers = r.simplified.filter(x => !p || x.from === p.id || x.to === p.id);

    if (!p) {
        // Everyone: one row per person with what they owe in total and their net.
        const cols = [inner * 0.56, inner * 0.78, inner];
        sectionTitle(t("tabOwe"));
        rows.push({ h: 48, draw(ctx, y) {
            ctx.font = font(22); ctx.fillStyle = IMG.muted;
            ctx.fillText(t("thName"), pad, y + 30);
            right(ctx, fitText(ctx, t("totalOwes"), inner * 0.21), pad + cols[1], y + 30);
            right(ctx, fitText(ctx, t("net"), inner * 0.2), pad + cols[2], y + 30);
        } });
        rule();
        people.forEach((q, k) => rows.push({ h: 72, draw(ctx, y) {
            dot(ctx, pad, y + 36, q.color);
            ctx.font = font(30); ctx.fillStyle = IMG.text;
            ctx.fillText(fitText(ctx, q.name, cols[0] - 48), pad + 38, y + 46);
            ctx.font = font(28, 500);
            right(ctx, moneyText(r.owes[k]), pad + cols[1], y + 46);
            ctx.font = font(28, 700); ctx.fillStyle = netColor(r.net[k]);
            right(ctx, moneyText(r.net[k]), pad + cols[2], y + 46);
        } }));
        rule();
        rows.push({ h: 44, draw(ctx, y) {
            ctx.font = font(20, 500); ctx.fillStyle = IMG.muted; ctx.fillText(`${t("net")} ${t("netHint")}`, pad, y + 32);
        } });
    } else {
        // One person: name, a net headline, then their two totals and the net.
        rows.push({ h: 96, draw(ctx, y) {
            dot(ctx, pad, y + 50, p.color, 36);
            ctx.font = font(52, 700); ctx.fillStyle = IMG.text;
            ctx.fillText(fitText(ctx, p.name, inner - 56), pad + 56, y + 68);
        } });
        rows.push({ h: 100, draw(ctx, y) {
            const c = r.net[i];
            const text = c > 0 ? t("getsBack", { amt: moneyText(c) }) : c < 0 ? t("owes", { amt: moneyText(-c) }) : t("allSquare");
            ctx.font = font(36, 700);
            const tw = Math.min(ctx.measureText(text).width, inner - 56);
            ctx.fillStyle = c > 0 ? IMG.posBg : c < 0 ? IMG.negBg : IMG.soft;
            roundRect(ctx, pad, y + 10, tw + 56, 68, 34); ctx.fill();
            ctx.fillStyle = netColor(c); ctx.fillText(fitText(ctx, text, inner - 56), pad + 28, y + 57);
        } });
        const stat = (label, value, color = IMG.text) => rows.push({ h: 72, draw(ctx, y) {
            ctx.font = font(28, 500); ctx.fillStyle = IMG.muted;
            ctx.fillText(fitText(ctx, label, inner * 0.62), pad, y + 46);
            ctx.font = font(30, 700); ctx.fillStyle = color;
            right(ctx, value, pad + inner, y + 46);
        } });
        rule();
        stat(t("totalOwes"), moneyText(r.owes[i]));
        stat(t("totalOwedTo"), moneyText(r.owedTo[i]));
        rule();
        stat(`${t("net")} ${t("netHint")}`, moneyText(r.net[i]), netColor(r.net[i]));
    }

    // Who pays whom (fewest transfers), limited to this person when exporting one person.
    rows.push({ h: 24, draw() {} });
    sectionTitle(t("imgSettle"));
    if (!transfers.length) {
        rows.push({ h: 64, draw(ctx, y) { ctx.font = font(28, 500); ctx.fillStyle = IMG.muted; ctx.fillText(t("imgNothing"), pad, y + 42); } });
    }
    transfers.forEach(x => rows.push({ h: 72, draw(ctx, y) {
        const from = people[r.idx.get(x.from)], to = people[r.idx.get(x.to)];
        let text, color;
        if (!p) { text = `${from.name} ${t("pays")} ${to.name}`; color = from.color; }
        else if (x.from === p.id) { text = t("imgOwesTo", { name: to.name }); color = to.color; }
        else { text = t("imgGetsFrom", { name: from.name }); color = from.color; }
        ctx.fillStyle = IMG.soft;
        roundRect(ctx, pad, y + 6, inner, 60, 30); ctx.fill();
        dot(ctx, pad + 20, y + 36, color);
        ctx.font = font(28); ctx.fillStyle = IMG.text;
        ctx.fillText(fitText(ctx, text, inner - 300), pad + 62, y + 46);
        ctx.font = font(30, 700);
        ctx.fillStyle = p ? (x.from === p.id ? IMG.neg : IMG.pos) : IMG.text;
        right(ctx, moneyText(x.amount), pad + inner - 28, y + 46);
    } }));

    // Size the canvas to fit, then paint the frame, header and rows.
    const headerH = 150, footerH = 72, margin = 32;
    const bodyH = rows.reduce((a, row) => a + row.h, 0);
    const h = margin * 2 + headerH + 24 + bodyH + footerH;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = IMG.page; ctx.fillRect(0, 0, w, h);
    ctx.save();
    roundRect(ctx, margin, margin, w - margin * 2, h - margin * 2, 36);
    ctx.fillStyle = IMG.card; ctx.fill();
    ctx.clip();
    ctx.fillStyle = IMG.bar; ctx.fillRect(margin, margin, w - margin * 2, headerH);
    ctx.restore();
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.font = font(24);
    ctx.fillText(t("appName"), pad, margin + 52);
    ctx.fillStyle = "#fff"; ctx.font = font(44, 700);
    ctx.fillText(fitText(ctx, state.title || t("tabOwe"), inner), pad, margin + 112);
    let y = margin + headerH + 24;
    rows.forEach(row => { row.draw(ctx, y); y += row.h; });
    ctx.font = font(20, 500); ctx.fillStyle = IMG.muted;
    const locale = window.I18n.getLang() === "ms" ? "ms-MY" : "en-GB";
    ctx.fillText(new Date().toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }), pad, h - margin - 30);
}

async function refreshExport() {
    try { await document.fonts.load(`600 30px ${IMG.font}`); } catch (_) { /* fall back to the system font */ }
    drawExport($("exportCanvas"), $("exportWho").value);
}

function openExport() {
    const sel = $("exportWho");
    const prev = sel.value;
    sel.innerHTML = `<option value="all">${esc(t("exportEveryone"))}</option>` +
        state.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    sel.value = [...sel.options].some(o => o.value === prev) ? prev : "all";
    if (!$("exportDialog").open) $("exportDialog").showModal();
    refreshExport();
}

function downloadExport() {
    const who = $("exportWho").value;
    const name = who === "all" ? (state.title || "everyone") : (person(who)?.name || "person");
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "splitbill";
    const ext = exportFormat === "jpeg" ? "jpg" : "png";
    $("exportCanvas").toBlob(blob => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${slug}-owed.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, `image/${exportFormat}`, 0.92);
}

$("exportImgBtn").addEventListener("click", openExport);
$("exportCancelBtn").addEventListener("click", () => $("exportDialog").close());
$("exportDownloadBtn").addEventListener("click", downloadExport);
$("exportWho").addEventListener("change", refreshExport);
$("exportFormat").addEventListener("click", e => {
    const b = e.target.closest("[data-format]");
    if (!b) return;
    exportFormat = b.dataset.format;
    $("exportFormat").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
});

// ================= Init =================
applyLanguage();
showTab(currentTab());
render();
