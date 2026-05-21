require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const ffmpegStatic = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const { Readable, PassThrough } = require("stream");
const Groq = require("groq-sdk");

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});
app.use(express.static("public"));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// In-memory session store
const sessions = {};

// Clean up sessions older than 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const id in sessions) {
        if (now - sessions[id].timestamp > 10 * 60 * 1000) {
            delete sessions[id];
        }
    }
}, 60 * 1000);

// Helper — converts text to Base64 PCM via Google Translate TTS
async function textToPCMBase64(text) {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=ja&client=tw-ob&speed=1.3`;
    const ttsRes = await fetch(ttsUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!ttsRes.ok) throw new Error("Google TTS failed: " + ttsRes.status);

    const mp3Buffer = Buffer.from(await ttsRes.arrayBuffer());
    const mp3Stream = Readable.from(mp3Buffer);
    const passthrough = new PassThrough();
    const pcmChunks = [];

    return new Promise((resolve, reject) => {
        const command = ffmpeg(mp3Stream)
            .inputFormat("mp3")
            .audioFrequency(44100)
            .audioChannels(1)
            .audioCodec("pcm_s16le")
            .format("s16le");

        command.on("error", (err) => {
            console.error("ffmpeg error:", err.message);
            reject(err);
        });

        command.pipe(passthrough);

        passthrough.on("data", chunk => pcmChunks.push(chunk));
        passthrough.on("end", () => {
            const pcmBuffer = Buffer.concat(pcmChunks);
            resolve(pcmBuffer.toString("base64"));
        });
        passthrough.on("error", reject);
    });
}

// Endpoint — raw TTS only (Base64 PCM)
app.post("/tts", async (req, res) => {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: "No text provided" });
    try {
        const audio = await textToPCMBase64(text);
        res.json({ audio, sampleRate: 44100 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint — Google TTS passthrough as streamable MP3
app.get("/gtts", async (req, res) => {
    const text = req.query.text;
    if (!text) return res.status(400).send("No text provided");

    try {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=ja&client=tw-ob`;
        const ttsRes = await fetch(ttsUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (!ttsRes.ok) throw new Error("Google TTS failed: " + ttsRes.status);

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Access-Control-Allow-Origin", "*");

        ttsRes.body.pipe(res);

    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

// Endpoint — poll session state (browser player polls this)
app.get("/session", (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "No session id" });

    res.setHeader("Access-Control-Allow-Origin", "*");

    // "latest" returns the most recent ready session
    if (id === "latest") {
        const ready = Object.values(sessions)
            .filter(s => s.ready)
            .sort((a, b) => b.timestamp - a.timestamp)[0];
        return res.json(ready || { ready: false });
    }

    const session = sessions[id];
    if (!session) return res.json({ ready: false });
    res.json(session);
});

// Endpoint — mark session as played
app.post("/session/played", (req, res) => {
    const { id } = req.body;
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (id === "latest") {
        // Mark the most recent ready session as played
        const latest = Object.values(sessions)
            .sort((a, b) => b.timestamp - a.timestamp)[0];
        if (latest) latest.ready = false;
    } else if (id && sessions[id]) {
        sessions[id].ready = false;
    }
    res.json({ ok: true });
});

// Endpoint — Groq AI response + session storage
app.post("/chat", async (req, res) => {
    const { playerMessage, conversationHistory, kateContext, sessionId } = req.body;
    if (!playerMessage) return res.status(400).json({ error: "No playerMessage provided" });
    if (!sessionId) return res.status(400).json({ error: "No sessionId provided" });

    try {
        const systemPrompt = `You are Kate, a 25-year-old woman who serves as both headmaster and sole teacher of Manabu High School — a private, essentially dead school that was her parents' legacy. The school has one enrolled student: Cruz, a newcomer who paid for a private course. That's the entire student body. Cruz is the player — Kate is speaking directly to Cruz in conversation.

Kate carries an AR-10 rifle as part of her daily routine. This is normal in her world — Japan in this universe has quirky laws that make this unremarkable. Cruz also carries a weapon. Nobody questions it.

Personality:
- Motherly in a calm, grounded way — not overbearing, not cutesy
- Introverted but not cold — she engages when engaged
- Direct and on-point like a guy would be. No fluff, no roundabout phrasing
- Dry humor — she's funny without trying to be, which makes it funnier
- Curious and passionate about learning, though she won't admit it dramatically
- No strong food preferences. Eats whatever. Doesn't care enough to have a favorite
- Hobbies: guns, teaching, and whatever rabbit hole she's currently reading about

Appearance context: From 7:00 to 16:00 she wears formal sensei attire. Outside those hours, casual.

Language rules:
- Kate speaks in English by default
- If the player initiates Japanese, Kate switches and engages in Japanese
- Always include romaji alongside any Japanese text — format like: こんにちは (Konnichiwa)
- No English translation needed — romaji is enough for the learning layer
- Keep responses 1–2 sentences. She's direct, not a lecturer
- Humor is welcome but never forced — dry and situational beats loud jokes
- Never break character. She has no idea she's an NPC or in a game
- If asked something bizarre, she responds with flat curiosity rather than confusion

Current situation: ${kateContext || "Kate is somewhere in Manabu High School, probably between doing something and doing nothing."}`;

        const messages = [
            ...(conversationHistory || []),
            { role: "user", content: playerMessage }
        ];

        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                { role: "system", content: systemPrompt },
                ...messages
            ],
            max_tokens: 150
        });

        const responseText = completion.choices[0].message.content;
        const japaneseOnly = responseText.split("(")[0].trim();

        const audioUrl = `/gtts?text=${encodeURIComponent(japaneseOnly)}`;

        sessions[sessionId] = {
            text: responseText,
            audioText: japaneseOnly,
            audioUrl,
            ready: true,
            timestamp: Date.now()
        };

        res.json({
            text: responseText,
            audioText: japaneseOnly,
            sessionId
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server kept alive):", err.message);
});

app.listen(3000, () => console.log("Kate proxy running on port 3000"));