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

  if (problem.includes("stopp") || problem.includes("avlopp")) return "stopp";
  if (problem.includes("läcka") || problem.includes("dropp")) return "leak";
  if (problem.includes("ingen vatten") || problem.includes("kommer inget")) return "no_water";
  if (problem.includes("lukt")) return "smell";

  return "other";
}

function getFollowUpQuestion(type) {
  const questions = {
    stopp: [
      "är det helt stopp eller rinner det undan lite?",
      "gäller det kök, badrum eller golvbrunn?"
    ],
    leak: [
      "var läcker det någonstans?",
      "är det mycket vatten eller bara dropp?"
    ],
    no_water: [
      "gäller det hela bostaden eller bara en kran?",
      "slutade det plötsligt eller har det varit så ett tag?"
    ],
    smell: [
      "kommer lukten från avloppet?",
      "har det varit stopp nyligen?"
    ],
    other: [
      "kan du beskriva lite mer exakt vad som händer?"
    ]
  };

  const list = questions[type] || questions.other;
  return list[Math.floor(Math.random() * list.length)];
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
    console.log("Sending email to:", process.env.BOOKING_EMAIL);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.BOOKING_EMAIL || process.env.EMAIL_USER,
      subject: "🚨 Ny VVS Bokning",
      text: `
Problem: ${data.problem || "-"}
Detaljer: ${data.details || "-"}

Namn: ${data.name || "-"}
Telefon: ${data.phone || "-"}
Adress: ${data.address || "-"}
Tid: ${data.time || "-"}
      `
    });
  } catch (err) {
    console.error("Email error:", err.message);
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
  "urgency": "low/medium/high",
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
    const userId =
      req.body?.userId || Math.random().toString(36).slice(2);

    if (!msg) {
      return res.json({
        replies: ["Tja! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    // SAFE STATE INIT
    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    // SPAM PROTECTION
    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({
        replies: ["Jag har redan lagt in det 👍 vi hör av oss"]
      });
    }

    // AI EXTRACTION
    const data = await aiExtract(raw);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.details && !state.details) state.details = data.details;
    if (data.name && !state.name) state.name = capitalize(data.name);
    if (data.phone && !state.phone && isValidPhone(data.phone)) {
      state.phone = data.phone;
    }
    if (data.address && !state.address && isValidAddress(data.address)) {
      state.address = capitalize(data.address);
    }
    if (data.time && !state.time) state.time = data.time;
    if (data.urgency && !state.urgency) state.urgency = data.urgency;

    // INSTANT BOOKING
    if (
      state.problem &&
      state.name &&
      state.phone &&
      state.address &&
      state.time
    ) {
      try {
        fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");
      } catch {}

      await sendBookingEmail(state);

      state.lastBooking = Date.now();

      // ✅ FIXED (KEEP STATE SAFE)
      users[userId] = { lastBooking: state.lastBooking };

      return res.json({
        replies: [
          `Perfekt ${state.name} 👍`,
          state.urgency === "high"
            ? "Vi prioriterar detta direkt."
            : "Vi hör av oss snart!"
        ]
      });
    }

    // GREETING
    const greetings = ["hej","hejsan","hallå","tja","tjena","tjabba"];
    if (!state.problem && greetings.includes(msg)) {
      return res.json({
        replies: ["Tja! Vad kan jag hjälpa dig med? 🙂"]
      });
    }

    // FILTER
    const plumbingKeywords = [
      "stopp","avlopp","läcka","vatten",
      "kran","toalett","rör","handfat","dusch","badkar"
    ];

    const isPlumbing = plumbingKeywords.some(w =>
      (state.problem || "").toLowerCase().includes(w)
    );

    if (!isPlumbing && state.problem) {
      return res.json({
        replies: ["Jag hjälper bara med VVS 😄 gäller det stopp eller läcka?"]
      });
    }

    // INDUSTRY QUESTION
    if (state.problem && !state.deepAsked) {
      state.deepAsked = true;

      const type = getProblemType(state.problem);
      const question = getFollowUpQuestion(type);

      return res.json({
        replies: [`Okej, ${state.problem} — ${question}`]
      });
    }

    // FLOW
    if (state.problem && !state.name) {
      return res.json({ replies: ["Vad heter du?"] });
    }

    if (state.name && !state.phone) {
      return res.json({
        replies: [`Toppen ${state.name} 👍 vilket nummer når vi dig på?`]
      });
    }

    if (state.phone && !state.address) {
      return res.json({
        replies: ["Vilken adress gäller det?"]
      });
    }

    if (state.address && !state.time) {
      return res.json({
        replies: ["När passar det bäst?"]
      });
    }

    return res.json({
      replies: ["Berätta lite mer så löser vi det 👍"]
    });

  } catch (err) {
    console.error("MAIN ERROR:", err.message);
    return res.json({
      replies: ["Nåt blev knas 🤔 testa igen"]
    });
  }
});

// -------- AUTH --------

function checkAuth(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return false;

    const [user, pass] = Buffer.from(
      auth.split(" ")[1],
      "base64"
    ).toString().split(":");

    return (
      user === process.env.DASH_USER &&
      pass === process.env.DASH_PASS
    );
  } catch {
    return false;
  }
}

// -------- DASHBOARD --------

app.get("/dashboard", (req, res) => {
  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).send("Login required");
  }

  try {
    if (!fs.existsSync("bookings.txt")) {
      return res.send("<h2>Inga bokningar ännu</h2>");
    }

    const data = fs.readFileSync("bookings.txt", "utf-8");

    const bookings = data
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let html = `
      <h1>📊 Bokningar</h1>
      <table border="1" cellpadding="10">
        <tr>
          <th>Namn</th>
          <th>Problem</th>
          <th>Telefon</th>
          <th>Adress</th>
          <th>Tid</th>
        </tr>
    `;

    bookings.reverse().forEach(b => {
      html += `
        <tr>
          <td>${b.name || "-"}</td>
          <td>${b.problem || "-"}</td>
          <td>${b.phone || "-"}</td>
          <td>${b.address || "-"}</td>
          <td>${b.time || "-"}</td>
        </tr>
      `;
    });

    html += "</table>";
    res.send(html);

  } catch {
    res.send("Error loading dashboard");
  }
});

// -------- BASIC --------

app.get("/", (req, res) => {
  res.send("🔥 AI Rörmokare är igång");
});

app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 INDUSTRY AI RUNNING");
});