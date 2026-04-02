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
    return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
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

MÅL:
- Hjälpa kunden snabbt
- Få bokningen gjord

VIKTIGA REGLER:
- Säg ALDRIG "Hej" igen mitt i konversationen
- Svara kort (1–2 meningar max)
- Låt som en riktig person, inte en AI
- Använd korrekt svenska (t.ex. "inget vatten")
- Upprepa inte vad kunden redan sagt
- Ställ alltid EN tydlig nästa fråga
- För konversationen framåt (inga döda svar)

BETEENDE:
- Anta bokning (fråga aldrig OM, utan fortsätt processen)
- Gör det enkelt att säga ja (”du kan alltid ändra sen”)
- Hantera tvekan naturligt (”fattar 👍 men vi kan bara lägga in en tid…”)
- Låt trygg, lugn och professionell

Kontext: ${context}
Mål: ${goal}

Svara nu:
`
        }
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
    console.error(err.message);
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
Extract:

{
  "problem": "",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Message: "${message}"
`
      }]
    });

    return safeParse(res.choices?.[0]?.message?.content);
  } catch {
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

    const data = await aiExtract(raw);

    // -------- CONTEXT UNDERSTANDING --------

    if (state.lastQuestion === "time") {
      const result = analyzeTime(msg);

      if (result === "valid") {
        state.time = msg;
      } else {
        return res.json({
          replies: ["Kan du skriva t.ex. 'imorgon kl 15'? 👍"]
        });
      }
    }

    if (state.lastQuestion === "phone") {
      let phone = normalizePhone(msg);
      if (isValidPhone(phone)) {
        state.phone = phone;
      }
    }

    if (state.lastQuestion === "name" && !state.name) {
      state.name = capitalize(msg);
    }

    // -------- NORMAL AI EXTRACT --------

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    let phone = normalizePhone(data.phone || raw);
    if (!state.phone && isValidPhone(phone)) state.phone = phone;

    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }

    if (!state.time && data.time) {
      const result = analyzeTime(data.time);

      if (result === "valid") {
        state.time = data.time;
      }
    }

    // -------- BOOKING --------

    if (state.problem && state.name && state.phone && state.address && state.time) {
      fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");
      await sendBookingEmail(state);

      users[userId] = {};

      return res.json({
        replies: ["Perfekt 👍 vi hör av oss snart! (du kan ändra tiden senare)"]
      });
    }

    // -------- FLOW --------

    if (!state.problem) {
      return res.json({
        replies: ["Tja! Beskriv vad som hänt så löser vi det direkt 👍"]
      });
    }

    if (state.problem && !state.asked) {
      state.asked = true;

      const reply = await generateReply(
        `Problem: ${state.problem}`,
        "Ask a follow-up question"
      );

      return res.json({ replies: [reply] });
    }

    if (!state.name) {
      state.lastQuestion = "name";

      const reply = await generateReply(
        state.problem,
        "Ask for name"
      );

      return res.json({ replies: [reply] });
    }

    if (!state.phone) {
      state.lastQuestion = "phone";

      const reply = await generateReply(
        state.name,
        "Ask for phone"
      );

      return res.json({ replies: [reply] });
    }

    if (!state.address) {
      state.lastQuestion = "address";

      const reply = await generateReply(
        state.name,
        "Ask for address"
      );

      return res.json({ replies: [reply] });
    }

    if (!state.time) {
      state.lastQuestion = "time";

      const reply = await generateReply(
        state.name,
        "Ask for booking time"
      );

      return res.json({ replies: [reply] });
    }

    return res.json({
      replies: ["Berätta lite mer 👍"]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["Nåt blev fel"] });
  }
});

app.get("/", (req, res) => {
  res.send("🔥 Running");
});

app.listen(process.env.PORT || 3000);