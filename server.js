import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import stringSimilarity from "string-similarity";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let users = {};

// -------- HELPERS --------

function clean(msg) {
  if (!msg) return "";
  return msg.toLowerCase().trim();
}

function capitalize(str) {
  return str
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isValidPhone(phone) {
  return phone && phone.match(/^\d{7,}$/);
}

function isValidAddress(addr) {
  if (!addr) return false;
  if (addr.length < 4) return false;
  if (addr.match(/^\d+$/)) return false;
  if (!addr.match(/\d/) && !addr.match(/gatan|vägen|väg|plan|gränd/)) return false;
  return true;
}

// -------- FALLBACK --------

function fallbackProblem(msg) {
  const problems = [
    { words: ["läcka", "läck", "dropp"], label: "Vattenläcka" },
    { words: ["stopp", "avlopp"], label: "Stopp i avlopp" },
    { words: ["handfat", "kran"], label: "Problem med handfat" }
  ];

  for (let p of problems) {
    for (let word of msg.split(" ")) {
      for (let w of p.words) {
        if (stringSimilarity.compareTwoStrings(word, w) > 0.7) {
          return p.label;
        }
      }
    }
  }

  return null;
}

// -------- AI EXTRACTION --------

async function extractWithAI(message) {
  if (!message || message.length < 3) return {};

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `
You are a Swedish plumbing assistant.

Extract structured booking info.

Return ONLY JSON:

{
  "name": string or null,
  "phone": string or null,
  "address": string or null,
  "time": string or null,
  "problem": short label in Swedish,
  "details": detailed explanation in Swedish,
  "urgency": "low" | "medium" | "high"
}

Do not invent data.
`
        },
        { role: "user", content: message }
      ]
    });

    return JSON.parse(res.choices[0].message.content);

  } catch {
    return {};
  }
}

// -------- HUMAN RESPONSE --------

async function humanReply(context) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 80,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
You are a friendly Swedish plumbing assistant.

Rules:
- Natural tone
- Short (1 sentence)
- Warm but professional
- Max 1 emoji
`
        },
        {
          role: "user",
          content: context
        }
      ]
    });

    return res.choices[0].message.content;

  } catch {
    return null;
  }
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message;
    const msg = clean(raw);
    const userId = req.body.userId || Math.random().toString(36);

    if (!msg) {
      return res.json({
        replies: ["Jag är kvar här 🙂 Vad behöver du hjälp med?"]
      });
    }

    if (!users[userId]) {
      users[userId] = { step: "problem" };
    }

    let state = users[userId];
    state.lastActive = Date.now();

    // AI extraction
    let aiData = await extractWithAI(raw);

    if (!aiData.problem) {
      aiData.problem = fallbackProblem(msg);
    }

    // validation
    if (aiData.phone && !isValidPhone(aiData.phone)) {
      aiData.phone = null;
    }

    if (aiData.address && !isValidAddress(aiData.address)) {
      aiData.address = null;
    }

    // save
    if (aiData.problem && !state.problem) state.problem = aiData.problem;
    if (aiData.details && !state.details) state.details = aiData.details;
    if (aiData.name && !state.name) state.name = capitalize(aiData.name);
    if (aiData.phone && !state.phone) state.phone = aiData.phone;
    if (aiData.address && !state.address) state.address = capitalize(aiData.address);
    if (aiData.time && !state.time) state.time = aiData.time;

    if (msg.includes("nej")) {
      users[userId] = { step: "problem" };
      return res.json({
        replies: ["Okej, vi börjar om 😊 Vad behöver du hjälp med?"]
      });
    }

    if (state.done) {
      return res.json({
        replies: ["Din bokning är redan registrerad 👍"]
      });
    }

    // FLOW

    if (state.step === "problem") {
      if (!state.problem) {
        return res.json({
          replies: ["Kan du beskriva problemet lite kort?"]
        });
      }

      state.step = "name";

      const reply = await humanReply(
        `User has problem: ${state.problem}. Ask for name.`
      );

      return res.json({
        replies: [reply || "Vad heter du?"]
      });
    }

    if (state.step === "name") {
      if (!state.name) {
        return res.json({
          replies: ["Vad heter du?"]
        });
      }

      state.step = "phone";

      const reply = await humanReply(
        `User name is ${state.name}. Ask for phone number.`
      );

      return res.json({
        replies: [reply || `Vad är ditt telefonnummer?`]
      });
    }

    if (state.step === "phone") {
      if (!isValidPhone(state.phone)) {
        return res.json({
          replies: ["Skriv ett giltigt telefonnummer 🙂"]
        });
      }

      state.step = "address";

      const reply = await humanReply(`Ask for address politely`);

      return res.json({
        replies: [reply || "Vilken adress gäller det?"]
      });
    }

    if (state.step === "address") {
      if (!isValidAddress(state.address)) {
        return res.json({
          replies: ["Skriv en giltig adress 🙂"]
        });
      }

      state.step = "time";

      const reply = await humanReply(`Ask for booking time`);

      return res.json({
        replies: [reply || "När passar det för dig?"]
      });
    }

    if (state.step === "time") {
      if (!state.time) {
        return res.json({
          replies: ["Vilken tid passar dig?"]
        });
      }

      state.step = "confirm";

      return res.json({
        replies: [
          "Perfekt 👍 Här är det jag har:",
          `Problem: ${state.problem}`,
          state.details ? `Detaljer: ${state.details}` : null,
          `Namn: ${state.name}`,
          `Telefon: ${state.phone}`,
          `Adress: ${state.address}`,
          `Tid: ${state.time}`,
          "Stämmer detta? (ja/nej)"
        ].filter(Boolean)
      });
    }

    if (state.step === "confirm") {
      if (msg.includes("ja")) {
        fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");

        state.done = true;

        return res.json({
          replies: [
            `Tack ${state.name}!`,
            "Din bokning är registrerad 👍",
            "Vi kontaktar dig snart."
          ]
        });
      }

      return res.json({
        replies: ["Skriv 'ja' eller 'nej' 🙂"]
      });
    }

    return res.json({
      replies: ["Något gick fel 🤔"]
    });

  } catch (err) {
    console.error(err);
    return res.json({
      replies: ["Något gick fel 🤔 Försök igen."]
    });
  }
});

// ping
app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 HUMAN AI BOT RUNNING");
});