// Vercel serverless function: POST /api/parse
// Reads shared-spending notes (text and/or images) with Claude and returns
// structured expenses for the Split Bill app.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY      required
//   SPLITBILL_ACCESS_CODE  optional; if set, callers must send it in the x-access-code header
import { timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const MAX_IMAGES = 4;
const MAX_TEXT = 20000;
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // per image, base64 characters
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

function codeMatches(given, expected) {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({ error: "bad_input" });
    }

    const accessCode = process.env.SPLITBILL_ACCESS_CODE;
    if (accessCode && !codeMatches(req.headers["x-access-code"], accessCode)) {
        return res.status(401).json({ error: "unauthorized" });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: "not_configured" });
    }

    // ---- Validate input ----
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const images = Array.isArray(body.images) ? body.images : [];
    const notesLang = body.lang === "ms" ? "Malay" : "English";

    const imagesOk = images.length <= MAX_IMAGES && images.every(img =>
        img && IMAGE_TYPES.has(img.mediaType) &&
        typeof img.data === "string" && img.data.length > 0 && img.data.length <= MAX_IMAGE_B64);
    if ((!text && !images.length) || text.length > MAX_TEXT || !imagesOk) {
        return res.status(400).json({ error: "bad_input" });
    }

    const content = [
        ...images.map(img => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.data },
        })),
        {
            type: "text",
            text: `${text ? `Notes:\n${text}\n\n` : ""}Extract the shared expenses${images.length ? " from the image(s) above" : ""}. Write the notes in ${notesLang}.`,
        },
    ];

    // ---- Call Claude ----
    try {
        const client = new Anthropic();
        const response = await client.beta.messages.create({
            model: "claude-opus-5-5",
            max_tokens: 16000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: SYSTEM,
            output_config: {
                effort: "medium",
                format: { type: "json_schema", schema: SCHEMA },
            },
            messages: [{ role: "user", content }],
        });

        if (response.stop_reason === "refusal") {
            return res.status(422).json({ error: "refused" });
        }
        if (response.stop_reason === "max_tokens") {
            return res.status(422).json({ error: "bad_input" });
        }
        const block = response.content.find(b => b.type === "text");
        if (!block) return res.status(502).json({ error: "failed" });

        const data = JSON.parse(block.text);
        if (!Array.isArray(data.people) || !Array.isArray(data.expenses)) {
            return res.status(502).json({ error: "failed" });
        }
        return res.status(200).json(data);
    } catch (error) {
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
            console.error("Anthropic auth error:", error.message);
            return res.status(500).json({ error: "not_configured" });
        }
        if (error instanceof Anthropic.RateLimitError) {
            return res.status(429).json({ error: "rate_limited" });
        }
        if (error instanceof Anthropic.BadRequestError) {
            console.error("Anthropic bad request:", error.message);
            return res.status(400).json({ error: "bad_input" });
        }
        if (error instanceof Anthropic.APIError) {
            console.error(`Anthropic API error ${error.status}:`, error.message);
            return res.status(502).json({ error: "failed" });
        }
        console.error("parse failed:", error);
        return res.status(500).json({ error: "failed" });
    }
}
