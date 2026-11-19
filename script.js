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
        return;
    }

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

// ================= Init =================
applyLanguage();
showTab(currentTab());
render();
