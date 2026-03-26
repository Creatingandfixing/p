import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let users = {};

// -------- HELPERS --------

function clean(msg) {
  return msg?.toLowerCase().trim() || "";
}

function capitalize(str) {
  return str
    ?.split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isValidPhone(phone) {
  return phone && phone.match(/^\d{7,}$/);
}

function isValidAddress(addr) {
  return addr && addr.length > 4 && addr.match(/\d/);
}

// -------- SAFE JSON PARSE --------

function safeParse(text) {
  try {
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

// -------- EMAIL SETUP (one.com) --------

const transporter = nodemailer.createTransport({
  host: "smtp.one.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// -------- SEND EMAIL --------

async function sendBookingEmail(data) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: "🚨 Ny VVS Bokning",
      text: `
🚨 Ny bokning

Problem: ${data.problem}
Detaljer: ${data.details || "-"}

👤 ${data.name}
📞 ${data.phone}
📍 ${data.address}
⏰ ${data.time}
      `
    });
  } catch (err) {
    console.error("Email error:", err);
  }
}

// -------- AI EXTRACTION --------

async function aiExtract(message) {
  const prompt = `
Extract info from this Swedish plumbing request.

Return JSON only:
{
  "problem": "",
  "details": "",
  "urgency": "low/medium/high",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Message: "${message}"
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    });

    return safeParse(res.choices[0].message.content);

  } catch (err) {
    console.error("AI extract error:", err);
    return {};
  }
}

// -------- AI RESPONSE --------

async function aiReply(state, message) {
  const prompt = `
You are a friendly Swedish plumbing assistant.

Customer said: "${message}"

Known info:
${JSON.stringify(state)}

Rules:
- Natural Swedish
- Short (1 sentence)
- Ask for missing info
- If urgent → sound faster
- Max 1 emoji
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }]
    });

    return res.choices[0].message.content;

  } catch (err) {
    console.error("AI reply error:", err);
    return "Kan du skriva det igen? 🙂";
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

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // spam protection
    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({
        replies: ["Vi har redan registrerat din bokning 👍"]
      });
    }

    // AI extraction
    const data = await aiExtract(raw);

    if (data.problem) state.problem = data.problem;
    if (data.details) state.details = data.details;
    if (data.name) state.name = capitalize(data.name);
    if (data.phone && isValidPhone(data.phone)) state.phone = data.phone;
    if (data.address && isValidAddress(data.address)) state.address = capitalize(data.address);
    if (data.time) state.time = data.time;
    if (data.urgency) state.urgency = data.urgency;

    // fallback if no problem
    if (!state.problem) {
      return res.json({
        replies: ["Kan du beskriva problemet lite kort?"]
      });
    }

    // COMPLETE BOOKING
    if (
      state.problem &&
      state.name &&
      state.phone &&
      state.address &&
      state.time
    ) {

      fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");

      await sendBookingEmail(state);

      state.lastBooking = Date.now();
      users[userId] = {};

      return res.json({
        replies: [
          `Tack ${state.name}! 🙌`,
          "Din bokning är registrerad",
          state.urgency === "high"
            ? "Vi prioriterar detta direkt."
            : "Vi hör av oss snart!"
        ]
      });
    }

    // AI follow-up
    const reply = await aiReply(state, raw);

    return res.json({
      replies: [reply]
    });

  } catch (err) {
    console.error("MAIN ERROR:", err);
    return res.json({
      replies: ["Något gick fel 🤔 Försök igen."]
    });
  }
});

// ping
app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 AI BOOKING BOT RUNNING");
});