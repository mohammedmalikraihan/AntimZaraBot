const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// ENVIRONMENT VARIABLES — set all in Render
// ============================================================
// ANTHROPIC_API_KEY        — Anthropic API key
// TWILIO_ACCOUNT_SID       — Twilio dashboard homepage
// TWILIO_AUTH_TOKEN        — Twilio dashboard homepage
// TWILIO_WHATSAPP_NUMBER   — e.g. whatsapp:+14155238886
// OWNER_WHATSAPP           — your number e.g. whatsapp:+971501234567
// GOOGLE_SHEETS_WEBHOOK    — Google Apps Script web app URL
// ZAPIER_WEBHOOK           — Zapier webhook URL
// ADMIN_PASSWORD           — password to access admin dashboard
// PAYMENT_LINK_STAG        — payment link for stag entry e.g. https://pay.link/stag
// PAYMENT_LINK_TABLE       — payment link for table deposit e.g. https://pay.link/table
// ============================================================

// ============================================================
// EVENT CONFIG — editable via admin dashboard
// ============================================================
const EVENT_FILE = path.join(__dirname, "event.json");

function loadEvent() {
  try {
    if (fs.existsSync(EVENT_FILE)) {
      return JSON.parse(fs.readFileSync(EVENT_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load event file:", e.message);
  }
  return {
    name: "Antim Saturday",
    club: "Moksha",
    venue: "Capitol Hotel, Al Mina Road, Dubai",
    organizers: "Zenith Nexus & Nyx Nights",
    date: "Saturday, 21st March",
    time: "10:00 PM till late",
    lineup: "DJ Ali x DJ Amit, supported by WHOD",
    ageLimit: "21+",
    doorPolicyLadies: "Free entry + Free Pours until 12:00 AM",
    doorPolicyCouples: "Free Entry",
    doorPolicyStag: "AED 100 entry includes 2 house drinks",
    tableMinimum: "AED 1,500",
    dressCode: "Smart casual to upscale. Dress to impress. No sportswear, no flip flops.",
    mapsLink: "https://maps.app.goo.gl/Gg6V9Lxryo1WMJYu7",
    reservationsNumber: "052 115 2418",
    upcomingEvents: ""
  };
}

function saveEvent(data) {
  fs.writeFileSync(EVENT_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// IN-MEMORY STORAGE
// ============================================================
const conversations = {};
const guestProfiles = {};
const pausedGuests = {};
const messageCounts = {};
const feedbackMode = {};
const stats = {
  totalMessages: 0,
  uniqueGuests: new Set(),
  tableEnquiries: 0,
  guestListRegistrations: 0,
  birthdayGuests: 0,
  feedbackScores: [],
  hourlyMessages: {}
};

const MAX_MESSAGES_PER_GUEST = 30;

// ============================================================
// BUILD SYSTEM PROMPT FROM CURRENT EVENT
// ============================================================
function buildSystemPrompt(guestName) {
  const ev = loadEvent();
  const nameContext = guestName
    ? `\n\nNOTE: This guest's name is ${guestName}. Use their name naturally in replies.`
    : "";

  const paymentLinkStag = process.env.PAYMENT_LINK_STAG || null;
  const paymentLinkTable = process.env.PAYMENT_LINK_TABLE || null;
  const upcomingSection = ev.upcomingEvents
    ? `\nUPCOMING EVENTS:\n${ev.upcomingEvents}`
    : "";

  return `You are Zara, the ultimate insider and hype girl for ${ev.name} at ${ev.club}, Dubai. You are not a robot — you are a fun, warm, bubbly friend who is obsessed with this event and genuinely cares about guests having an amazing time.

Your personality:
- Conversational and warm — like texting a knowledgeable friend
- Use casual language, light humour, and enthusiasm naturally
- Ask follow-up questions to keep the conversation going
- Hype up the event — make guests excited to come
- Use 1-2 emojis per message naturally
- If someone seems unsure about coming, encourage them warmly
- Make small talk if someone just says hey
- Never sound robotic or list things like a brochure

GUEST NAME — IMPORTANT:
- Within the first 2 messages naturally ask for the guest's name
- Once you know it, use it occasionally — makes it feel personal

BIRTHDAY DETECTION:
- If a guest mentions birthday, celebration or surprise, get excited and flag it
- Add [BIRTHDAY_GUEST] at the very end of your reply (hidden tag)
- Offer them something special like a complimentary shoutout or mention to the team

UPSELL — always do this naturally:
- If a stag asks about entry (AED 100), always warmly mention table packages too
- If a lady asks about free entry, mention that tables are great for groups
- Never push hard — just naturally plant the seed${paymentLinkStag ? `
- If a stag wants to pre-pay entry, send them this link: ${paymentLinkStag}` : ""}${paymentLinkTable ? `
- If a guest wants to secure a table with a deposit, send them: ${paymentLinkTable}` : ""}

TABLE BOOKING DETECTION:
- If a guest mentions tables, VIP, bottle service or minimum spend, collect their name and group size
- Say "I'll flag this to the team right away!"
- Add [TABLE_LEAD] at the very end of your reply (hidden tag)

GUEST LIST REGISTRATION:
- If a guest wants to be on the guest list, collect full name and group size
- Confirm warmly once collected
- Add [GUEST_REGISTERED: Name | Group Size] at the very end of your reply

LANGUAGE RULE:
- Match whatever language the guest uses — Arabic or English
- Keep the same warm bubbly tone in both

EVENT DETAILS — weave naturally into conversation:
EVENT: ${ev.name}
CLUB: ${ev.club}
VENUE: ${ev.venue}
ORGANIZERS: ${ev.organizers}
DATE: ${ev.date}
TIME: ${ev.time}
LINEUP: ${ev.lineup}
AGE LIMIT: ${ev.ageLimit}. Valid ID required.
RESERVATIONS: ${ev.reservationsNumber}

DOOR POLICY:
- Ladies: ${ev.doorPolicyLadies}
- Couples: ${ev.doorPolicyCouples}
- Stag: ${ev.doorPolicyStag}

TABLE BOOKINGS: Minimum spend ${ev.tableMinimum}. Contact ${ev.reservationsNumber}.
DRESS CODE: ${ev.dressCode}
LOCATION: ${ev.venue}. Accessible by taxi, Uber, or valet.
GOOGLE MAPS: ${ev.mapsLink}
SET TIMES: Not shared in advance.
${upcomingSection}

Conversation rules:
- 2 to 4 sentences max per message — real WhatsApp style
- Never dump all info at once
- Always share Google Maps when asked for location
- For anything unknown: "Check with the team on ${ev.reservationsNumber} — they're super responsive!"
- Never make up details
- Always stay in character as Zara${nameContext}`;
}

// ============================================================
// TWILIO HELPER
// ============================================================
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function sendWhatsApp(to, message) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!client || !from) {
    console.log("⚠️ Twilio not configured");
    return;
  }
  try {
    await client.messages.create({ from, to, body: message });
    console.log(`✅ Sent to ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send to ${to}:`, err.message);
  }
}

// ============================================================
// SEND TO OWNER
// ============================================================
async function sendToOwner(message) {
  const owner = process.env.OWNER_WHATSAPP;
  if (!owner) return;
  await sendWhatsApp(owner, message);
}

// ============================================================
// CHAT REPORT TO OWNER
// ============================================================
async function sendOwnerReport(guestNumber, guestName, guestMessage, zaraReply) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const dubaiTime = getDubaiTime();
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  const cleanReply = stripTags(zaraReply);
  await sendToOwner(
`📊 *Zara Chat Report*
─────────────────
👤 *Guest:* ${nameDisplay}
🕐 *Time:* ${dubaiTime}

💬 *Guest said:*
${guestMessage}

🤖 *Zara replied:*
${cleanReply}
─────────────────`);
}

// ============================================================
// HOT LEAD ALERT
// ============================================================
async function sendTableLeadAlert(guestNumber, guestName, guestMessage) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  await sendToOwner(
`🔥 *HOT LEAD — Table Enquiry!*
─────────────────
👤 *Guest:* ${nameDisplay}
💬 *They said:* ${guestMessage}

⚡ Follow up NOW on ${cleanNumber}
Min spend: AED 1,500
─────────────────`);
}

// ============================================================
// BIRTHDAY ALERT
// ============================================================
async function sendBirthdayAlert(guestNumber, guestName) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  await sendToOwner(
`🎂 *Birthday Guest Alert!*
─────────────────
👤 *Guest:* ${nameDisplay}
🎉 This guest is celebrating tonight!
Consider a complimentary shoutout or surprise 🥂
─────────────────`);
}

// ============================================================
// GUEST REGISTRATION
// ============================================================
async function handleGuestRegistration(guestNumber, registrationTag) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const match = registrationTag.match(/\[GUEST_REGISTERED:\s*(.+?)\s*\|\s*(.+?)\]/);
  if (!match) return;
  const guestName = match[1].trim();
  const groupSize = match[2].trim();
  const dubaiTime = getDubaiTime();

  if (guestProfiles[guestNumber]) {
    guestProfiles[guestNumber].name = guestName;
    guestProfiles[guestNumber].groupSize = groupSize;
    guestProfiles[guestNumber].registered = true;
  }
  stats.guestListRegistrations++;

  await sendToOwner(
`✅ *New Guest List Registration!*
─────────────────
👤 *Name:* ${guestName}
👥 *Group:* ${groupSize}
📱 *Number:* ${cleanNumber}
🕐 *Time:* ${dubaiTime}
Total tonight: ${stats.guestListRegistrations}
─────────────────`);

  await logToGoogleSheets({
    type: "guest_registration",
    name: guestName,
    groupSize,
    phone: cleanNumber,
    time: dubaiTime,
    event: loadEvent().name
  });

  await triggerZapier({
    type: "guest_registration",
    name: guestName,
    groupSize,
    phone: cleanNumber,
    time: dubaiTime,
    event: loadEvent().name
  });
}

// ============================================================
// GOOGLE SHEETS LOGGING
// ============================================================
async function logToGoogleSheets(data) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(data);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("✅ Logged to Google Sheets");
  } catch (err) {
    console.error("❌ Sheets error:", err.message);
  }
}

// ============================================================
// ZAPIER WEBHOOK
// ============================================================
async function triggerZapier(data) {
  const webhookUrl = process.env.ZAPIER_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(data);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("✅ Zapier triggered");
  } catch (err) {
    console.error("❌ Zapier error:", err.message);
  }
}

// ============================================================
// DAILY SUMMARY
// ============================================================
async function sendDailySummary() {
  const avgFeedback = stats.feedbackScores.length > 0
    ? (stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length).toFixed(1)
    : "No feedback yet";

  await sendToOwner(
`📈 *Zara Daily Summary*
─────────────────
🕐 *Time:* ${getDubaiTime()}
💬 *Total messages:* ${stats.totalMessages}
👤 *Unique guests:* ${stats.uniqueGuests.size}
✅ *Guest registrations:* ${stats.guestListRegistrations}
🔥 *Table enquiries:* ${stats.tableEnquiries}
🎂 *Birthday guests:* ${stats.birthdayGuests}
⭐ *Avg feedback score:* ${avgFeedback}
─────────────────
Powered by Zara 🎧`);

  stats.totalMessages = 0;
  stats.uniqueGuests.clear();
  stats.tableEnquiries = 0;
  stats.guestListRegistrations = 0;
  stats.birthdayGuests = 0;
  stats.feedbackScores = [];
}

// ============================================================
// PRE-EVENT REMINDER BLAST — sends to all registered guests
// ============================================================
async function sendPreEventReminder() {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles)
    .filter(([, p]) => p.registered);

  console.log(`📣 Sending pre-event reminder to ${registered.length} guests`);
  for (const [number] of registered) {
    const name = guestProfiles[number].name;
    const greeting = name ? `Hey ${name}!` : "Hey!";
    await sendWhatsApp(number,
`${greeting} 🎧 Tonight's the night — Antim Saturday at Moksha starts at 10PM!

📍 ${ev.venue}
🗺️ ${ev.mapsLink}

DJ Ali x DJ Amit are ready to go. See you on the dancefloor! 🔥`);
    await new Promise(r => setTimeout(r, 1000));
  }
  await sendToOwner(`✅ Pre-event reminder sent to ${registered.length} registered guests!`);
}

// ============================================================
// POST EVENT FEEDBACK — sends to all registered guests
// ============================================================
async function sendFeedbackRequest() {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles)
    .filter(([, p]) => p.registered);

  for (const [number] of registered) {
    feedbackMode[number] = true;
    const name = guestProfiles[number].name;
    const greeting = name ? `Hey ${name}!` : "Hey!";
    await sendWhatsApp(number,
`${greeting} Hope you had an incredible night at ${ev.name}! 🎧

How was your experience? Rate us 1-5 ⭐ and share any thoughts — we genuinely read every message!`);
    await new Promise(r => setTimeout(r, 1000));
  }
  await sendToOwner(`✅ Feedback request sent to ${registered.length} guests`);
}

// ============================================================
// NEXT EVENT BLAST — announce upcoming event to all guests
// ============================================================
async function sendNextEventBlast(message) {
  const allGuests = Object.keys(guestProfiles);
  console.log(`📣 Sending next event blast to ${allGuests.length} guests`);
  for (const number of allGuests) {
    await sendWhatsApp(number, message);
    await new Promise(r => setTimeout(r, 1000));
  }
  await sendToOwner(`✅ Next event blast sent to ${allGuests.length} guests!`);
}

// ============================================================
// SCHEDULE AUTOMATED TASKS
// ============================================================
function scheduleTask(targetHour, targetMinute, taskFn, label) {
  function schedule() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
    const next = new Date(now);
    next.setHours(targetHour, targetMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next - now;
    console.log(`⏰ ${label} scheduled in ${Math.round(ms / 60000)} minutes`);
    setTimeout(async () => { await taskFn(); schedule(); }, ms);
  }
  schedule();
}

scheduleTask(0, 0, sendDailySummary, "Daily summary");
scheduleTask(20, 0, sendPreEventReminder, "Pre-event reminder");

// ============================================================
// HELPERS
// ============================================================
function getDubaiTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  });
}

function stripTags(text) {
  return text
    .replace(/\[TABLE_LEAD\]/g, "")
    .replace(/\[GUEST_REGISTERED:.*?\]/g, "")
    .replace(/\[BIRTHDAY_GUEST\]/g, "")
    .trim();
}

// ============================================================
// MAIN WHATSAPP WEBHOOK
// ============================================================
app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body ? req.body.Body.trim() : "";
  const from = req.body.From;
  console.log(`📩 ${from}: ${userMessage}`);

  // ── Owner commands ──
  if (from === process.env.OWNER_WHATSAPP) {
    if (userMessage.toUpperCase().startsWith("PAUSE:")) {
      const t = "whatsapp:" + userMessage.split(":")[1].trim();
      pausedGuests[t] = true;
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(`✅ Zara paused for ${t}`);
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase().startsWith("RESUME:")) {
      const t = "whatsapp:" + userMessage.split(":")[1].trim();
      delete pausedGuests[t];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(`✅ Zara resumed for ${t}`);
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase() === "SUMMARY") {
      await sendDailySummary();
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("📊 Summary sent!");
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase() === "REMINDER") {
      await sendPreEventReminder();
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("📣 Reminder blast sent!");
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase() === "FEEDBACK") {
      await sendFeedbackRequest();
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("⭐ Feedback requests sent!");
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase().startsWith("BLAST:")) {
      const blastMsg = userMessage.substring(6).trim();
      await sendNextEventBlast(blastMsg);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("📣 Blast sent to all guests!");
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ── Skip paused guests ──
  if (pausedGuests[from]) {
    return res.type("text/xml").send(new twilio.twiml.MessagingResponse().toString());
  }

  // ── Handle feedback mode ──
  if (feedbackMode[from]) {
    const score = parseInt(userMessage);
    if (score >= 1 && score <= 5) {
      stats.feedbackScores.push(score);
      const name = guestProfiles[from]?.name || "Guest";
      await logToGoogleSheets({
        type: "feedback",
        name,
        phone: from.replace("whatsapp:", ""),
        score,
        comment: userMessage,
        time: getDubaiTime(),
        event: loadEvent().name
      });
      await sendToOwner(`⭐ *Feedback received!*\n👤 ${name}\nScore: ${"⭐".repeat(score)}\nComment: ${userMessage}`);
      await triggerZapier({ type: "feedback", name, score, comment: userMessage, time: getDubaiTime() });
    }
    delete feedbackMode[from];
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Thank you so much! Your feedback means everything to us 🙏 See you at the next one! 🎧");
    return res.type("text/xml").send(twiml.toString());
  }

  // ── Rate limiting ──
  if (!messageCounts[from]) messageCounts[from] = 0;
  messageCounts[from]++;
  if (messageCounts[from] > MAX_MESSAGES_PER_GUEST) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("You've been super chatty! 😄 For more help reach the team on 052 115 2418. See you tonight! 🎧");
    return res.type("text/xml").send(twiml.toString());
  }

  // ── Set up guest profile ──
  if (!guestProfiles[from]) {
    guestProfiles[from] = { name: null, groupSize: null, registered: false, firstSeen: new Date().toISOString() };
  }

  // ── Stats ──
  stats.totalMessages++;
  stats.uniqueGuests.add(from);
  const hour = new Date().getHours();
  stats.hourlyMessages[hour] = (stats.hourlyMessages[hour] || 0) + 1;

  // ── Conversation history ──
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: "user", content: userMessage });
  if (conversations[from].length > 12) conversations[from] = conversations[from].slice(-12);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 350,
      system: buildSystemPrompt(guestProfiles[from].name),
      messages: conversations[from],
    });

    let reply = response.content[0].text;
    conversations[from].push({ role: "assistant", content: reply });

    // ── Detect tags ──
    if (reply.includes("[TABLE_LEAD]")) {
      stats.tableEnquiries++;
      sendTableLeadAlert(from, guestProfiles[from].name, userMessage);
    }
    if (reply.includes("[BIRTHDAY_GUEST]")) {
      stats.birthdayGuests++;
      sendBirthdayAlert(from, guestProfiles[from].name);
    }
    const regMatch = reply.match(/\[GUEST_REGISTERED:.*?\]/);
    if (regMatch) handleGuestRegistration(from, regMatch[0]);

    const cleanReply = stripTags(reply);

    // ── Send to guest ──
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(cleanReply);
    res.type("text/xml").send(twiml.toString());

    // ── Background tasks ──
    sendOwnerReport(from, guestProfiles[from].name, userMessage, reply);
    triggerZapier({
      type: "message",
      guest: from.replace("whatsapp:", ""),
      guestName: guestProfiles[from].name,
      message: userMessage,
      reply: cleanReply,
      time: getDubaiTime()
    });

  } catch (err) {
    console.error("❌ Error:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Heyy! Zara here — tiny tech moment 😅 Ping the team on 052 115 2418 for anything urgent. See you tonight! 🎧");
    res.type("text/xml").send(twiml.toString());
  }
});

// ============================================================
// ADMIN DASHBOARD — update event details
// ============================================================
app.get("/admin", (req, res) => {
  const password = req.query.password;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.send(`
      <html><head><title>Zara Admin</title>
      <style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{background:#1a1608;padding:40px;border-radius:16px;border:0.5px solid #2e2510;text-align:center;width:300px}
      h2{color:#c9a84c;margin-bottom:20px}input{width:100%;padding:10px;background:#0a0a0f;border:0.5px solid #2e2510;color:#e8d9b0;border-radius:8px;margin-bottom:12px;font-size:14px;box-sizing:border-box}
      button{width:100%;padding:10px;background:#c9a84c;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer}</style></head>
      <body><div class="box"><h2>🎧 Zara Admin</h2>
      <form method="get"><input type="password" name="password" placeholder="Enter admin password"/><button type="submit">Login</button></form>
      </div></body></html>`);
  }
  const ev = loadEvent();
  res.send(`
    <html><head><title>Zara Admin Dashboard</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:20px}
      h1{color:#c9a84c;letter-spacing:3px;margin-bottom:6px;font-size:22px}
      p{color:#a89060;margin-bottom:24px;font-size:13px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:800px}
      @media(max-width:600px){.grid{grid-template-columns:1fr}}
      .card{background:#1a1608;border:0.5px solid #2e2510;border-radius:12px;padding:16px}
      label{font-size:11px;color:#a89060;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;margin-top:12px}
      label:first-of-type{margin-top:0}
      input,textarea{width:100%;padding:8px 10px;background:#0a0a0f;border:0.5px solid #2e2510;color:#e8d9b0;border-radius:6px;font-size:13px;font-family:sans-serif}
      textarea{height:80px;resize:vertical}
      .full{grid-column:1/-1}
      button{padding:12px 24px;background:#c9a84c;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:16px}
      .success{background:#0f2e14;border:0.5px solid #22c55e;color:#22c55e;padding:10px 16px;border-radius:8px;margin-bottom:16px;display:none;font-size:13px}
      h3{color:#c9a84c;font-size:13px;margin-bottom:12px;letter-spacing:1px}
    </style></head>
    <body>
    <h1>🎧 ZARA ADMIN</h1>
    <p>Update event details below — changes go live instantly, no code needed</p>
    <div id="success" class="success">✅ Event updated successfully! Zara is now live with the new details.</div>
    <form id="eventForm">
    <div class="grid">
      <div class="card">
        <h3>EVENT BASICS</h3>
        <label>Event Name</label><input name="name" value="${ev.name}"/>
        <label>Club Name</label><input name="club" value="${ev.club}"/>
        <label>Date</label><input name="date" value="${ev.date}"/>
        <label>Time</label><input name="time" value="${ev.time}"/>
        <label>Lineup</label><input name="lineup" value="${ev.lineup}"/>
      </div>
      <div class="card">
        <h3>VENUE & CONTACT</h3>
        <label>Venue / Address</label><input name="venue" value="${ev.venue}"/>
        <label>Organizers</label><input name="organizers" value="${ev.organizers}"/>
        <label>Reservations Number</label><input name="reservationsNumber" value="${ev.reservationsNumber}"/>
        <label>Google Maps Link</label><input name="mapsLink" value="${ev.mapsLink}"/>
      </div>
      <div class="card">
        <h3>DOOR POLICY</h3>
        <label>Age Limit</label><input name="ageLimit" value="${ev.ageLimit}"/>
        <label>Ladies Policy</label><input name="doorPolicyLadies" value="${ev.doorPolicyLadies}"/>
        <label>Couples Policy</label><input name="doorPolicyCouples" value="${ev.doorPolicyCouples}"/>
        <label>Stag Policy</label><input name="doorPolicyStag" value="${ev.doorPolicyStag}"/>
        <label>Table Minimum</label><input name="tableMinimum" value="${ev.tableMinimum}"/>
      </div>
      <div class="card">
        <h3>OTHER</h3>
        <label>Dress Code</label><textarea name="dressCode">${ev.dressCode}</textarea>
        <label>Upcoming Events (optional — shown when guests ask)</label>
        <textarea name="upcomingEvents">${ev.upcomingEvents || ""}</textarea>
      </div>
    </div>
    <button type="submit">💾 Save & Go Live</button>
    </form>
    <script>
      document.getElementById("eventForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target));
        const res = await fetch("/admin/save?password=${password}", {
          method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data)
        });
        if (res.ok) {
          const s = document.getElementById("success");
          s.style.display = "block";
          setTimeout(() => s.style.display = "none", 4000);
        }
      });
    </script>
    </body></html>`);
});

app.post("/admin/save", (req, res) => {
  if (req.query.password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    saveEvent(req.body);
    console.log("✅ Event updated via admin dashboard");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// QR CODE GENERATOR
// ============================================================
app.get("/qr", async (req, res) => {
  const twilioNumber = (process.env.TWILIO_WHATSAPP_NUMBER || "").replace("whatsapp:", "").replace("+", "");
  const ev = loadEvent();
  const waLink = `https://wa.me/${twilioNumber}?text=Hey%20Zara!%20I%27d%20like%20to%20know%20more%20about%20${encodeURIComponent(ev.name)}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(waLink, {
      width: 400,
      margin: 2,
      color: { dark: "#c9a84c", light: "#0a0a0f" }
    });
    res.send(`
      <html><head><title>Zara QR Code</title>
      <style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
      h1{font-size:22px;letter-spacing:3px;color:#c9a84c;margin-bottom:6px}
      p{color:#a89060;font-size:13px;margin-bottom:24px}
      img{border:3px solid #c9a84c;border-radius:12px;max-width:280px}
      .btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#c9a84c;color:#000;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px}
      .url{margin-top:16px;font-size:11px;color:#6b5c30;word-break:break-all;max-width:320px}</style></head>
      <body>
      <h1>🎧 SCAN TO CHAT WITH ZARA</h1>
      <p>${ev.name} · ${ev.club} · ${ev.date}</p>
      <img src="${qrDataUrl}" alt="WhatsApp QR Code"/>
      <a href="${qrDataUrl}" download="zara-qr-${ev.name.replace(/\s+/g, "-").toLowerCase()}.png" class="btn">⬇️ Download for Flyer</a>
      <p class="url">Direct link: ${waLink}</p>
      </body></html>`);
  } catch (err) {
    res.status(500).send("QR generation failed: " + err.message);
  }
});

// ============================================================
// GUEST LIST PAGE
// ============================================================
app.get("/guestlist", (req, res) => {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles)
    .filter(([, p]) => p.registered)
    .map(([number, p]) => ({
      name: p.name || "—",
      groupSize: p.groupSize || "—",
      phone: number.replace("whatsapp:", ""),
      firstContact: new Date(p.firstSeen).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })
    }));

  const totalPeople = registered.reduce((sum, g) => {
    const n = parseInt(g.groupSize);
    return sum + (isNaN(n) ? 1 : n);
  }, 0);

  const rows = registered.map((g, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${g.name}</strong></td>
      <td>${g.groupSize}</td>
      <td>${g.phone}</td>
      <td>${g.firstContact}</td>
    </tr>`).join("");

  res.send(`
    <html><head><title>Guest List — ${ev.name}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:24px}
      h1{color:#c9a84c;letter-spacing:3px;font-size:20px;margin-bottom:4px}
      p{color:#a89060;font-size:13px;margin-bottom:20px}
      .badges{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
      .badge{background:#1a1608;border:0.5px solid #2e2510;padding:8px 14px;border-radius:8px;font-size:12px}
      .badge span{color:#c9a84c;font-weight:bold;font-size:18px;display:block}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th{background:#1a1608;color:#c9a84c;padding:10px 12px;text-align:left;font-size:11px;letter-spacing:0.5px;text-transform:uppercase}
      td{padding:10px 12px;border-bottom:0.5px solid #1a1608}
      tr:hover td{background:#1a1608}
      .empty{text-align:center;padding:40px;color:#6b5c30}
    </style></head>
    <body>
    <h1>🎧 ${ev.name.toUpperCase()} — GUEST LIST</h1>
    <p>${ev.club} · ${ev.venue} · ${ev.date}</p>
    <div class="badges">
      <div class="badge"><span>${registered.length}</span>Groups registered</div>
      <div class="badge"><span>${totalPeople}</span>Total people</div>
      <div class="badge"><span>${stats.uniqueGuests.size}</span>Total enquiries</div>
      <div class="badge"><span>${stats.tableEnquiries}</span>Table leads</div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Name</th><th>Group Size</th><th>WhatsApp</th><th>First Contact</th></tr></thead>
      <tbody>${rows.length > 0 ? rows : `<tr><td colspan="5" class="empty">No guests registered yet</td></tr>`}</tbody>
    </table>
    </body></html>`);
});

// ============================================================
// LIVE STATS DASHBOARD
// ============================================================
app.get("/dashboard", (req, res) => {
  const ev = loadEvent();
  const avgFeedback = stats.feedbackScores.length > 0
    ? (stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length).toFixed(1)
    : "—";
  const busiest = Object.entries(stats.hourlyMessages)
    .sort(([, a], [, b]) => b - a)[0];
  const busiestHour = busiest ? `${busiest[0]}:00 (${busiest[1]} msgs)` : "—";

  res.send(`
    <html><head><title>Zara Live Dashboard</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="30">
    <style>
      body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:24px}
      h1{color:#c9a84c;letter-spacing:3px;font-size:20px;margin-bottom:4px}
      p{color:#a89060;font-size:12px;margin-bottom:20px}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
      .card{background:#1a1608;border:0.5px solid #2e2510;border-radius:12px;padding:16px}
      .card .val{font-size:32px;font-weight:bold;color:#c9a84c;line-height:1}
      .card .label{font-size:11px;color:#a89060;margin-top:6px;text-transform:uppercase;letter-spacing:0.5px}
      .live{display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:50%;margin-right:6px;animation:pulse 1.5s infinite}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    </style></head>
    <body>
    <h1><span class="live"></span>ZARA LIVE DASHBOARD</h1>
    <p>${ev.name} · ${ev.club} · Refreshes every 30 seconds · ${getDubaiTime()}</p>
    <div class="grid">
      <div class="card"><div class="val">${stats.totalMessages}</div><div class="label">Total Messages</div></div>
      <div class="card"><div class="val">${stats.uniqueGuests.size}</div><div class="label">Unique Guests</div></div>
      <div class="card"><div class="val">${stats.guestListRegistrations}</div><div class="label">Registered</div></div>
      <div class="card"><div class="val">${stats.tableEnquiries}</div><div class="label">Table Leads</div></div>
      <div class="card"><div class="val">${stats.birthdayGuests}</div><div class="label">Birthdays</div></div>
      <div class="card"><div class="val">${avgFeedback}</div><div class="label">Avg Feedback</div></div>
      <div class="card"><div class="val">${Object.keys(pausedGuests).length}</div><div class="label">Paused Guests</div></div>
      <div class="card"><div class="val" style="font-size:14px">${busiestHour}</div><div class="label">Busiest Hour</div></div>
    </div>
    </body></html>`);
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/", (req, res) => res.send("Zara bot is running! 🎧"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zara bot running on port ${PORT}`));
