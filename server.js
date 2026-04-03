import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const app = express();

// 🔥 IMPORTANT FIXES
app.use(cors());
app.use(express.json({ limit: "1mb" })); // prevent payload crashes

// -------- OPENAI --------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -------- MEMORY --------

let users = {};

// -------- HELPERS --------

function clean(msg) {
  return msg?.toString().toLowerCase().trim().slice(0, 500) || "";
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

function safeParse(text) {
  try {
    return JSON.parse(
      text.replace(/```json/g, "").replace(/```/g, "").trim()
    );
  } catch {
    return {};
  }
}

// -------- TIME --------

function analyzeTime(text = "") {
  text = text.toLowerCase();

  const hasTime = /\d{1,2}/.test(text);

  const hasDay =
    text.includes("idag") ||
    text.includes("imorgon") ||
    text.includes("måndag") ||
    text.includes("tisdag") ||
    text.includes("onsdag") ||
    text.includes("torsdag") ||
    text.includes("fredag") ||
    text.includes("lördag") ||
    text.includes("söndag");

  if (hasTime && hasDay) return "valid";
  if (hasTime && !hasDay) return "missing_day";
  if (!hasTime && hasDay) return "missing_time";

  return "invalid";
}

// -------- AI --------

async function generateReply(context, goal) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `
Du är en erfaren svensk rörmokare som chattar med kunder.

Svara kort (1–2 meningar).
Ställ EN fråga.
Låt naturlig.

Kontext: ${context}
Mål: ${goal}
`
        }
      ],
      timeout: 8000 // 🔥 prevent serverless timeout crash
    });

    return res.choices?.[0]?.message?.content || "Okej 👍";
  } catch (err) {
    console.error("AI ERROR:", err.message);
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

// -------- AI EXTRACT --------

async function aiExtract(message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{
        role: "user",
        content: `
Extract JSON:

{
  "problem": "",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Message: "${message}"
`
      }],
      timeout: 6000
    });

    return safeParse(res.choices?.[0]?.message?.content);
  } catch (err) {
    console.error("EXTRACT ERROR:", err.message);
    return {};
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

    const now = Date.now();
    const last = state.lastMessageAt || now;
    const diff = now - last;
    state.lastMessageAt = now;

    // 🔥 reset memory if too old
    if (diff > 1000 * 60 * 60 * 6) {
      users[userId] = {};
      return res.json({
        replies: ["Vi tappade nog tråden 😅 vad kan jag hjälpa dig med?"]
      });
    }

    const data = await aiExtract(raw);

    // -------- SAFE EXTRACTION --------

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    let phone = normalizePhone(data.phone || raw);
    if (!state.phone && isValidPhone(phone)) state.phone = phone;

    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }

    if (!state.time && data.time) {
      if (analyzeTime(data.time) === "valid") state.time = data.time;
    }

    // -------- BOOKING --------

    if (state.problem && state.name && state.phone && state.address && state.time) {
      fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");

      await sendBookingEmail(state);

      users[userId] = {};

      return res.json({
        replies: ["Perfekt 👍 vi hör av oss snart!"]
      });
    }

    // -------- FLOW --------

    if (!state.problem) {
      return res.json({
        replies: ["Tja! Beskriv vad som hänt 👍"]
      });
    }

    if (!state.name) {
      return res.json({ replies: ["Vad heter du? 👍"] });
    }

    if (!state.phone) {
      return res.json({
        replies: [`Toppen ${state.name} 👍 vilket nummer?`]
      });
    }

    if (!state.address) {
      return res.json({
        replies: ["Vilken adress gäller det?"]
      });
    }

    if (!state.time) {
      return res.json({
        replies: ["När passar det? (t.ex. imorgon kl 15)"]
      });
    }

    return res.json({ replies: ["Berätta lite mer 👍"] });

  } catch (err) {
    console.error("SERVER ERROR:", err);

    res.status(200).json({
      replies: ["⚠️ Något gick fel, försök igen"]
    });
  }
});

// -------- HEALTH CHECK --------

app.get("/", (req, res) => {
  res.send("🔥 Server running");
});

// -------- START --------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});