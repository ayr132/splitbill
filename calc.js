// Pure calculation logic (no DOM). Works in the browser (window.Calc) and in Node (require).
// All money is handled in integer cents to avoid floating-point drift.
(function (root) {
    const toCents = v => {
        const n = parseFloat(v);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
    };

    // Split `total` cents in proportion to `weights`, using largest-remainder rounding
    // so the parts always add up to exactly `total`.
    function distribute(total, weights) {
        const sum = weights.reduce((a, b) => a + b, 0);
        if (!sum || !total) return weights.map(() => 0);
        const exact = weights.map(w => (w * total) / sum);
        const out = exact.map(Math.floor);
        let left = total - out.reduce((a, b) => a + b, 0);
        exact
            .map((e, i) => [e - out[i], i])
            .sort((a, b) => b[0] - a[0])
            .forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
        return out;
    }

    // How one expense is shared out between people.
    // mode "equal":    exp.amount split evenly between exp.participants
    // mode "itemized": each item split evenly between its people; the bill total is
    //                  exp.paidOverride (receipt total) if given, else the item sum.
    function expenseBreakdown(exp, people) {
        const ids = people.map(p => p.id);
        const valid = new Set(ids);
        const weights = new Map(ids.map(id => [id, 0]));
        let total, itemsTotal = 0, unassigned = 0;

        if (exp.mode === "itemized") {
            for (const it of exp.items || []) {
                const c = toCents(it.price);
                itemsTotal += c;
                const who = (it.people || []).filter(id => valid.has(id));
                if (!who.length) {
                    // Nobody picked: the payer covers it.
                    unassigned += c;
                    if (valid.has(exp.payer)) weights.set(exp.payer, weights.get(exp.payer) + c);
                    continue;
                }
                who.forEach(id => weights.set(id, weights.get(id) + c / who.length));
            }
            total = toCents(exp.paidOverride) || itemsTotal;
        } else {
            total = toCents(exp.amount);
            let who = (exp.participants || []).filter(id => valid.has(id));
            if (!who.length && valid.has(exp.payer)) who = [exp.payer];
            who.forEach(id => weights.set(id, 1));
        }

        const parts = distribute(total, ids.map(id => weights.get(id)));
        return {
            total,
            itemsTotal,
            unassigned,
            shares: new Map(ids.map((id, i) => [id, parts[i]])),
        };
    }

    function compute(state) {
        const ids = state.people.map(p => p.id);
        const idx = new Map(ids.map((id, i) => [id, i]));
        const zeros = () => ids.map(() => 0);

        const matrix = ids.map(zeros);   // matrix[i][j] = what person i owes person j
        const paid = zeros();            // cost incurred (what they paid upfront)
        const spent = zeros();           // actual cost (their share of everything)
        const perExpense = new Map();
        let grandTotal = 0;

        for (const exp of state.expenses) {
            const b = expenseBreakdown(exp, state.people);
            perExpense.set(exp.id, b);
            grandTotal += b.total;
            const pj = idx.get(exp.payer);
            if (pj !== undefined) paid[pj] += b.total;
            b.shares.forEach((c, id) => {
                const i = idx.get(id);
                spent[i] += c;
                if (pj !== undefined && i !== pj) matrix[i][pj] += c;
            });
        }

        const owes = matrix.map(row => row.reduce((a, b) => a + b, 0));           // row totals (T2)
        const owedTo = ids.map((_, j) => matrix.reduce((a, row) => a + row[j], 0)); // column totals (T1)
        const net = ids.map((_, i) => owedTo[i] - owes[i]);                      // T1 - T2

        // Pairwise settlement: net out each pair of people separately.
        const pairwise = [];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const d = matrix[i][j] - matrix[j][i];
                if (d > 0) pairwise.push({ from: ids[i], to: ids[j], amount: d });
                else if (d < 0) pairwise.push({ from: ids[j], to: ids[i], amount: -d });
            }
        }

        // Fewest transfers: greedily match the biggest debtor with the biggest creditor.
        const debtors = [], creditors = [];
        net.forEach((n, i) => {
            if (n < 0) debtors.push({ id: ids[i], amt: -n });
            else if (n > 0) creditors.push({ id: ids[i], amt: n });
        });
        debtors.sort((a, b) => b.amt - a.amt);
        creditors.sort((a, b) => b.amt - a.amt);
        const simplified = [];
        let d = 0, c = 0;
        while (d < debtors.length && c < creditors.length) {
            const amt = Math.min(debtors[d].amt, creditors[c].amt);
            simplified.push({ from: debtors[d].id, to: creditors[c].id, amount: amt });
            debtors[d].amt -= amt;
            creditors[c].amt -= amt;
            if (!debtors[d].amt) d++;
            if (!creditors[c].amt) c++;
        }

        return { ids, idx, matrix, paid, spent, owes, owedTo, net, pairwise, simplified, perExpense, grandTotal };
    }

    const api = { toCents, distribute, expenseBreakdown, compute };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
