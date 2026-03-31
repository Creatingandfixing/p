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

// 🔥 FIXED PHONE HANDLING
function normalizePhone(phone) {
  if (!phone) return null;

  let cleaned = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");

  // convert +46 → 0
  if (cleaned.startsWith("+46")) {
    cleaned = "0" + cleaned.slice(3);
  }

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
    if (!text) return {};
    return JSON.parse(
      text.replace(/```json/g, "").replace(/```/g, "").trim()
    );
  } catch {
    return {};
  }
}

// -------- INDUSTRY LOGIC --------

function getProblemType(problem = "") {
  problem = problem.toLowerCase();

  if (problem.includes("stopp")) return "stopp";
  if (problem.includes("läcka")) return "leak";
  if (problem.includes("vatten")) return "no_water";

  return "other";
}

function getFollowUpQuestion(type) {
  const questions = {
    stopp: "är det helt stopp eller rinner det undan lite?",
    leak: "är det mycket vatten eller bara dropp?",
    no_water: "gäller det hela bostaden eller bara en kran?",
    other: "kan du beskriva lite mer exakt vad som händer?"
  };

  return questions[type] || questions.other;
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
    console.log("📧 Sending booking:", data);

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

    console.log("✅ Email sent!");
  } catch (err) {
    console.error("❌ Email error:", err.message);
  }
}

// -------- AI --------

async function aiExtract(message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: `
Extract info from this Swedish plumbing message.

Return ONLY JSON:
{
  "problem": "",
  "details": "",
  "urgency": "",
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

    return safeParse(res.choices?.[0]?.message?.content);
  } catch {
    return {};
  }
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body?.message || "";
    const msg = clean(raw);
    const userId = req.body?.userId || Math.random().toString(36);

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // AI extract
    const data = await aiExtract(raw);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    // 🔥 FIXED PHONE LOGIC
    let possiblePhone = normalizePhone(data.phone || raw);
    if (!state.phone && isValidPhone(possiblePhone)) {
      state.phone = possiblePhone;
    }

    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }

    if (data.time && !state.time) state.time = data.time;

    // BOOKING
    if (
      state.problem &&
      state.name &&
      state.phone &&
      state.address &&
      state.time
    ) {
      fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");
      await sendBookingEmail(state);

      users[userId] = {};

      return res.json({
        replies: [
          `Perfekt ${state.name} 👍`,
          "Vi hör av oss snart!"
        ]
      });
    }

    // FLOW

    if (state.problem && !state.asked) {
      state.asked = true;
      return res.json({
        replies: [
          `Okej, ${state.problem} — ${getFollowUpQuestion(getProblemType(state.problem))}`
        ]
      });
    }

    if (!state.name) {
      return res.json({ replies: ["Vad heter du?"] });
    }

    if (!state.phone) {
      return res.json({
        replies: [`Toppen ${state.name} 👍 vilket nummer når vi dig på?`]
      });
    }

    if (!state.address) {
      return res.json({ replies: ["Vilken adress gäller det?"] });
    }

    if (!state.time) {
      return res.json({ replies: ["När passar det bäst?"] });
    }

    return res.json({
      replies: ["Berätta lite mer 👍"]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["Nåt blev fel"] });
  }
});

// -------- BASIC --------

app.get("/", (req, res) => {
  res.send("🔥 Running");
});

app.listen(process.env.PORT || 3000);