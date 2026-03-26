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

// -------- EMAIL (one.com) --------

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

// -------- AI --------

async function aiExtract(message) {
  const prompt = `
Du analyserar ett kundmeddelande till en rörmokare.

Returnera ENDAST JSON:

{
  "problem": "",
  "details": "",
  "urgency": "low/medium/high",
  "name": "",
  "phone": "",
  "address": "",
  "time": ""
}

Meddelande: "${message}"
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    });

    return safeParse(res.choices[0].message.content);
  } catch (err) {
    console.error("AI extract error:", err);
    return {};
  }
}

async function aiReply(state, message) {
  const prompt = `
Du är en trevlig svensk rörmokar-assistent.

Kund skrev: "${message}"

Känd info:
${JSON.stringify(state)}

Regler:
- Kort svar (1 mening)
- Låter naturlig
- Ställ fråga om något saknas
- Om kunden säger "nej", gå vidare istället för att fråga igen
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
  } catch {
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
        replies: ["Hej! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // prevent spam bookings
    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({
        replies: ["Vi har redan registrerat din bokning 👍"]
      });
    }

    // AI extract
    const data = await aiExtract(raw);
    console.log("AI DATA:", data);

    if (data.problem) state.problem = data.problem;
    if (data.details) state.details = data.details;
    if (data.name) state.name = capitalize(data.name);
    if (data.phone && isValidPhone(data.phone)) state.phone = data.phone;
    if (data.address && isValidAddress(data.address)) state.address = capitalize(data.address);
    if (data.time) state.time = data.time;
    if (data.urgency) state.urgency = data.urgency;

    // greeting handling
    if (!state.problem && msg.length < 10) {
      return res.json({
        replies: ["Hej! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    // plumbing filter
    const plumbingKeywords = [
      "stopp", "avlopp", "läcka", "vatten",
      "kran", "toalett", "rör", "handfat", "dusch"
    ];

    const isPlumbing = plumbingKeywords.some(word =>
      (state.problem || "").toLowerCase().includes(word)
    );

    if (!isPlumbing && state.problem) {
      return res.json({
        replies: [
          "Jag hjälper med VVS-problem 😊 Gäller det t.ex. stopp, läckage eller kran?"
        ]
      });
    }

    // fallback if still no problem
    if (!state.problem) {
      const reply = await aiReply(state, raw);
      return res.json({
        replies: [reply]
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
      replies: ["Något gick fel 🤔"]
    });
  }
});

// ping
app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 AI BOOKING BOT RUNNING");
});