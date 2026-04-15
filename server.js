import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Rörmokare";
const OWNER_EMAIL = process.env.BOOKING_EMAIL || process.env.EMAIL_USER;

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

// -------- SMART FOLLOW-UP (NEW 🔥) --------

function smartFollowUp(problem = "") {
  const text = problem.toLowerCase();

  if (text.includes("läcker")) {
    return "Okej 👍 droppar det lite eller rinner det konstant?";
  }

  if (text.includes("stopp")) {
    return "Okej 👍 är det helt stopp eller rinner det undan lite?";
  }

  if (text.includes("inget vatten")) {
    return "Okej 👍 är det helt dött eller bara lågt tryck?";
  }

  if (text.includes("tryck")) {
    return "Okej 👍 har det blivit sämre nyligen eller alltid varit så?";
  }

  return "Okej 👍 kan du beskriva lite mer vad som händer?";
}

// -------- DATE PARSER --------

function parseSwedishDateTime(text) {
  const now = new Date();
  let date = new Date(now);

  if (/imorgon/i.test(text)) {
    date.setDate(now.getDate() + 1);
  }

  const days = {
    söndag: 0,
    måndag: 1,
    tisdag: 2,
    onsdag: 3,
    torsdag: 4,
    fredag: 5,
    lördag: 6
  };

  for (let day in days) {
    if (text.includes(day)) {
      const target = days[day];
      const diff = (target - now.getDay() + 7) % 7 || 7;
      date.setDate(now.getDate() + diff);
    }
  }

  const match = text.match(/(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  date.setHours(parseInt(match[1]));
  date.setMinutes(parseInt(match[2] || "0"));
  date.setSeconds(0);

  return date;
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

    // GREETING
    if (msg === "hej" || msg === "tja") {
      return res.json({ replies: ["Tja 👍 vad har hänt?"] });
    }

    // CONTACT
    if (msg.match(/\b(ring|kontakta)\b/i)) {
      await sendCallRequest(state);
      return res.json({ replies: ["Perfekt 👍 vi ringer upp dig!"] });
    }

    // -------- PROBLEM --------

    if (!state.problem && msg.length > 3) {
      state.problem = raw;

      return res.json({
        replies: [smartFollowUp(state.problem)]
      });
    }

    // -------- AFTER FOLLOW-UP → MOVE ON --------

    if (state.problem && !state.followUpDone) {
      state.followUpDone = true;
    }

    // -------- NAME --------

    if (!state.name) {
      state.name = capitalize(raw);
      return res.json({
        replies: ["Toppen 👍 vilket nummer når vi dig på?"]
      });
    }

    // -------- PHONE --------

    if (!state.phone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({
          replies: ["Skriv ett giltigt nummer 👍"]
        });
      }

      state.phone = phone;

      return res.json({
        replies: ["Vilken adress gäller det?"]
      });
    }

    // -------- ADDRESS --------

    if (!state.address) {
      if (!isValidAddress(raw)) {
        return res.json({
          replies: ["Skriv en fullständig adress 👍"]
        });
      }

      state.address = capitalize(raw);

      return res.json({
        replies: ["När passar det? 👍 (t.ex. imorgon kl 15)"]
      });
    }

    // -------- TIME --------

    if (!state.time) {
      const parsed = parseSwedishDateTime(raw);

      if (!parsed) {
        return res.json({
          replies: ["Ange tid 👍 (t.ex. kl 15)"]
        });
      }

      state.time = parsed.toISOString();
    }

    // -------- BOOKING --------

    await sendBookingEmail(state);

    delete users[userId];

    return res.json({
      replies: [
        `Perfekt 👍 vi bokar in dig ${new Date(state.time).toLocaleString("sv-SE")}`
      ]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["⚠️ Något gick fel"] });
  }
});

// -------- HEALTH --------

app.get("/", (req, res) => {
  res.send(`${BUSINESS_NAME} API running`);
});

app.get("/test-email", async (req, res) => {
  try {
    console.log("TEST EMAIL TRIGGERED");

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: "TEST EMAIL",
      text: "It works!"
    });

    res.send("Email sent!");
  } catch (err) {
    console.error(err);
    res.send("Email failed");
  }
});

app.listen(process.env.PORT || 3000);