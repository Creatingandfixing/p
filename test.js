import fetch from "node-fetch";

const URL = "http://localhost:3000/chat";

function randomUser() {
  return "user_" + Math.floor(Math.random() * 10000);
}

async function send(userId, message) {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, message })
    });

    const data = await res.json();

    console.log(`USER (${userId}):`, message);
    console.log("BOT:", data.replies);
    console.log("------------------------");

    // ✅ THIS IS THE IMPORTANT PART
    await new Promise(r => setTimeout(r, 200));

  } catch (err) {
    console.log("ERROR:", err.message);
  }
}

// -------- TEST CASES --------

// 🧪 full normal flow
async function normalFlow() {
  const user = randomUser();

  await send(user, "hej");
  await send(user, "jag har ett läckage");
  await send(user, "lars andersson");
  await send(user, "0701234567");
  await send(user, "storgatan 5");
  await send(user, "imorgon kl 14");
  await send(user, "ja");
}

// 🧪 all-in-one message
async function allInOne() {
  const user = randomUser();

  await send(user,
    "hej jag heter anna andersson jag har stopp i köket mitt nummer är 0709999999 jag bor på storgatan 5 och vill ha tid imorgon kl 10"
  );
}

// 🧪 broken inputs
async function brokenInput() {
  const user = randomUser();

  await send(user, "???");
  await send(user, "");
  await send(user, null);
  await send(user, "!!!!");
}

// 🧪 wrong order chaos
async function chaosFlow() {
  const user = randomUser();

  await send(user, "0701234567");
  await send(user, "imorgon kl 14");
  await send(user, "storgatan 5");
  await send(user, "lars");
  await send(user, "jag har stopp");
}

// 🧪 spam
async function spamTest() {
  const user = randomUser();

  for (let i = 0; i < 5; i++) {
    await send(user, "hej");
  }
}

// 🧪 spelling errors (AI test)
async function typoTest() {
  const user = randomUser();

  await send(user, "mitt handfat läker");
  await send(user, "jag heter pelle");
  await send(user, "0701111111");
  await send(user, "storgatan 10");
  await send(user, "imorgon kl 09");
  await send(user, "ja");
}

// 🧪 multi users at once
async function multiUserChaos() {
  const users = [randomUser(), randomUser(), randomUser()];

  await Promise.all([
    send(users[0], "jag har ett läckage"),
    send(users[1], "hej"),
    send(users[2], "stopp i köket")
  ]);
}

// -------- RUN ALL --------

async function run() {
  console.log("🔥 STARTING REAL STRESS TEST...\n");

  await normalFlow();
  await allInOne();
  await brokenInput();
  await chaosFlow();
  await spamTest();
  await typoTest();
  await multiUserChaos();

  console.log("\n✅ TEST COMPLETE");
}

run();