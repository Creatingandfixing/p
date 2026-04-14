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
  return msg?.toString().trim().slice(0, 500) || "";
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
Du är en rörmokare i Stockholm.

TON:
- Avslappnad (som SMS)
- Inte formell
- Max 1–2 meningar
- Ställ EN fråga

REGLER:
- Säg aldrig "hej/tja" igen efter första meddelandet
- Bekräfta problemet kort först
- Börja aldrig om
- Om tvekan → "du kan ändra sen"

FLOW:
1. Problem
2. Namn
3. Telefon
4. Adress
5. Tid

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
  try {
    console.log("SENDING OWNER EMAIL:", data);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.BOOKING_EMAIL || process.env.EMAIL_USER,
      subject: "🚨 Ny VVS Bokning",
      text: `
Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${data.time}
      `
    });

  } catch (err) {
    console.error("EMAIL ERROR:", err.message);
  }
}

async function sendCustomerConfirmation(data) {
  try {
    console.log("SENDING CUSTOMER CONFIRMATION");

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // change later if you collect email
      subject: "Bekräftelse på bokning",
      text: `
Hej ${data.name}!

Vi har bokat in dig:

🛠 ${data.problem}
📍 ${data.address}
🕒 ${data.time}

Vi hör av oss innan 👍

/ Johanneshovrör
      `
    });

  } catch (err) {
    console.error("CUSTOMER EMAIL ERROR:", err.message);
  }
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

    // -------- QUICK HANDLERS --------

    if (msg.toLowerCase() === "hej" || msg.toLowerCase() === "tja") {
      return res.json({
        replies: ["Tja 👍 vad har hänt?"]
      });
    }

    if (msg.toLowerCase() === "ja" && !state.problem) {
      return res.json({
        replies: ["Toppen 👍 vad gäller det?"]
      });
    }

    // -------- AI EXTRACT --------

    const data = await aiExtract(msg);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    let phone = normalizePhone(data.phone || msg);
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

      console.log("BOOKING COMPLETE:", state);

      await sendBookingEmail(state);
      await sendCustomerConfirmation(state);

      users[userId] = {};

      return res.json({
        replies: [
          `Perfekt 👍 vi bokar in dig på ${state.time}. Du får en bekräftelse snart!`
        ]
      });
    }

    // -------- AI RESPONSE --------

    const reply = await generateReply(state, msg);

    return res.json({
      replies: [reply]
    });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.json({
      replies: ["⚠️ Något gick fel, försök igen"]
    });
  }
});

// -------- HEALTH --------

app.get("/", (req, res) => {
  res.send("🔥 Server running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});