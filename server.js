import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import fs from "fs";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Johanneshovrör";
const OWNER_EMAIL = process.env.BOOKING_EMAIL || process.env.EMAIL_USER;

// -------- MEMORY --------

let users = {};

try {
  const data = fs.readFileSync("memory.json", "utf-8");
  users = JSON.parse(data);
} catch {
  users = {};
}

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
  return typeof phone === "string" && /^\d{7,15}$/.test(phone);
}

function isValidAddress(addr) {
  return typeof addr === "string" && addr.length > 4 && /\d/.test(addr);
}

// -------- INTENT --------

function detectIntent(msg) {
  if (msg.match(/\b(ja|gärna|ok|kör|absolut)\b/i)) return "yes";
  if (msg.match(/\b(nej|inte|sen|inte än)\b/i)) return "no";
  if (msg.match(/\b(ring|kontakta)\b/i)) return "contact";
  if (msg.match(/\?/)) return "question";
  if (msg.match(/vet inte|kanske/i)) return "hesitation";
  return "normal";
}

// -------- HUMAN SIGNALS --------

function isFrustrated(msg) {
  return msg.match(/!!!|fan|sjukt|snälla|hjälp/i);
}

// -------- FOLLOW-UP --------

function smartFollowUp(problem = "") {
  const text = problem.toLowerCase();

  if (text.includes("läcker")) {
    return "Okej 👍 låter som läckage — rinner det hela tiden eller bara lite?";
  }

  if (text.includes("stopp")) {
    return "Okej 👍 är det helt stopp eller rinner det undan lite?";
  }

  return "Okej 👍 vad är det som strular mer exakt?";
}

// -------- DATE --------

function parseSwedishDateTime(text) {
  const now = new Date();
  let date = new Date(now);

  if (/imorgon/i.test(text)) {
    date.setDate(now.getDate() + 1);
  }

  const days = {
    söndag: 0, måndag: 1, tisdag: 2, onsdag: 3,
    torsdag: 4, fredag: 5, lördag: 6
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
  host: "send.one.com",
  port: 587,
  secure: false,
  family: 4,
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
Tid: ${data.callTime || "ej angiven"}
Problem: ${data.problem || "okänt"}
    `
  });
}

// -------- MAIN --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message || "";
    const msg = clean(raw);
    const intent = detectIntent(msg);

    const userId = req.body.userId || "default-user";

    if (!users[userId]) {
      users[userId] = {};
    }

    let state = users[userId];

    // -------- CALL FLOW FIRST --------

    if (state.awaitingCallPhone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({ replies: ["Skriv ett nummer så vi kan ringa 👍"] });
      }

      state.phone = phone;
      state.awaitingCallPhone = false;
      state.awaitingCallTime = true;
      saveMemory();

      return res.json({ replies: ["Perfekt 👍 när kan du prata?"] });
    }

    if (state.awaitingCallTime) {
      state.callTime = raw;
      state.awaitingCallTime = false;
      saveMemory();

      await sendCallRequest(state);

      return res.json({
        replies: [`Toppen 👍 vi ringer dig ${state.callTime}`]
      });
    }

    // -------- GREETING --------

    if (msg === "hej" || msg === "tja") {
      return res.json({ replies: ["Tja 👍 vad har hänt?"] });
    }

    // -------- CONTACT (SMART FIX) --------

    if (intent === "contact") {

      if (msg.match(/ringa er|kan jag ringa/i)) {
        return res.json({
          replies: [
            "Självklart 👍 du kan ringa oss via hemsidan — vill du att vi ringer dig istället?"
          ]
        });
      }

      if (state.phone) {
        state.awaitingCallTime = true;
        saveMemory();
        return res.json({ replies: ["Absolut 👍 när kan du prata?"] });
      }

      state.awaitingCallPhone = true;
      saveMemory();
      return res.json({ replies: ["Vilket nummer når vi dig på? 👍"] });
    }

    // -------- HUMAN UPGRADE --------

    if (isFrustrated(msg)) {
      return res.json({
        replies: ["Jag fattar 👍 vill du att vi ringer dig direkt så löser vi det?"]
      });
    }

    if (intent === "hesitation") {
      return res.json({
        replies: ["Ingen stress 👍 vill du att vi ringer dig istället?"]
      });
    }

    // -------- QUESTIONS --------

    if (intent === "question") {

      if (msg.includes("pris")) {
        return res.json({
          replies: ["Svårt att säga exakt 👍 men vi kan kolla på det snabbt om du vill"]
        });
      }

      if (state.problem) {
        return res.json({
          replies: ["Vi löser det 👍 vill du boka eller ska vi ringa dig?"]
        });
      }

      return res.json({
        replies: ["Bra fråga 👍 vad gäller det?"]
      });
    }

    // -------- PROBLEM --------

    if (!state.problem && msg.length > 3) {
      state.problem = raw;
      saveMemory();

      return res.json({
        replies: [smartFollowUp(state.problem)]
      });
    }

    // -------- TRANSITION --------

    if (state.problem && !state.readyToBook) {
      state.readyToBook = true;
      saveMemory();

      return res.json({
        replies: ["Det där fixar vi 👍 vill du boka eller ska vi ringa dig?"]
      });
    }

    // -------- NAME --------

    if (!state.name) {
      state.name = capitalize(raw);
      saveMemory();
      return res.json({ replies: ["Toppen 👍 vad har du för nummer?"] });
    }

    // -------- PHONE --------

    if (!state.phone) {
      const phone = normalizePhone(raw);

      if (!isValidPhone(phone)) {
        return res.json({
          replies: ["Skriv ett nummer så vi kan nå dig 👍"]
        });
      }

      state.phone = phone;
      saveMemory();

      return res.json({ replies: ["Vilken adress gäller det?"] });
    }

    // -------- ADDRESS --------

    if (!state.address) {
      if (!isValidAddress(raw)) {
        return res.json({ replies: ["Skriv adressen 👍"] });
      }

      state.address = capitalize(raw);
      saveMemory();

      return res.json({ replies: ["När passar det? 👍"] });
    }

    // -------- TIME --------

    if (!state.time) {
      const parsed = parseSwedishDateTime(raw);

      if (!parsed) {
        return res.json({ replies: ["Vilken tid ungefär? 👍"] });
      }

      state.time = parsed.toISOString();
      saveMemory();
    }

    // -------- BOOKING --------

    await sendBookingEmail(state);

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

app.listen(process.env.PORT || 3000);