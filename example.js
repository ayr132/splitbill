// Example trip with made-up names, for trying out the app.
(function (root) {
    const all = ["adam", "farah", "chong", "priya"];
    const EXAMPLE = {
        title: "Trip hujung minggu",
        currency: "RM",
        people: [
            { id: "adam", name: "adam", color: "#d8a7c0" },
            { id: "farah", name: "farah", color: "#f8c99a" },
            { id: "chong", name: "chong", color: "#b6d7a8" },
            { id: "priya", name: "priya", color: "#a2c4c9" },
        ],
        expenses: [
            {
                id: "fowlboys", name: "fowl boys", payer: "adam", mode: "itemized",
                paidOverride: "200.90", amount: "", participants: [], receipt: null,
                items: [
                    { id: "f1", name: "tenders", price: "20.90", people: all },
                    { id: "f2", name: "6pcs wings", price: "28.00", people: all },
                    { id: "f3", name: "serv tax", price: "10.39", people: all },
                    { id: "f4", name: "serv chg", price: "17.32", people: all },
                    { id: "f5", name: "major buffalo, fries, iced tea, +cheese", price: "39.50", people: ["adam"] },
                    { id: "f6", name: "chicken & waffle", price: "30.90", people: ["farah"] },
                    { id: "f7", name: "sugar daddy", price: "24.50", people: ["chong"] },
                    { id: "f8", name: "motherclucker", price: "29.40", people: ["priya"] },
                ],
            },
            {
                id: "mamak", name: "mamak", payer: "farah", mode: "itemized",
                paidOverride: "", amount: "", participants: [], receipt: null,
                items: [
                    { id: "m1", name: "kopi / teh tarik ×4", price: "8.00", people: all },
                    { id: "m2", name: "telur mata ×4", price: "6.00", people: all },
                    { id: "m3", name: "maggi goreng ×3", price: "17.40", people: ["adam", "chong", "priya"] },
                    { id: "m4", name: "nasi goreng kampung", price: "7.50", people: ["farah"] },
                ],
            },
            { id: "minyak", name: "minyak kete", payer: "chong", mode: "equal", amount: "20.00", participants: all, items: [], receipt: null },
            { id: "sewa", name: "sewa kete", payer: "adam", mode: "equal", amount: "70.00", participants: all, items: [], receipt: null },
            { id: "sukiya", name: "sukiya", payer: "adam", mode: "equal", amount: "245.00", participants: all, items: [], receipt: null },
            { id: "karaoke", name: "manekineko karaoke", payer: "adam", mode: "equal", amount: "113.30", participants: all, items: [], receipt: null },
        ],
    };
    if (typeof module !== "undefined" && module.exports) module.exports = EXAMPLE;
    else root.EXAMPLE_TRIP = EXAMPLE;
})(typeof window !== "undefined" ? window : globalThis);
