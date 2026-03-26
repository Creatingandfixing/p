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
    return JSON.parse(
      text.replace(/```json/g, "").replace(/```/g, "").trim()
    );
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
      to: process.env.BOOKING_EMAIL,
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
Analysera kundens meddelande till en rörmokare.

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

    // ✅ SPAM PROTECTION
    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({
        replies: ["Jag har redan lagt in det 👍 vi hör av oss"]
      });
    }

    // ✅ AI EXTRACT
    const data = await aiExtract(raw);

    if (data.problem) state.problem = data.problem;
    if (data.details) state.details = data.details;
    if (data.name) state.name = capitalize(data.name);
    if (data.phone && isValidPhone(data.phone)) state.phone = data.phone;
    if (data.address && isValidAddress(data.address)) state.address = capitalize(data.address);
    if (data.time) state.time = data.time;
    if (data.urgency) state.urgency = data.urgency;

    // ✅ INSTANT BOOKING (FIRST PRIORITY)
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
          state.urgency === "high"
            ? "Vi prioriterar detta direkt, hör av oss inom kort."
            : "Jag har lagt in det, vi hör av oss snart."
        ]
      });
    }

    // ✅ GREETING
    const greetings = [
      "hej","hej hej","hejsan","hallå",
      "tjena","tjenare","tja","tjabba",
      "god morgon","god dag","god kväll"
    ];

    const howAreYou = [
      "hur mår du","hur är läget","allt bra"
    ];

    const isGreeting =
      greetings.includes(msg) ||
      howAreYou.some(g => msg.includes(g));

    if (!state.problem && isGreeting) {
      const replies = [
        "Tja! Vad kan jag hjälpa dig med? 🙂",
        "Hallå! Vad verkar vara problemet?",
        "Tjena! Vad har hänt?",
        "Hej! Vad kan jag fixa åt dig?"
      ];

      return res.json({
        replies: [replies[Math.floor(Math.random() * replies.length)]]
      });
    }

    // ✅ FILTER (only plumbing)
    const plumbingKeywords = [
      "stopp","avlopp","läcka","vatten",
      "kran","toalett","rör","handfat","dusch","badkar"
    ];

    const isPlumbing = plumbingKeywords.some(word =>
      (state.problem || "").toLowerCase().includes(word)
    );

    if (!isPlumbing && state.problem) {
      return res.json({
        replies: ["Jag kör bara VVS 😄 gäller det stopp eller läcka?"]
      });
    }

    // ✅ HUMAN REACTION + SMART NEXT STEP
    if (state.problem && !state.reacted) {
      state.reacted = true;

      const urgencyText =
        state.urgency === "high"
          ? "det där vill man lösa snabbt 😅"
          : "det där löser vi 👍";

      let next = "Vad heter du?";

      if (state.name && !state.phone) {
        next = "Vilket nummer når vi dig på?";
      } else if (state.phone && !state.address) {
        next = "Vilken adress gäller det?";
      } else if (state.address && !state.time) {
        next = "När passar det bäst?";
      }

      return res.json({
        replies: [`Okej, ${state.problem} — ${urgencyText} ${next}`]
      });
    }

    // ✅ STEP FLOW
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
        replies: ["Bra, vilken adress gäller det?"]
      });
    }

    if (state.address && !state.time) {
      return res.json({
        replies: ["När passar det bäst för dig?"]
      });
    }

    // fallback
    return res.json({
      replies: ["Berätta lite mer så löser vi det 👍"]
    });

  } catch (err) {
    console.error(err);
    return res.json({
      replies: ["Nåt blev knas 🤔 testa igen"]
    });
  }
});
// -------- SIMPLE AUTH --------

function checkAuth(req) {
  const auth = req.headers.authorization;

  if (!auth) return false;

  const encoded = auth.split(" ")[1];
  const decoded = Buffer.from(encoded, "base64").toString();

  const [user, pass] = decoded.split(":");

  return (
    user === process.env.DASH_USER &&
    pass === process.env.DASH_PASS
  );
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
      .map(line => JSON.parse(line));

    let html = `
      <html>
      <head>
        <title>Dashboard</title>
        <style>
          body { font-family: Arial; padding: 20px; background: #f5f5f5; }
          h1 { margin-bottom: 20px; }
          table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 10px;
            overflow: hidden;
          }
          th, td {
            padding: 12px;
            border-bottom: 1px solid #eee;
            text-align: left;
          }
          th {
            background: #111;
            color: white;
          }
          tr:hover {
            background: #f9f9f9;
          }
          a {
            color: blue;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <h1>📊 Bokningar</h1>
        <table>
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
          <td><a href="tel:${b.phone}">${b.phone || "-"}</a></td>
          <td>${b.address || "-"}</td>
          <td>${b.time || "-"}</td>
        </tr>
      `;
    });

    html += `
        </table>
      </body>
      </html>
    `;

    res.send(html);

  } catch (err) {
    res.send("Error loading dashboard");
  }
});
// ping
app.get("/ping", (req, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL AI BOT RUNNING");
});