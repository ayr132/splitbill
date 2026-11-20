// Vercel serverless function: POST /api/parse
// Reads shared-spending notes (text and/or images) with DeepSeek and returns
// structured expenses for the Split Bill app.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   DEEPSEEK_API_KEY  required, from platform.deepseek.com → API Keys
//   DEEPSEEK_MODEL    optional, defaults to deepseek-flash (needs image input)

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const MAX_IMAGES = 4;
const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 100 * 1024; // 100 KB per image
const MAX_IMAGE_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4; // same limit in base64 characters
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// DeepSeek's JSON mode guarantees valid JSON but not a schema, so the shape is spelled out in the prompt.
const SHAPE = `Reply with only a JSON object of this shape:
{
  "title": string,
  "currency": string,
  "people": [string],
  "expenses": [{
    "name": string,
    "payer": string,
    "split": "equal" | "itemized",
    "total": number,
    "participants": [string],
    "items": [{ "name": string, "price": number, "people": [string] }]
  }],
  "notes": [string]
}`;

const SYSTEM = `You turn a group's shared-spending notes into data for a bill-splitting app. The input can be a screenshot of notes, a receipt photo, a chat message or plain text, in English, Malay or a mix of both (for example "kongsi" means shared, "sorang" means each person, "bayar" means paid, "semua" means everyone).

How to fill the fields:
- title: the trip or event name and date if given, otherwise "".
- currency: the symbol used, written as the app shows it (for example "RM" for rm or ringgit).
- people: everyone mentioned, each name spelled the same way every time it appears.
- expenses: one per bill or payment, with payer set to the person who paid it.
  - split "equal" when an amount is simply divided. total is that amount. participants lists who shares it; when the note says equally, all or semua, or names no one, list everyone in people. Leave items empty.
  - split "itemized" when the bill says who had what. Each line becomes an item with its price and the people who share it. Shared lines (kongsi, share, all) and charges such as tax, SST or service charge belong to everyone involved in that bill: the people named in the bill's heading, or else everyone who has an item in it. total is the bill total as written, or 0 if none is given. Leave participants empty.
- Amounts are plain numbers ("rm12" becomes 12).
- notes: short points the user should check, such as items that don't add up to the written total, an unclear payer or an unreadable amount. Use [] when everything is clear.

Only use amounts that appear in the input. When something is unclear, give your best reading and mention it in notes.

${SHAPE}`;

function apiMessage(body, status) {
    return String(body?.error?.message || body?.message || `HTTP ${status}`);
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "bad_input" });
    }
    if (!process.env.DEEPSEEK_API_KEY) {
        return res.status(500).json({ error: "not_configured" });
    }

    // ---- Validate input ----
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const images = Array.isArray(body.images) ? body.images : [];
    const notesLang = body.lang === "ms" ? "Malay" : "English";

    const imagesOk = images.length <= MAX_IMAGES && images.every(img =>
        img && IMAGE_TYPES.has(img.mediaType) && typeof img.data === "string" && img.data.length > 0);
    if ((!text && !images.length) || text.length > MAX_TEXT || !imagesOk) {
        return res.status(400).json({ error: "bad_input" });
    }
    if (images.some(img => img.data.length > MAX_IMAGE_B64)) {
        return res.status(413).json({ error: "image_too_large" });
    }

    const content = [
        ...images.map(img => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
        {
            type: "text",
            text: `${text ? `Notes:
${text}

` : ""}Extract the shared expenses${images.length ? " from the image(s) above" : ""}. Write the notes in ${notesLang}. Answer in JSON.`,
        },
    ];

    // ---- Call DeepSeek ----
    try {
        const apiRes = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content },
                ],
                response_format: { type: "json_object" },
                max_tokens: 8192,
            }),
        });
        const result = await apiRes.json().catch(() => null);

        if (!apiRes.ok) {
            const msg = apiMessage(result, apiRes.status);
            console.error(`DeepSeek API error ${apiRes.status}:`, msg);
            if (apiRes.status === 401 || apiRes.status === 403) {
                return res.status(500).json({ error: "not_configured" });
            }
            if (apiRes.status === 429) {
                return res.status(429).json({ error: "rate_limited" });
            }
            if (apiRes.status === 400 || apiRes.status === 404 || apiRes.status === 422) {
                // Pass the API's reason back so problems are visible without digging through logs.
                return res.status(400).json({ error: "ai_bad_request", detail: msg.slice(0, 300) });
            }
            return res.status(502).json({ error: "failed", detail: `DeepSeek ${apiRes.status}: ${msg.slice(0, 200)}` });
        }

        const choice = result?.choices?.[0];
        const finish = choice?.finish_reason;
        const answer = choice?.message?.content;
        if (finish === "content_filter") {
            return res.status(422).json({ error: "refused" });
        }
        if (finish === "length") {
            return res.status(422).json({ error: "bad_input" });
        }
        if (!answer) {
            console.error("DeepSeek returned no text. finish_reason:", finish);
            return res.status(502).json({ error: "failed", detail: `empty answer from ${MODEL} (${finish || "no finish reason"})` });
        }

        let data;
        try {
            data = JSON.parse(answer);
        } catch (_) {
            console.error("DeepSeek returned invalid JSON:", answer.slice(0, 500));
            return res.status(502).json({ error: "failed", detail: `${MODEL} returned unreadable data` });
        }
        if (!Array.isArray(data.people) || !Array.isArray(data.expenses)) {
            return res.status(502).json({ error: "failed", detail: `${MODEL} returned data in the wrong shape` });
        }
        return res.status(200).json(data);
    } catch (error) {
        console.error("parse failed:", error);
        return res.status(500).json({ error: "failed", detail: String(error?.message || error).slice(0, 200) });
    }
}
