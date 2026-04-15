import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import nodemailer from "nodemailer";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------- CONFIG --------

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Rörmokare";
const OWNER_EMAIL = process.env.BOOKING_EMAIL || process.env.EMAIL_USER;

// -------- OPENAI --------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -------- MEMORY --------

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

// -------- SWEDISH DATE PARSER --------

function parseSwedishDateTime(text) {
  const now = new Date();
  let date = new Date(now);

  // DAY
  if (/imorgon/i.test(text)) {
    date.setDate(now.getDate() + 1);
  } else if (/idag/i.test(text)) {
    // same day
  } else {
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
  }

  // TIME
  const match = text.match(/(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2] || "0");

  date.setHours(hours);
  date.setMinutes(minutes);
  date.setSeconds(0);

  return date;
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

    return JSON.parse(res.choices?.[0]?.message?.content || "{}");

  } catch {
    return {};
  }
}

// -------- AI REPLY --------

async function generateReply(state, message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `
Du jobbar för ${BUSINESS_NAME}.

- Kort svar (1–2 meningar)
- Ställ EN fråga
- Låt naturlig

- Ställ MAX 1 följdfråga om problemet
- När problem förstått → gå vidare direkt

- Om FollowUpDone = yes → fråga INTE mer om problemet

INFO:
Problem: ${state.problem || "saknas"}
Namn: ${state.name || "saknas"}
Telefon: ${state.phone || "saknas"}
Adress: ${state.address || "saknas"}
Tid: ${state.time || "saknas"}
FollowUpDone: ${state.followUpDone ? "yes" : "no"}
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
  host: process.env.SMTP_HOST || "smtp.one.com",
  port: process.env.SMTP_PORT || 587,
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
    subject: `📞 Ring upp kund - ${BUSINESS_NAME}`,
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
      return res.json({
        replies: ["Tja 👍 vad har hänt?"]
      });
    }

    // CONTACT
    if (msg.match(/\b(ring|kontakta)\b/i)) {
      await sendCallRequest(state);
      return res.json({
        replies: ["Perfekt 👍 vi ringer upp dig snart!"]
      });
    }

    // AI EXTRACT
    const data = await aiExtract(raw);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);

    let phone = normalizePhone(data.phone || raw);
    if (!state.phone && isValidPhone(phone)) state.phone = phone;

    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }

    // -------- TIME (SMART) --------

    if (!state.time) {

      const parsed = parseSwedishDateTime(raw);

      if (parsed) {
        state.time = parsed.toISOString();
      }

      else if (/idag|imorgon|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag/i.test(raw)) {
        return res.json({
          replies: ["Vilken tid? 👍 (t.ex. kl 15)"]
        });
      }

      else if (state.address) {
        return res.json({
          replies: ["När passar det? 👍 (t.ex. imorgon kl 15)"]
        });
      }
    }

    // FOLLOW-UP CONTROL
    if (state.problem && !state.followUpDone) {
      state.followUpDone = true;
    }

    // FORCE FLOW
    if (state.problem && state.followUpDone) {

      if (!state.name) {
        return res.json({ replies: ["Okej 👍 vad heter du?"] });
      }

      if (state.name && !state.phone) {
        return res.json({ replies: [`Toppen ${state.name} 👍 nummer?`] });
      }

      if (state.phone && !state.address) {
        return res.json({ replies: ["Vilken adress gäller det?"] });
      }
    }

    // BOOKING
    if (state.problem && state.name && state.phone && state.address && state.time) {

      await sendBookingEmail(state);

      delete users[userId];

      return res.json({
        replies: [
          `Perfekt 👍 vi bokar in dig ${new Date(state.time).toLocaleString("sv-SE")}`
        ]
      });
    }

    // AI RESPONSE
    const reply = await generateReply(state, raw);

    return res.json({
      replies: [reply]
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

app.listen(process.env.PORT || 3000);