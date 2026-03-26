import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // 👈 serve frontend

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
      to: process.env.BOOKING_EMAIL || process.env.EMAIL_USER,
      subject: "🚨 Ny VVS Bokning",
      text: `
Problem: ${data.problem}
Namn: ${data.name}
Telefon: ${data.phone}
Adress: ${data.address}
Tid: ${data.time}
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

// -------- CHAT --------

app.post("/chat", async (req, res) => {
  try {
    const raw = req.body.message;
    const msg = clean(raw);
    const userId = req.body.userId || Math.random().toString(36);

    if (!msg) {
      return res.json({ replies: ["Tja! Vad kan jag hjälpa dig med? 🙂"] });
    }

    if (!users[userId]) users[userId] = {};
    let state = users[userId];

    if (state.lastBooking && Date.now() - state.lastBooking < 60000) {
      return res.json({ replies: ["Jag har redan lagt in det 👍"] });
    }

    const data = await aiExtract(raw);

    if (data.problem && !state.problem) state.problem = data.problem;
    if (data.name && !state.name) state.name = capitalize(data.name);
    if (data.phone && isValidPhone(data.phone)) state.phone = data.phone;
    if (data.address && isValidAddress(data.address)) state.address = capitalize(data.address);
    if (data.time) state.time = data.time;

    // BOOKING
    if (state.problem && state.name && state.phone && state.address && state.time) {
      fs.appendFileSync("bookings.txt", JSON.stringify(state) + "\n");
      await sendBookingEmail(state);

      state.lastBooking = Date.now();
      users[userId] = {};

      return res.json({
        replies: [`Perfekt ${state.name} 👍`, "Vi hör av oss snart!"]
      });
    }

    if (!state.problem) return res.json({ replies: ["Vad har hänt?"] });
    if (!state.name) return res.json({ replies: ["Vad heter du?"] });
    if (!state.phone) return res.json({ replies: ["Telefonnummer?"] });
    if (!state.address) return res.json({ replies: ["Adress?"] });
    if (!state.time) return res.json({ replies: ["När passar det?"] });

    res.json({ replies: ["Berätta mer 🙂"] });

  } catch {
    res.json({ replies: ["Fel uppstod 🤔"] });
  }
});

// -------- AUTH --------

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;

  const [user, pass] = Buffer.from(auth.split(" ")[1], "base64")
    .toString()
    .split(":");

  return user === process.env.DASH_USER && pass === process.env.DASH_PASS;
}

// -------- DASHBOARD --------

app.get("/dashboard", (req, res) => {
  if (!checkAuth(req)) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).send("Login required");
  }

  const data = fs.existsSync("bookings.txt")
    ? fs.readFileSync("bookings.txt", "utf-8")
    : "";

  const bookings = data.split("\n").filter(Boolean).map(JSON.parse);

  let html = `<h1>Bokningar</h1><table border="1">`;

  bookings.reverse().forEach(b => {
    html += `<tr>
      <td>${b.name}</td>
      <td>${b.problem}</td>
      <td>${b.phone}</td>
      <td>${b.address}</td>
      <td>${b.time}</td>
    </tr>`;
  });

  html += "</table>";
  res.send(html);
});

// -------- FRONTEND --------

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 RUNNING");
});