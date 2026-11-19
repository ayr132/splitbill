// Vercel serverless function: POST /api/parse
// Reads shared-spending notes (text and/or images) with Google Gemini and returns
// structured expenses for the Split Bill app.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY  required, from Google AI Studio → API Keys
//   GEMINI_MODEL    optional, defaults to gemini-3.8-flash
import { GoogleGenAI, ApiError } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_IMAGES = 4;
const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 100 * 1024; // 100 KB per image
const MAX_IMAGE_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4; // same limit in base64 characters
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["title", "currency", "people", "expenses", "notes"],
    properties: {
        title: { type: "string" },
        currency: { type: "string" },
        people: { type: "array", items: { type: "string" } },
        expenses: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "payer", "split", "total", "participants", "items"],
                properties: {
                    name: { type: "string" },
                    payer: { type: "string" },
                    split: { type: "string", enum: ["equal", "itemized"] },
                    total: { type: "number" },
                    participants: { type: "array", items: { type: "string" } },
                    items: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["name", "price", "people"],
                            properties: {
                                name: { type: "string" },
                                price: { type: "number" },
                                people: { type: "array", items: { type: "string" } },
                            },
                        },
                    },
                },
            },
        },
        notes: { type: "array", items: { type: "string" } },
    },
};

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

Only use amounts that appear in the input. When something is unclear, give your best reading and mention it in notes.`;

// Gemini errors carry the API's JSON body as the message; pull out the readable sentence.
function apiMessage(error) {
    try {
        return JSON.parse(error.message).error.message || error.message;
    } catch (_) {
        return String(error.message);
    }
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "bad_input" });
    }
    if (!process.env.GEMINI_API_KEY) {
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

    const parts = [
        ...images.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
        {
            text: `${text ? `Notes:\n${text}\n\n` : ""}Extract the shared expenses${images.length ? " from the image(s) above" : ""}. Write the notes in ${notesLang}.`,
        },
    ];

    // ---- Call Gemini ----
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts }],
            config: {
                systemInstruction: SYSTEM,
                responseMimeType: "application/json",
                responseJsonSchema: SCHEMA,
            },
        });

        const finish = response.candidates?.[0]?.finishReason;
        if (response.promptFeedback?.blockReason || finish === "SAFETY") {
            return res.status(422).json({ error: "refused" });
        }
        if (finish === "MAX_TOKENS") {
            return res.status(422).json({ error: "bad_input" });
        }
        if (!response.text) return res.status(502).json({ error: "failed" });

        const data = JSON.parse(response.text);
        if (!Array.isArray(data.people) || !Array.isArray(data.expenses)) {
            return res.status(502).json({ error: "failed" });
        }
        return res.status(200).json(data);
    } catch (error) {
        if (error instanceof ApiError) {
            console.error(`Gemini API error ${error.status}:`, error.message);
            if (error.status === 401 || error.status === 403 || /API_KEY_INVALID/.test(error.message)) {
                return res.status(500).json({ error: "not_configured" });
            }
            if (error.status === 429) {
                return res.status(429).json({ error: "rate_limited" });
            }
            if (error.status === 400 || error.status === 404) {
                // Pass the API's reason back so problems are visible without digging through logs.
                return res.status(400).json({ error: "ai_bad_request", detail: apiMessage(error).slice(0, 300) });
            }
            return res.status(502).json({ error: "failed" });
        }
        console.error("parse failed:", error);
        return res.status(500).json({ error: "failed" });
    }
}
