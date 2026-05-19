const express = require("express");
const fetch = require("node-fetch");
const ffmpegStatic = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const { Readable, PassThrough } = require("stream");

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json());

app.post("/tts", async (req, res) => {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: "No text provided" });

    try {
        // 1. Fetch MP3 from Google Translate TTS
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=ja&client=tw-ob`;
        const ttsRes = await fetch(ttsUrl, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (!ttsRes.ok) throw new Error("Google TTS fetch failed: " + ttsRes.status);

        const mp3Buffer = Buffer.from(await ttsRes.arrayBuffer());

        // 2. Convert MP3 → raw PCM (16-bit signed, 44100Hz, mono)
        const mp3Stream = Readable.from(mp3Buffer);
        const passthrough = new PassThrough();
        const pcmChunks = [];

        ffmpeg(mp3Stream)
            .inputFormat("mp3")
            .audioFrequency(44100)
            .audioChannels(1)
            .audioCodec("pcm_s16le")
            .format("s16le")
            .pipe(passthrough);

        passthrough.on("data", chunk => pcmChunks.push(chunk));
        passthrough.on("end", () => {
            const pcmBuffer = Buffer.concat(pcmChunks);
            const base64 = pcmBuffer.toString("base64");
            res.json({ audio: base64, sampleRate: 44100 });
        });

        passthrough.on("error", err => {
            console.error("ffmpeg error:", err);
            res.status(500).json({ error: "ffmpeg conversion failed" });
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log("Kate proxy running on port 3000"));