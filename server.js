import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Johanneshovrör";
const OWNER_EMAIL = process.env.BOOKING_EMAIL || process.env.EMAIL_USER;

// -------- AI --------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🔥 HUMAN REPLY
async function aiReply(state, userMessage, instruction) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content: `
Du är en trevlig svensk rörmokare.

- Svara kort (1 mening)
- Låter naturlig
- Max 1 emoji
- Ställ max en fråga

INFO:
Problem: ${state.problem || "okänt"}
`
        },
        {
          role: "user",
          content: `${userMessage}\n\nInstruction: ${instruction}`
        }
      ]
    });

    return res.choices[0].message.content;

  } catch {
    return null;
  }
}

async function aiEnhance(state, msg, fallback, instruction) {
  const reply = await aiReply(state, msg, instruction);
  return reply || fallback;
}

// 🔥 AI FILTER (IMPORTANT)
async function isRelevantAI(message) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 5,
      messages: [
        {
          role: "system",
          content: `
Return ONLY "yes" or "no".

YES = message is about plumbing, water, pipes, bathroom, kitchen issues
NO = jokes, spam, nonsense, unrelated
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    return res.choices[0].message.content.toLowerCase().includes("yes");

  } catch {
    return true; // fallback safe
  }
}

// -------- MEMORY --------

let users = {};

try {
  users = JSON.parse(fs.readFileSync("memory.json", "utf-8"));
} catch {}

function saveMemory() {
  fs.writeFileSync("memory.json", JSON.stringify(users, null, 2));
}

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
  return /^\d{7,15}$/.test(phone);
}

function isValidAddress(addr) {
  return addr && addr.length > 4 && /\d/.test(addr);
}

function isUrgent(text) {
  return text.match(/akut|sprutar|forsar|översvämning|panik/i);
}

function smartFollowUp(problem = "") {
  const text = problem.toLowerCase();

  if (text.includes("läcker")) {
    return "Rinner det hela tiden eller bara ibland? 👍";
  }

  if (text.includes("stopp")) {
    return "Är det helt stopp eller rinner det undan lite?";
  }

  return "Kan du beskriva lite mer?";
}

function parseSwedishDateTime(text) {
  const now = new Date();
  let date = new Date(now);

  text = text.toLowerCase();

  // ---- MONTHS ----
  const months = {
    januari: 0, februari: 1, mars: 2, april: 3,
    maj: 4, juni: 5, juli: 6, augusti: 7,
    september: 8, oktober: 9, november: 10, december: 11
  };

  // ---- DATE (e.g. "14 maj") ----
  for (let month in months) {
    const regex = new RegExp(`(\\d{1,2})\\s*${month}`);
    const match = text.match(regex);

    if (match) {
      date.setDate(parseInt(match[1]));
      date.setMonth(months[month]);
    }
  }

  // ---- TOMORROW ----
  if (text.includes("imorgon")) {
    date.setDate(now.getDate() + 1);
  }

  // ---- TIME ----
  const timeMatch = text.match(/kl\s*(\d{1,2})(?::(\d{2}))?/);

  if (timeMatch) {
    date.setHours(parseInt(timeMatch[1]));
    date.setMinutes(parseInt(timeMatch[2] || "0"));
  } else {
    return null;
  }

  return date;
}

// -------- EMAIL --------

const transporter = nodemailer.createTransport({
  host: "send.one.com",
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
Detaljer: ${data.details || "Ej angivet"}

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
Telefon: ${data.phone}
Tid: ${data.callTime}
Problem: ${data.problem || "okänt"}
`
  });
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message || "";
    const msg = clean(raw);
    const userId = req.body.userId || "default-user";

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // 🔥 AI FILTER FIRST
    if (!state.problem) {
      const relevant = await isRelevantAI(raw);

      if (!relevant) {
        const reply = await aiEnhance(
          state,
          raw,
          "Haha 😄 jag tror det där hamnade lite fel — gäller det något med rör?",
          "User is off-topic, redirect politely to plumbing"
        );

        return res.json({ replies: [reply] });
      }
    }

    // -------- URGENT --------
    if (!state.urgent && isUrgent(msg)) {
      state.urgent = true;
      saveMemory();

      return res.json({
        replies: ["Oj det låter akut 😬 vill du att vi ringer dig direkt?"]
      });
    }

    // -------- CONTACT --------
if (msg.match(/ring mig|ringa mig|kan ni ringa/i)) {

  if (!state.problem) {
    return res.json({
      replies: ["Absolut 👍 vad gäller det först?"]
    });
  }

  if (state.phone) {
    state.awaitingCallTime = true;
    saveMemory();

    return res.json({
      replies: ["När kan du prata? 👍"]
    });
  }

  state.awaitingCallPhone = true;
  saveMemory();

  return res.json({
    replies: ["Vilket nummer når vi dig på? 👍"]
  });
}

    // -------- CALL FLOW --------
    if (state.awaitingCallPhone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({ replies: ["Skriv ett nummer 👍"] });
      }

      state.phone = phone;
      state.awaitingCallTime = true;
      state.awaitingCallPhone = false;
      saveMemory();

      return res.json({ replies: ["När kan du prata? 👍"] });
    }

    if (state.awaitingCallTime) {
      state.callTime = raw;
      state.awaitingCallTime = false;
      saveMemory();

      await sendCallRequest(state);

      return res.json({
        replies: [`Vi ringer dig ${state.callTime} 👍`]
      });
    }

    // -------- PROBLEM --------
if (!state.problem) {
  state.problem = raw;
  state.details = raw;
  saveMemory();

  return res.json({
    replies: [
      await aiEnhance(
        state,
        raw,
        smartFollowUp(raw),
        "Ask a smart follow-up question about the problem"
      )
    ]
  });
}


if (state.problem && raw.length > (state.details?.length || 0)) {
  state.details = raw;
  saveMemory();
}

    // -------- FLOW --------
    if (!state.name) {

  // reject non-name inputs
  if (
    raw.match(/\d/) ||                     // contains numbers
    raw.length > 30 ||                     // too long
    raw.split(" ").length > 3 ||           // too many words
    raw.match(/rör|läck|stopp|vatten|dusch|problem/i) // plumbing words
  ) {
    return res.json({
      replies: ["Vad heter du? 🙂"]
    });
  }

  state.name = capitalize(raw);
  saveMemory();

  return res.json({
    replies: [await aiEnhance(state, raw, "Vad har du för nummer?", "Ask for phone")]
  });
}

    if (!state.phone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({ replies: ["Skriv ett giltigt nummer 👍"] });
      }

      state.phone = phone;
      saveMemory();

      return res.json({
        replies: [await aiEnhance(state, raw, "Vilken adress gäller det?", "Ask address")]
      });
    }

    if (!state.address) {
      if (!isValidAddress(raw)) {
        return res.json({ replies: ["Skriv adressen 👍"] });
      }

      state.address = capitalize(raw);
      saveMemory();

      return res.json({
        replies: [await aiEnhance(state, raw, "När passar det?", "Ask time")]
      });
    }

    if (!state.time) {
      const parsed = parseSwedishDateTime(raw);

      if (!parsed) {
        return res.json({
          replies: [await aiEnhance(state, raw, "Vilken tid?", "Ask time clearly")]
        });
      }

      state.time = parsed.toISOString();
      saveMemory();
    }

    // -------- BOOK --------
    await sendBookingEmail(state);

    delete users[userId];
    saveMemory();

    return res.json({
      replies: [
        `Perfekt 👍 bokat ${new Date(state.time).toLocaleString("sv-SE")}`,
        "Vi hör av oss 👍"
      ]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["⚠️ Något gick fel"] });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 AI receptionist running");
});