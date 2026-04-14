import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let users = {};

// -------- HELPERS --------

function clean(msg) {
  return msg?.toString().trim().toLowerCase().slice(0, 500) || "";
}

function capitalize(str) {
  if (!str) return "";
  return str
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+46")) cleaned = "0" + cleaned.slice(3);
  return cleaned;
}

function isValidPhone(phone) {
  return typeof phone === "string" && /^\d{7,15}$/.test(phone);
}

function isValidAddress(addr) {
  return typeof addr === "string" && addr.length > 4 && /\d/.test(addr);
}

// -------- AI EXTRACT --------

async function aiExtract(message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "Return ONLY valid JSON." },
        {
          role: "user",
          content: `
{
  "problem": "",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Message: "${message}"
`
        }
      ]
    });

    const text = res.choices?.[0]?.message?.content || "{}";
    return JSON.parse(text);

  } catch {
    return {};
  }
}

// -------- AI REPLY --------

async function generateReply(state, message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: `
Du är en erfaren rörmokare i Stockholm som chattar med kunder.

TON:
- Avslappnad (som SMS)
- Låter som en riktig hantverkare
- Kort (1–2 meningar)
- Ställ EN fråga

MÅL:
- Förstå problemet snabbt
- Sedan boka så smidigt som möjligt

REGLER:
- Säg aldrig "hej" eller "tja" igen efter första meddelandet
- Börja aldrig om konversationen
- Upprepa inte kunden

PROBLEMLOGIK:

- Ställ MAX EN följdfråga om problemet
- När du fått svar → SLUTA analysera
- Gå vidare direkt till bokning

- Fokusera inte på detaljerad felsökning
- Du bokar, inte löser allt i chatten

EXEMPEL:

"Min dusch läcker"
→ "Okej 👍 droppar det eller rinner det hela tiden?"

"Det rinner hela tiden"
→ "Okej 👍 då fixar vi det — vad heter du?"

---

HANTERA TVEKAN:

Om kunden säger:
"vet inte", "kanske", "sen"

→ Lugna + gör det enkelt + fortsätt framåt

EXEMPEL:

"ingen stress 👍 vi kan bara lägga in något preliminärt — vad gäller det?"

"lugnt 👍 vill du att vi ringer dig istället?"

---

FLOW:

1. Problem
2. MAX 1 följdfråga
3. Namn
4. Telefon
5. Adress
6. Tid

---

VIKTIGT:

- Ställ aldrig fler än 1 följdfråga om problemet
- Fastna aldrig i analys
- När problemet är tydligt → gå vidare direkt

---

INFO:

Problem: ${state.problem || "saknas"}
Namn: ${state.name || "saknas"}
Telefon: ${state.phone || "saknas"}
Adress: ${state.address || "saknas"}
Tid: ${state.time || "saknas"}
`
        },
        { role: "user", content: message }
      ]
    });

    return res.choices?.[0]?.message?.content || "Okej 👍";

  } catch {
    return "Okej 👍";
  }
}

// -------- EMAIL --------

const transporter = nodemailer.createTransport({
  host: "smtp.one.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendBookingEmail(data) {
  console.log("BOOKING EMAIL:", data);

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.BOOKING_EMAIL || process.env.EMAIL_USER,
    subject: "🚨 Ny Bokning",
    text: `
Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${data.time}
    `
  });
}

async function sendCallRequest(data) {
  console.log("CALL REQUEST:", data);

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.BOOKING_EMAIL || process.env.EMAIL_USER,
    subject: "📞 Ring upp kund",
    text: `
Kund vill bli uppringd!

Namn: ${data.name || "okänd"}
Telefon: ${data.phone || "saknas"}
Problem: ${data.problem || "okänt"}
    `
  });
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message || "";
    const msg = clean(raw);
    const userId = req.body.userId || Math.random().toString(36);

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    console.log("MSG:", msg);

    // -------- GREETING --------

    if (msg === "hej" || msg === "tja") {
      return res.json({
        replies: ["Tja 👍 vad har hänt?"]
      });
    }

    // -------- CONTACT REQUEST --------

    if (msg.match(/ring|ringa|kontakta/i)) {
      await sendCallRequest(state);

      return res.json({
        replies: [
          "Perfekt 👍 vi ringer upp dig så snart vi kan!"
        ]
      });
    }

    // -------- HESITATION HANDLING --------

    if (msg.match(/vet inte|kanske|sen/i)) {

      if (!state.problem) {
        return res.json({
          replies: ["Ingen stress 👍 vad är det som strular?"]
        });
      }

      if (state.problem && !state.name) {
        return res.json({
          replies: ["Lugnt 👍 vill du att vi ringer dig istället?"]
        });
      }
    }

    // -------- AI EXTRACT --------

    const data = await aiExtract(raw);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    let phone = normalizePhone(data.phone || raw);
    if (!state.phone && isValidPhone(phone)) state.phone = phone;

    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }

    if (data.time && !state.time) state.time = data.time;

    // -------- FALLBACK --------

    if (!state.problem && msg.length > 3 && !msg.match(/hej|tja/i)) {
      state.problem = msg;
    }

    console.log("STATE:", state);

    // -------- BOOKING --------

    if (state.problem && state.name && state.phone && state.address && state.time) {

      await sendBookingEmail(state);

      users[userId] = {};

      return res.json({
        replies: [
          `Perfekt 👍 vi bokar in dig på ${state.time}. Vi hör av oss snart!`
        ]
      });
    }

    // -------- AI RESPONSE --------

    const reply = await generateReply(state, raw);

    return res.json({
      replies: [reply]
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.json({
      replies: ["⚠️ Något gick fel"]
    });
  }
});

// -------- HEALTH --------

app.get("/", (req, res) => {
  res.send("🔥 Server running");
});

app.listen(process.env.PORT || 3000);