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
  } catch {
    return {};
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
        replies: ["Tja! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // spam protection
    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({
        replies: ["Jag har redan lagt in det 👍 vi hör av oss"]
      });
    }

    // AI extract
    const data = await aiExtract(raw);
    console.log("AI DATA:", data);

    // AUTO-SKIP (fills everything instantly if user writes full message)
    if (data.problem) state.problem = data.problem;
    if (data.details) state.details = data.details;
    if (data.name) state.name = capitalize(data.name);
    if (data.phone && isValidPhone(data.phone)) state.phone = data.phone;
    if (data.address && isValidAddress(data.address)) state.address = capitalize(data.address);
    if (data.time) state.time = data.time;
    if (data.urgency) state.urgency = data.urgency;

    // greeting
    if (!state.problem && msg.length < 10) {
      return res.json({
        replies: ["Tja! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    // plumbing filter
    const plumbingKeywords = [
      "stopp", "avlopp", "läcka", "vatten",
      "kran", "toalett", "rör", "handfat", "dusch", "badkar"
    ];

    const isPlumbing = plumbingKeywords.some(word =>
      (state.problem || "").toLowerCase().includes(word)
    );

    if (!isPlumbing && state.problem) {
      return res.json({
        replies: [
          "Jag kör bara VVS 😄 gäller det stopp, läcka eller nåt sånt?"
        ]
      });
    }

    // HUMAN REACTION (only once)
    if (state.problem && !state.reacted) {
      state.reacted = true;

      return res.json({
        replies: [
          `Okej, ${state.problem} — klassiker 😅`
        ]
      });
    }

    // STEP FLOW (SMART + AUTO SKIP)

    if (state.problem && !state.name) {
      return res.json({
        replies: ["Vad heter du?"]
      });
    }

    if (state.name && !state.phone) {
      return res.json({
        replies: [`Snyggt ${state.name} 👍 har du ett nummer jag kan nå dig på?`]
      });
    }

    if (state.phone && !state.address) {
      return res.json({
        replies: ["Perfekt, vilken adress gäller det?"]
      });
    }

    if (state.address && !state.time) {
      return res.json({
        replies: ["När passar det för dig?"]
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
          `Perfekt ${state.name} 👍`,
          "Jag har lagt in det, vi hör av oss"
        ]
      });
    }

    // fallback
    return res.json({
      replies: ["Hmm, kan du skriva det igen så löser vi det 🙂"]
    });

  } catch (err) {
    console.error(err);
    return res.json({
      replies: ["Nåt blev knas 🤔 testa igen"]
    });
  }
});

// ping
app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL AI BOT RUNNING");
});