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
  } catch {
    return {};
  }
}

async function aiReply(state, message) {
  const prompt = `
Du är en erfaren rörmokare i Stockholm som chattar med kunder.

Skriv som en riktig hantverkare:
- Avslappnat, tryggt, lite "tja" vibe
- Inte för formell
- Inte för slangig

Kund skrev: "${message}"

Känd info:
${JSON.stringify(state)}

Regler:
- Kort (1 mening, max 2)
- Låt som en riktig person
- Visa förståelse ("det där är klassiker", "låter inte kul")
- Ställ EN relevant fråga
- Upprepa inte dig
- Om kunden säger "nej", gå vidare
- Max 1 emoji
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.9,
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }]
    });

    return res.choices[0].message.content;
  } catch {
    return "Hmm, skriv igen så löser vi det 🙂";
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

    // AI extraction
    const data = await aiExtract(raw);
    console.log("AI DATA:", data);

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
      "kran", "toalett", "rör", "handfat", "dusch"
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

    // first reaction (human feel)
    if (state.problem && !state.reacted) {
      state.reacted = true;

      return res.json({
        replies: [
          `Okej, ${state.problem} — klassiker 😅 Vad heter du?`
        ]
      });
    }

    // handle "nej"
    if (msg === "nej") {
      const reply = await aiReply(state, "kunden sa nej, gå vidare");
      return res.json({ replies: [reply] });
    }

    // fallback if no problem
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
          `Perfekt ${state.name} 👍`,
          "Jag har lagt in det, vi hör av oss"
        ]
      });
    }

    // AI follow-up
    const reply = await aiReply(state, raw);

    return res.json({
      replies: [reply]
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
  console.log("🔥 STOCKHOLM AI BOT RUNNING");
});