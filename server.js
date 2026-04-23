import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Johanneshovrör";
const OWNER_EMAIL = process.env.BOOKING_EMAIL || process.env.EMAIL_USER;

// -------- AI --------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function aiReply(state, userMessage, instruction) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: `
Du är en trevlig svensk rörmokare.

- Svara kort (1 mening)
- Låter naturlig
- Max 1 emoji
- Ställ max en fråga

Kundinfo:
Problem: ${state.problem || "okänt"}
`
        },
        {
          role: "user",
          content: `${userMessage}\n\nInstruction: ${instruction}`
        }
      ]
    });

    return res.choices[0].message.content;

  } catch (err) {
    console.error("AI error:", err.message);
    return null;
  }
}

async function aiEnhance(state, msg, fallback, instruction) {
  const reply = await aiReply(state, msg, instruction);
  return reply || fallback;
}

function isUrgent(text) {
  return text.match(/akut|sprutar|forsar|översvämning|panik/i);
}

// -------- MEMORY --------

let users = {};

try {
  const data = fs.readFileSync("memory.json", "utf-8");
  users = JSON.parse(data);
} catch {
  users = {};
}

function saveMemory() {
  fs.writeFileSync("memory.json", JSON.stringify(users, null, 2));
}

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

function detectIntent(msg) {
  if (msg.match(/\b(ja|gärna|ok|kör|absolut)\b/i)) return "yes";
  if (msg.match(/\b(nej|inte|sen|inte än)\b/i)) return "no";
  if (msg.match(/\b(ring|kontakta)\b/i)) return "contact";
  if (msg.match(/\?/)) return "question";
  if (msg.match(/vet inte|kanske/i)) return "hesitation";
  return "normal";
}

function smartFollowUp(problem = "") {
  const text = problem.toLowerCase();

  if (text.includes("läcker")) {
    return "Okej 👍 rinner det hela tiden eller bara lite?";
  }

  if (text.includes("stopp")) {
    return "Okej 👍 är det helt stopp eller rinner det undan lite?";
  }

  return "Okej 👍 kan du beskriva lite mer?";
}

// -------- DATE --------

function parseSwedishDateTime(text) {
  const now = new Date();
  let date = new Date(now);

  if (/imorgon/i.test(text)) {
    date.setDate(now.getDate() + 1);
  }

  const match = text.match(/(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  date.setHours(parseInt(match[1]));
  date.setMinutes(parseInt(match[2] || "0"));
  return date;
}

// -------- EMAIL --------

const transporter = nodemailer.createTransport({
  host: "send.one.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendBookingEmail(data) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: OWNER_EMAIL,
    subject: `🚨 Ny bokning - ${BUSINESS_NAME}`,
    text: `
Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${new Date(data.time).toLocaleString("sv-SE")}
`
  });
}

async function sendCallRequest(data) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: OWNER_EMAIL,
    subject: `📞 Ring upp kund`,
    text: `
Telefon: ${data.phone}
Tid: ${data.callTime}
Problem: ${data.problem || "okänt"}
`
  });
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message || "";
    const msg = clean(raw);
    const intent = detectIntent(msg);

    const userId = req.body.userId || "default-user";

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // -------- AI UNDERSTANDING --------
    try {
      const aiData = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "Extract structured data from Swedish message."
          },
          {
            role: "user",
            content: `
Extract:

- problem
- name
- phone
- address
- time

Return ONLY JSON:
{
  "problem": "",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Message: "${raw}"
`
          }
        ]
      });

      const parsed = JSON.parse(aiData.choices[0].message.content);

      if (parsed.problem && !state.problem) state.problem = parsed.problem;
      if (parsed.name && !state.name) state.name = capitalize(parsed.name);
      if (parsed.phone && !state.phone) state.phone = normalizePhone(parsed.phone);
      if (parsed.address && !state.address) state.address = capitalize(parsed.address);

      if (parsed.time && !state.time) {
        const t = parseSwedishDateTime(parsed.time);
        if (t) state.time = t.toISOString();
      }

    } catch {}

    saveMemory();

    // -------- URGENT --------
    if (!state.urgent && isUrgent(msg)) {
      state.urgent = true;
      saveMemory();

      return res.json({
        replies: ["Oj det låter akut 😬 vill du att vi ringer dig direkt?"]
      });
    }

    // -------- CALL FLOW --------
    if (state.awaitingCallPhone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({ replies: ["Skriv ett nummer 👍"] });
      }

      state.phone = phone;
      state.awaitingCallPhone = false;
      state.awaitingCallTime = true;
      saveMemory();

      return res.json({ replies: ["När kan du prata? 👍"] });
    }

    if (state.awaitingCallTime) {
      state.callTime = raw;
      state.awaitingCallTime = false;
      saveMemory();

      await sendCallRequest(state);

      return res.json({
        replies: [`Vi ringer dig ${state.callTime} 👍`]
      });
    }

    // -------- PROBLEM --------
    if (!state.problem) {
      state.problem = raw;
      saveMemory();

      const reply = await aiEnhance(
        state,
        raw,
        smartFollowUp(raw),
        "Ask a relevant follow-up question"
      );

      return res.json({ replies: [reply] });
    }

    // -------- FLOW --------
    if (!state.name) {
      state.name = capitalize(raw);
      saveMemory();

      return res.json({
        replies: [await aiEnhance(state, raw, "Vad har du för nummer?", "Ask for phone")]
      });
    }

    if (!state.phone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({ replies: ["Skriv ett giltigt nummer 👍"] });
      }

      state.phone = phone;
      saveMemory();

      return res.json({
        replies: [await aiEnhance(state, raw, "Vilken adress gäller det?", "Ask for address")]
      });
    }

    if (!state.address) {
      if (!isValidAddress(raw)) {
        return res.json({ replies: ["Skriv adressen 👍"] });
      }

      state.address = capitalize(raw);
      saveMemory();

      return res.json({
        replies: [await aiEnhance(state, raw, "När passar det?", "Ask for time")]
      });
    }

    if (!state.time) {
      const parsed = parseSwedishDateTime(raw);

      if (!parsed) {
        return res.json({
          replies: [await aiEnhance(state, raw, "Vilken tid?", "Ask for time clearly")]
        });
      }

      state.time = parsed.toISOString();
      saveMemory();
    }

    // -------- BOOK --------
    await sendBookingEmail(state);

    delete users[userId];
    saveMemory();

    return res.json({
      replies: [
        `Perfekt 👍 bokat ${new Date(state.time).toLocaleString("sv-SE")}`,
        "Vi hör av oss 👍"
      ]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["⚠️ Något gick fel"] });
  }
});

app.listen(process.env.PORT || 3000);