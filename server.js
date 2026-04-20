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
  if (msg.match(/\b(rensa|ta bort|clear)\b/i)) return "clear";
  if (msg.match(/\?/)) return "question";
  if (msg.match(/vet inte|kanske/i)) return "hesitation";
  return "normal";
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

// -------- EMAIL (UNCHANGED CORE) --------

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
NY BOKNING

Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${new Date(data.time).toLocaleString("sv-SE")}
    `
  });
}

async function sendUpdateEmail(data) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: OWNER_EMAIL,
    subject: `🔄 Ändrad bokning - ${BUSINESS_NAME}`,
    text: `
UPPDATERAD BOKNING

Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${data.time ? new Date(data.time).toLocaleString("sv-SE") : "ej satt"}
    `
  });
}

async function sendCancelEmail(data) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: OWNER_EMAIL,
    subject: `❌ Avbokning - ${BUSINESS_NAME}`,
    text: `
AVBOKNING

Namn: ${data.name || "okänd"}
Telefon: ${data.phone || "saknas"}
Problem: ${data.problem || "okänt"}
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
    const intent = detectIntent(msg);

    const userId = req.body.userId || "default-user";

    if (!users[userId]) {
      users[userId] = {
        history: [],
        lastSeen: Date.now()
      };
    }

    let state = users[userId];

    state.history.push(raw);
    if (state.history.length > 6) state.history.shift();
    state.lastSeen = Date.now();
    saveMemory();

    // -------- AFTER BOOKING --------

    if (state.booked) {

      if (msg.match(/avboka/i)) {
        await sendCancelEmail(state);
        delete users[userId];
        saveMemory();
        return res.json({ replies: ["Okej 👍 då tar vi bort bokningen"] });
      }

      if (msg.match(/ändra/i)) {
        state.updating = true;
        state.time = null;
        saveMemory();
        return res.json({ replies: ["Självklart 👍 vilken ny tid passar bättre?"] });
      }

      return res.json({
        replies: ["Du är redan bokad 👍 vill du ändra något eller avboka?"]
      });
    }

    // -------- GREETING --------

    if (msg === "hej" || msg === "tja") {
      return res.json({
        replies: ["Tja 👍 vad har hänt?"]
      });
    }

    // -------- CONTACT --------

    if (intent === "contact") {
      await sendCallRequest(state);
      return res.json({
        replies: ["Inga problem 👍 vi ringer upp dig så kollar vi på det"]
      });
    }

    // -------- HESITATION --------

    if (intent === "hesitation") {
      return res.json({
        replies: ["Ingen stress 👍 vi kan ta det när det passar dig — vad är det som strular?"]
      });
    }

    // -------- QUESTIONS (MORE HUMAN) --------

    if (intent === "question") {

      if (msg.includes("sparas")) {
        return res.json({
          replies: ["Ja 👍 den sparas här så du kan fortsätta senare om du vill"]
        });
      }

      if (msg.includes("pris")) {
        return res.json({
          replies: ["Svårt att säga exakt 👍 men vi kan ge bättre svar när vi sett vad det gäller"]
        });
      }

      if (state.problem) {
        return res.json({
          replies: [`Vi löser det 👍 vill du boka eller ska vi ringa dig?`]
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
        replies: [
          "Det där fixar vi 👍 vill du boka en tid eller vill du att vi ringer upp dig?"
        ]
      });
    }

    // -------- BOOK CONFIRM --------

    if (state.readyToBook && !state.confirmedBooking) {

      if (intent === "yes") {
        state.confirmedBooking = true;
        saveMemory();
      }

      else if (intent === "no") {
        state.readyToBook = false;
        saveMemory();

        return res.json({
          replies: ["Lugnt 👍 hör av dig när det passar"]
        });
      }

      else {
        return res.json({
          replies: ["Säg till 👍"]
        });
      }
    }

    // -------- NAME --------

    if (!state.name) {
      state.name = capitalize(raw);
      saveMemory();

      return res.json({
        replies: ["Toppen 👍 vad har du för nummer?"]
      });
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

      return res.json({
        replies: ["Vilken adress gäller det?"]
      });
    }

    // -------- ADDRESS --------

    if (!state.address) {
      if (!isValidAddress(raw)) {
        return res.json({
          replies: ["Skriv adressen 👍"]
        });
      }

      state.address = capitalize(raw);
      saveMemory();

      return res.json({
        replies: ["När passar det bäst för dig? 👍"]
      });
    }

    // -------- TIME --------

    if (!state.time) {
      const parsed = parseSwedishDateTime(raw);

      if (!parsed) {
        return res.json({
          replies: ["Vilken tid ungefär? 👍"]
        });
      }

      state.time = parsed.toISOString();
      saveMemory();
    }

    // -------- BOOKING --------

    if (state.updating) {
      await sendUpdateEmail(state);
      state.updating = false;
    } else {
      await sendBookingEmail(state);
    }

    state.booked = true;
    saveMemory();

    return res.json({
      replies: [
        `Perfekt 👍 vi bokar in dig ${new Date(state.time).toLocaleString("sv-SE")} — vill du ändra något är det bara att skriva 👍`
      ]
    });

  } catch (err) {
    console.error(err);
    res.json({ replies: ["⚠️ Något gick fel"] });
  }
});

app.get("/", (req, res) => {
  res.send(`${BUSINESS_NAME} API running`);
});

app.listen(process.env.PORT || 3000);