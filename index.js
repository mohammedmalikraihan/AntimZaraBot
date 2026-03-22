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
// ANTHROPIC_API_KEY         — Anthropic API key
// TWILIO_ACCOUNT_SID        — Twilio dashboard
// TWILIO_AUTH_TOKEN         — Twilio dashboard
// TWILIO_WHATSAPP_NUMBER    — e.g. whatsapp:+14155238886
// OWNER_WHATSAPP            — your number e.g. whatsapp:+971XXXXXXXXX
// RESERVATIONS_WHATSAPP     — reservations team number e.g. whatsapp:+971XXXXXXXXX
// MANAGER_WHATSAPP          — manager number e.g. whatsapp:+971XXXXXXXXX
// HOST_WHATSAPP             — host/door number e.g. whatsapp:+971XXXXXXXXX
// DOOR_STAFF_WHATSAPP       — door staff number e.g. whatsapp:+971XXXXXXXXX
// GOOGLE_SHEETS_WEBHOOK     — Google Apps Script URL
// ZAPIER_WEBHOOK            — Zapier webhook URL
// ADMIN_PASSWORD            — your chosen admin password
// PAYMENT_LINK_STAG         — payment URL for stag entry
// PAYMENT_LINK_TABLE        — payment URL for table deposit
// EARLY_BIRD_LINK           — early bird ticket payment link
// ============================================================

// ============================================================
// EVENT CONFIG
// ============================================================
const EVENT_FILE = path.join(__dirname, "event.json");

function loadEvent() {
  try {
    if (fs.existsSync(EVENT_FILE)) {
      return JSON.parse(fs.readFileSync(EVENT_FILE, "utf8"));
    }
  } catch (e) { console.error("Event load error:", e.message); }
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
    upcomingEvents: "",
    earlyBirdPrice: "",
    groupDiscountThreshold: "6",
    groupDiscountOffer: "a complimentary bottle",
    faq: ""
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
const blockedGuests = {};
const tableFollowUpTimers = {};
const referralCodes = {};
const eventHistory = {};

const stats = {
  totalMessages: 0,
  uniqueGuests: new Set(),
  tableEnquiries: 0,
  guestListRegistrations: 0,
  birthdayGuests: 0,
  feedbackScores: [],
  hourlyMessages: {},
  previousEventStats: null
};

const MAX_MESSAGES_PER_GUEST = 30;
const EARLY_BIRD_HOURS = 4;

// ============================================================
// SYSTEM PROMPT
// ============================================================
function buildSystemPrompt(guestProfile) {
  const ev = loadEvent();
  const name = guestProfile?.name;
  const isReturning = guestProfile?.eventCount > 1;
  const isVIP = guestProfile?.eventCount >= 3;
  const nameContext = name ? `\n\nGUEST NAME: ${name}. Use their name naturally in replies.` : "";
  const returningContext = isReturning ? `\n\nRETURNING GUEST: This guest has attended before. Greet them warmly like an old friend — "Welcome back!"` : "";
  const vipContext = isVIP ? `\n\nVIP GUEST: This guest has attended 3+ events. They are VIP — make them feel extra special, mention exclusive perks.` : "";

  const paymentStag = process.env.PAYMENT_LINK_STAG || null;
  const paymentTable = process.env.PAYMENT_LINK_TABLE || null;
  const earlyBird = process.env.EARLY_BIRD_LINK || null;
  const groupThreshold = ev.groupDiscountThreshold || "6";
  const groupOffer = ev.groupDiscountOffer || "a complimentary bottle";
  const faqSection = ev.faq ? `\nFREQUENTLY ASKED QUESTIONS:\n${ev.faq}` : "";
  const upcomingSection = ev.upcomingEvents ? `\nUPCOMING EVENTS:\n${ev.upcomingEvents}` : "";

  return `You are Zara, the ultimate insider and hype girl for ${ev.name} at ${ev.club}, Dubai. You are warm, bubbly, fun — like a well-connected friend, not a robot.

PERSONALITY:
- Conversational and warm — like texting a knowledgeable friend
- Casual language, light humour, genuine enthusiasm
- Ask follow-up questions naturally
- Hype the event — make guests excited
- 1-2 emojis per message max
- Make small talk if someone just says hey
- Never sound robotic or list things like a brochure

LANGUAGE: Match whatever language the guest uses — Arabic or English. Same warm personality in both.

GUEST NAME: Always ask naturally within first 2 messages. Use their name occasionally once known.${nameContext}${returningContext}${vipContext}

INAPPROPRIATE MESSAGES:
- If a guest sends rude, abusive or inappropriate messages, stay calm and professional
- Respond with: "Hey, let's keep things friendly! I'm here to help you have a great night 😊"
- Add [INAPPROPRIATE_MSG] tag at end of reply so the team is alerted

BIRTHDAY DETECTION:
- Get excited if guest mentions birthday or celebration
- Add [BIRTHDAY_GUEST] at end of reply
- Offer them a complimentary shoutout mention to the team

UPSELL — do this naturally every time:
- Stag asking about entry → also mention table packages
- Lady asking about free entry → mention tables are great for groups
- Anyone in a large group → mention group offer${paymentStag ? `\n- Stag wanting to pre-pay: send ${paymentStag}` : ""}${paymentTable ? `\n- Table deposit: send ${paymentTable}` : ""}${earlyBird ? `\n- Early enquiry (more than 3 hours before event): offer early bird deal: ${earlyBird}` : ""}

GROUP DISCOUNT:
- If guest registers ${groupThreshold}+ people, offer them ${groupOffer}
- Add [GROUP_DISCOUNT: name | groupSize] at end of reply

TABLE BOOKING:
- If guest mentions tables, VIP, bottles or minimum spend, collect name and group size
- Say "I'll flag this to the team right away!"
- Add [TABLE_LEAD] at end of reply
- If guest asks about table but goes quiet, system will follow up automatically

GUEST LIST REGISTRATION:
- Collect full name and group size
- Confirm warmly
- Add [GUEST_REGISTERED: Name | Group Size] at end of reply

ABANDONED TABLE FOLLOW-UP:
- If you detect [TABLE_LEAD], system will follow up in 2 hours automatically

EVENT DETAILS — weave naturally into conversation:
EVENT: ${ev.name} | CLUB: ${ev.club}
VENUE: ${ev.venue} | ORGANIZERS: ${ev.organizers}
DATE: ${ev.date} | TIME: ${ev.time}
LINEUP: ${ev.lineup} | AGE: ${ev.ageLimit}+, valid ID required
RESERVATIONS: ${ev.reservationsNumber}

DOOR POLICY:
- Ladies: ${ev.doorPolicyLadies}
- Couples: ${ev.doorPolicyCouples}
- Stag: ${ev.doorPolicyStag}

TABLES: Min ${ev.tableMinimum}. Contact ${ev.reservationsNumber}
DRESS: ${ev.dressCode}
LOCATION: ${ev.venue} — taxi, Uber or valet
MAPS: ${ev.mapsLink}
SET TIMES: Not shared in advance.
${faqSection}${upcomingSection}

RULES:
- 2-4 sentences max per message — real WhatsApp style
- Never dump all info at once
- Always share Maps link when asked for location
- Unknown info: "Check with team on ${ev.reservationsNumber} — they're super responsive!"
- Never make up details
- Always stay in character as Zara`;
}

// ============================================================
// REFERRAL CODE GENERATOR
// ============================================================
function generateReferralCode(name) {
  const code = (name.substring(0, 3).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase());
  return code;
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
  if (!client || !from) { console.log("⚠️ Twilio not configured"); return; }
  try {
    await client.messages.create({ from, to, body: message });
    console.log(`✅ Sent to ${to}`);
  } catch (err) { console.error(`❌ Failed to send to ${to}:`, err.message); }
}

// ============================================================
// MULTI-TEAM ALERTS
// ============================================================
async function alertTeam(type, message) {
  const routing = {
    table_lead: process.env.RESERVATIONS_WHATSAPP,
    vip_alert: process.env.HOST_WHATSAPP,
    birthday: process.env.HOST_WHATSAPP,
    report: process.env.MANAGER_WHATSAPP,
    door_check: process.env.DOOR_STAFF_WHATSAPP,
    inappropriate: process.env.OWNER_WHATSAPP,
    general: process.env.OWNER_WHATSAPP
  };
  const recipient = routing[type] || process.env.OWNER_WHATSAPP;
  if (recipient) await sendWhatsApp(recipient, message);
  // Always send critical alerts to owner too
  if (type === "table_lead" && process.env.OWNER_WHATSAPP && recipient !== process.env.OWNER_WHATSAPP) {
    await sendWhatsApp(process.env.OWNER_WHATSAPP, message);
  }
}

// ============================================================
// CHAT REPORT
// ============================================================
async function sendOwnerReport(guestNumber, guestName, guestMessage, zaraReply) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const dubaiTime = getDubaiTime();
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  await alertTeam("report",
`📊 *Zara Chat Report*
─────────────────
👤 *Guest:* ${nameDisplay}
🕐 *Time:* ${dubaiTime}

💬 *Guest said:*
${guestMessage}

🤖 *Zara replied:*
${stripTags(zaraReply)}
─────────────────`);
}

// ============================================================
// TABLE LEAD ALERT + ABANDONED FOLLOW-UP
// ============================================================
async function handleTableLead(guestNumber, guestName, guestMessage) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  stats.tableEnquiries++;

  await alertTeam("table_lead",
`🔥 *HOT LEAD — Table Enquiry!*
─────────────────
👤 *Guest:* ${nameDisplay}
💬 *They said:* ${guestMessage}

⚡ Follow up NOW on ${cleanNumber}
Min spend: AED 1,500
─────────────────`);

  // Schedule abandoned follow-up in 2 hours
  if (tableFollowUpTimers[guestNumber]) clearTimeout(tableFollowUpTimers[guestNumber]);
  tableFollowUpTimers[guestNumber] = setTimeout(async () => {
    if (!guestProfiles[guestNumber]?.tableBooked) {
      const firstName = guestName ? guestName.split(" ")[0] : "Hey";
      await sendWhatsApp(guestNumber,
`${firstName}! 👋 Just checking in — are you still thinking about a table tonight? We have a couple of great spots left and I'd love to get you sorted 🎧 Drop me a message or call the team on ${loadEvent().reservationsNumber}!`);
    }
  }, 2 * 60 * 60 * 1000);
}

// ============================================================
// GROUP DISCOUNT HANDLER
// ============================================================
async function handleGroupDiscount(guestNumber, tag) {
  const match = tag.match(/\[GROUP_DISCOUNT:\s*(.+?)\s*\|\s*(\d+)\]/);
  if (!match) return;
  const name = match[1].trim();
  const size = parseInt(match[2]);
  const ev = loadEvent();
  const threshold = parseInt(ev.groupDiscountThreshold) || 6;
  if (size >= threshold) {
    await alertTeam("general",
`🎉 *Large Group Registration!*
─────────────────
👤 *Name:* ${name}
👥 *Group:* ${size} people
📱 *Number:* ${guestNumber.replace("whatsapp:", "")}
🎁 *Offer triggered:* ${ev.groupDiscountOffer}
─────────────────`);
  }
}

// ============================================================
// BIRTHDAY ALERT
// ============================================================
async function handleBirthday(guestNumber, guestName) {
  stats.birthdayGuests++;
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  await alertTeam("birthday",
`🎂 *Birthday Guest!*
─────────────────
👤 *Guest:* ${nameDisplay}
🎉 Celebrating tonight — arrange a complimentary shoutout or surprise! 🥂
─────────────────`);
}

// ============================================================
// INAPPROPRIATE MESSAGE ALERT
// ============================================================
async function handleInappropriate(guestNumber, guestMessage) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  await alertTeam("inappropriate",
`⚠️ *Inappropriate Message Alert*
─────────────────
📱 *From:* ${cleanNumber}
💬 *Message:* ${guestMessage}

Consider blocking: send BLOCK:${cleanNumber} to take action
─────────────────`);
}

// ============================================================
// GUEST REGISTRATION + REFERRAL CODE
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

  // Generate referral code
  const refCode = generateReferralCode(guestName);
  referralCodes[refCode] = { owner: guestNumber, name: guestName, referrals: 0 };
  guestProfiles[guestNumber].referralCode = refCode;

  // Send referral code to guest
  setTimeout(async () => {
    await sendWhatsApp(guestNumber,
`🎉 You're on the list ${guestName}! See you tonight at ${loadEvent().name}!

🎁 *Your personal referral code: ${refCode}*
Share it with friends — when they register using your code, you both get a free drink on us! 🥂`);
  }, 3000);

  await alertTeam("general",
`✅ *New Guest Registration!*
─────────────────
👤 *Name:* ${guestName}
👥 *Group:* ${groupSize}
📱 *Number:* ${cleanNumber}
🎟️ *Ref code:* ${refCode}
🕐 *Time:* ${dubaiTime}
Total tonight: ${stats.guestListRegistrations}
─────────────────`);

  await logToGoogleSheets({ type: "guest_registration", name: guestName, groupSize, phone: cleanNumber, time: dubaiTime, event: loadEvent().name, referralCode: refCode });
  await triggerZapier({ type: "guest_registration", name: guestName, groupSize, phone: cleanNumber, time: dubaiTime, event: loadEvent().name });
}

// ============================================================
// GOOGLE SHEETS
// ============================================================
async function logToGoogleSheets(data) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(data);
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("✅ Sheets logged");
  } catch (err) { console.error("❌ Sheets error:", err.message); }
}

// ============================================================
// ZAPIER
// ============================================================
async function triggerZapier(data) {
  const webhookUrl = process.env.ZAPIER_WEBHOOK;
  if (!webhookUrl) return;
  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(data);
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => { res.on("data", () => {}); res.on("end", resolve); });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("✅ Zapier triggered");
  } catch (err) { console.error("❌ Zapier error:", err.message); }
}

// ============================================================
// DAILY SUMMARY
// ============================================================
async function sendDailySummary() {
  const prev = stats.previousEventStats;
  const avgFeedback = stats.feedbackScores.length > 0
    ? (stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length).toFixed(1) : "—";
  const busiest = Object.entries(stats.hourlyMessages).sort(([, a], [, b]) => b - a)[0];

  let comparison = "";
  if (prev) {
    const guestDiff = stats.uniqueGuests.size - prev.uniqueGuests;
    const regDiff = stats.guestListRegistrations - prev.registrations;
    comparison = `\n📈 *vs last event:* ${guestDiff >= 0 ? "+" : ""}${guestDiff} guests, ${regDiff >= 0 ? "+" : ""}${regDiff} registrations`;
  }

  await alertTeam("report",
`📈 *Zara Daily Summary*
─────────────────
🕐 *Time:* ${getDubaiTime()}
💬 *Total messages:* ${stats.totalMessages}
👤 *Unique guests:* ${stats.uniqueGuests.size}
✅ *Registrations:* ${stats.guestListRegistrations}
🔥 *Table enquiries:* ${stats.tableEnquiries}
🎂 *Birthdays:* ${stats.birthdayGuests}
⭐ *Avg feedback:* ${avgFeedback}
⏰ *Busiest hour:* ${busiest ? busiest[0] + ":00 (" + busiest[1] + " msgs)" : "—"}${comparison}
─────────────────
Powered by Zara 🎧`);

  // Save for comparison next time
  stats.previousEventStats = {
    uniqueGuests: stats.uniqueGuests.size,
    registrations: stats.guestListRegistrations,
    tableEnquiries: stats.tableEnquiries
  };

  // Reset
  stats.totalMessages = 0;
  stats.uniqueGuests.clear();
  stats.tableEnquiries = 0;
  stats.guestListRegistrations = 0;
  stats.birthdayGuests = 0;
  stats.feedbackScores = [];
  stats.hourlyMessages = {};
}

// ============================================================
// TEAM HANDOVER NOTES — sent at 9PM on event night
// ============================================================
async function sendTeamHandover() {
  const ev = loadEvent();
  const registered = Object.values(guestProfiles).filter(p => p.registered);
  const totalPeople = registered.reduce((sum, g) => sum + (parseInt(g.groupSize) || 1), 0);
  const birthdays = registered.filter(p => p.hasBirthday).map(p => p.name).join(", ") || "None";
  const vips = registered.filter(p => (p.eventCount || 0) >= 3).map(p => p.name).join(", ") || "None";

  const msg =
`📋 *Team Handover — ${ev.name}*
─────────────────
🕐 Doors: ${ev.time}
📍 ${ev.venue}
🎧 ${ev.lineup}

👥 *Registered guests:* ${registered.length} groups (${totalPeople} people)
🎂 *Birthdays tonight:* ${birthdays}
⭐ *VIP guests:* ${vips}
🔥 *Table enquiries:* ${stats.tableEnquiries}

Have an amazing night! 🎧
─────────────────`;

  if (process.env.OWNER_WHATSAPP) await sendWhatsApp(process.env.OWNER_WHATSAPP, msg);
  if (process.env.HOST_WHATSAPP) await sendWhatsApp(process.env.HOST_WHATSAPP, msg);
  if (process.env.DOOR_STAFF_WHATSAPP) await sendWhatsApp(process.env.DOOR_STAFF_WHATSAPP, msg);
}

// ============================================================
// PRE-EVENT REMINDER
// ============================================================
async function sendPreEventReminder() {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles).filter(([, p]) => p.registered);
  for (const [number, profile] of registered) {
    const greeting = profile.name ? `Hey ${profile.name.split(" ")[0]}!` : "Hey!";
    await sendWhatsApp(number,
`${greeting} 🎧 Tonight's the night — ${ev.name} starts at ${ev.time}!

📍 ${ev.venue}
🗺️ ${ev.mapsLink}

${ev.lineup} are ready to go. See you on the dancefloor! 🔥`);
    await new Promise(r => setTimeout(r, 1000));
  }
  await alertTeam("report", `✅ Pre-event reminder sent to ${registered.length} registered guests!`);
}

// ============================================================
// POST EVENT FEEDBACK
// ============================================================
async function sendFeedbackRequest() {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles).filter(([, p]) => p.registered);
  for (const [number, profile] of registered) {
    feedbackMode[number] = true;
    const greeting = profile.name ? `Hey ${profile.name.split(" ")[0]}!` : "Hey!";
    await sendWhatsApp(number,
`${greeting} Hope you had an incredible night at ${ev.name}! 🎧

Rate your experience 1-5 ⭐ and share any thoughts — we read every message and it really helps us improve!

Also if you had an amazing time, we'd love a tag on Instagram 📸 @${ev.club.toLowerCase().replace(/\s/g, "")}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  await alertTeam("report", `✅ Feedback requests sent to ${registered.length} guests`);
}

// ============================================================
// NEXT EVENT BLAST — segmented by guest type
// ============================================================
async function sendSegmentedBlast(message, segment) {
  let targets = Object.entries(guestProfiles);
  if (segment === "vip") targets = targets.filter(([, p]) => (p.eventCount || 0) >= 3);
  else if (segment === "ladies") targets = targets.filter(([, p]) => p.gender === "female");
  else if (segment === "registered") targets = targets.filter(([, p]) => p.registered);

  for (const [number] of targets) {
    await sendWhatsApp(number, message);
    await new Promise(r => setTimeout(r, 1000));
  }
  await alertTeam("report", `✅ Blast sent to ${targets.length} guests (segment: ${segment || "all"})`);
}

// ============================================================
// WEEKLY REPORT — every Monday 9AM
// ============================================================
async function sendWeeklyReport() {
  const totalGuests = Object.keys(guestProfiles).length;
  const vipGuests = Object.values(guestProfiles).filter(p => (p.eventCount || 0) >= 3).length;
  const avgFeedback = stats.feedbackScores.length > 0
    ? (stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length).toFixed(1) : "—";

  await alertTeam("report",
`📊 *Zara Weekly Report*
─────────────────
🕐 *Week ending:* ${getDubaiTime()}
👤 *Total guest database:* ${totalGuests}
⭐ *VIP guests (3+ events):* ${vipGuests}
✅ *Total registrations ever:* ${Object.values(guestProfiles).filter(p => p.registered).length}
⭐ *Overall avg feedback:* ${avgFeedback}
🎟️ *Referral codes issued:* ${Object.keys(referralCodes).length}
─────────────────
Have a great week! 🎧`);
}

// ============================================================
// SCHEDULE TASKS
// ============================================================
function scheduleTask(targetHour, targetMinute, taskFn, label, dayOfWeek) {
  function schedule() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
    const next = new Date(now);
    next.setHours(targetHour, targetMinute, 0, 0);
    if (dayOfWeek !== undefined) {
      while (next.getDay() !== dayOfWeek || next <= now) next.setDate(next.getDate() + 1);
    } else if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    const ms = next - now;
    console.log(`⏰ ${label} in ${Math.round(ms / 60000)} minutes`);
    setTimeout(async () => { await taskFn(); schedule(); }, ms);
  }
  schedule();
}

scheduleTask(0, 0, sendDailySummary, "Daily summary");
scheduleTask(20, 0, sendPreEventReminder, "Pre-event reminder");
scheduleTask(21, 0, sendTeamHandover, "Team handover");
scheduleTask(9, 0, sendWeeklyReport, "Weekly report", 1); // Monday

// ============================================================
// HELPERS
// ============================================================
function getDubaiTime() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true
  });
}

function stripTags(text) {
  return text
    .replace(/\[TABLE_LEAD\]/g, "")
    .replace(/\[GUEST_REGISTERED:.*?\]/g, "")
    .replace(/\[BIRTHDAY_GUEST\]/g, "")
    .replace(/\[INAPPROPRIATE_MSG\]/g, "")
    .replace(/\[GROUP_DISCOUNT:.*?\]/g, "")
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
    const cmd = userMessage.toUpperCase();
    if (cmd.startsWith("PAUSE:")) { pausedGuests["whatsapp:" + userMessage.split(":")[1].trim()] = true; return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("✅ Paused").toString()); }
    if (cmd.startsWith("RESUME:")) { delete pausedGuests["whatsapp:" + userMessage.split(":")[1].trim()]; return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("✅ Resumed").toString()); }
    if (cmd.startsWith("BLOCK:")) { blockedGuests["whatsapp:" + userMessage.split(":")[1].trim()] = true; return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("✅ Blocked").toString()); }
    if (cmd.startsWith("UNBLOCK:")) { delete blockedGuests["whatsapp:" + userMessage.split(":")[1].trim()]; return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("✅ Unblocked").toString()); }
    if (cmd === "SUMMARY") { await sendDailySummary(); return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("📊 Sent!").toString()); }
    if (cmd === "REMINDER") { await sendPreEventReminder(); return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("📣 Sent!").toString()); }
    if (cmd === "FEEDBACK") { await sendFeedbackRequest(); return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("⭐ Sent!").toString()); }
    if (cmd === "HANDOVER") { await sendTeamHandover(); return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("📋 Sent!").toString()); }
    if (cmd === "WEEKLY") { await sendWeeklyReport(); return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message("📊 Sent!").toString()); }
    if (cmd.startsWith("BLAST:")) {
      const parts = userMessage.substring(6).split("|");
      const msg = parts[0].trim();
      const segment = parts[1] ? parts[1].trim().toLowerCase() : "all";
      await sendSegmentedBlast(msg, segment);
      return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(`📣 Blast sent! (${segment})`).toString());
    }
    if (cmd.startsWith("CHECK:")) {
      const guestName = userMessage.substring(6).trim().toLowerCase();
      const found = Object.entries(guestProfiles).filter(([, p]) => p.name && p.name.toLowerCase().includes(guestName) && p.registered);
      const reply = found.length > 0
        ? found.map(([, p]) => `✅ ${p.name} — Group of ${p.groupSize || "?"}`).join("\n")
        : `❌ "${userMessage.substring(6).trim()}" not found on guest list`;
      return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(reply).toString());
    }
  }

  // ── Door staff check — any team member can check guest list ──
  if (from === process.env.DOOR_STAFF_WHATSAPP && userMessage.toUpperCase().startsWith("CHECK:")) {
    const guestName = userMessage.substring(6).trim().toLowerCase();
    const found = Object.entries(guestProfiles).filter(([, p]) => p.name && p.name.toLowerCase().includes(guestName) && p.registered);
    const reply = found.length > 0
      ? found.map(([, p]) => `✅ ${p.name} — Group of ${p.groupSize || "?"}`).join("\n")
      : `❌ "${userMessage.substring(6).trim()}" not on guest list`;
    return res.type("text/xml").send(new twilio.twiml.MessagingResponse().message(reply).toString());
  }

  // ── Skip blocked/paused guests ──
  if (blockedGuests[from] || pausedGuests[from]) {
    return res.type("text/xml").send(new twilio.twiml.MessagingResponse().toString());
  }

  // ── Handle feedback mode ──
  if (feedbackMode[from]) {
    const score = parseInt(userMessage);
    if (score >= 1 && score <= 5) {
      stats.feedbackScores.push(score);
      const profile = guestProfiles[from] || {};
      await logToGoogleSheets({ type: "feedback", name: profile.name, phone: from.replace("whatsapp:", ""), score, comment: userMessage, time: getDubaiTime(), event: loadEvent().name });
      await triggerZapier({ type: "feedback", name: profile.name, score, comment: userMessage, time: getDubaiTime() });
      await alertTeam("report", `⭐ *Feedback:* ${profile.name || from.replace("whatsapp:", "")} gave ${score}/5 — "${userMessage}"`);
    }
    delete feedbackMode[from];
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Thank you so much! 🙏 Your feedback means the world to us. See you at the next one! 🎧");
    return res.type("text/xml").send(twiml.toString());
  }

  // ── Check referral code ──
  const upperMsg = userMessage.toUpperCase();
  if (referralCodes[upperMsg]) {
    const refData = referralCodes[upperMsg];
    refData.referrals++;
    if (guestProfiles[refData.owner]) {
      await sendWhatsApp(refData.owner, `🎉 Your referral code was just used! You're racking up rewards — see you tonight! 🥂`);
    }
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
    guestProfiles[from] = { name: null, groupSize: null, registered: false, firstSeen: new Date().toISOString(), eventCount: 1, tableBooked: false, hasBirthday: false };
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
      system: buildSystemPrompt(guestProfiles[from]),
      messages: conversations[from],
    });

    let reply = response.content[0].text;
    conversations[from].push({ role: "assistant", content: reply });

    // ── Detect and handle all tags ──
    if (reply.includes("[TABLE_LEAD]")) handleTableLead(from, guestProfiles[from].name, userMessage);
    if (reply.includes("[BIRTHDAY_GUEST]")) { guestProfiles[from].hasBirthday = true; handleBirthday(from, guestProfiles[from].name); }
    if (reply.includes("[INAPPROPRIATE_MSG]")) handleInappropriate(from, userMessage);
    const regMatch = reply.match(/\[GUEST_REGISTERED:.*?\]/);
    if (regMatch) handleGuestRegistration(from, regMatch[0]);
    const groupMatch = reply.match(/\[GROUP_DISCOUNT:.*?\]/);
    if (groupMatch) handleGroupDiscount(from, groupMatch[0]);

    const cleanReply = stripTags(reply);

    // ── Send to guest ──
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(cleanReply);
    res.type("text/xml").send(twiml.toString());

    // ── Background tasks ──
    sendOwnerReport(from, guestProfiles[from].name, userMessage, reply);
    triggerZapier({ type: "message", guest: from.replace("whatsapp:", ""), guestName: guestProfiles[from].name, message: userMessage, reply: cleanReply, time: getDubaiTime() });
    logToGoogleSheets({ type: "message", guestName: guestProfiles[from].name, guest: from.replace("whatsapp:", ""), message: userMessage, reply: cleanReply, time: getDubaiTime() });

  } catch (err) {
    console.error("❌ Error:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Heyy! Zara here — tiny tech moment 😅 Ping the team on 052 115 2418 for anything urgent. See you tonight! 🎧");
    res.type("text/xml").send(twiml.toString());
  }
});

// ============================================================
// ADMIN DASHBOARD
// ============================================================
app.get("/admin", (req, res) => {
  const password = req.query.password;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.send(`<html><head><title>Zara Admin</title><style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#1a1608;padding:40px;border-radius:16px;border:0.5px solid #2e2510;text-align:center;width:300px}h2{color:#c9a84c;margin-bottom:20px}input{width:100%;padding:10px;background:#0a0a0f;border:0.5px solid #2e2510;color:#e8d9b0;border-radius:8px;margin-bottom:12px;font-size:14px;box-sizing:border-box}button{width:100%;padding:10px;background:#c9a84c;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer}</style></head><body><div class="box"><h2>🎧 Zara Admin</h2><form method="get"><input type="password" name="password" placeholder="Admin password"/><button type="submit">Login</button></form></div></body></html>`);
  }
  const ev = loadEvent();
  res.send(`<html><head><title>Zara Admin</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:20px}h1{color:#c9a84c;letter-spacing:3px;font-size:20px;margin-bottom:4px}p{color:#a89060;font-size:13px;margin-bottom:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:900px}@media(max-width:600px){.grid{grid-template-columns:1fr}}.card{background:#1a1608;border:0.5px solid #2e2510;border-radius:12px;padding:16px}h3{color:#c9a84c;font-size:12px;letter-spacing:1px;margin-bottom:12px;text-transform:uppercase}label{font-size:11px;color:#a89060;display:block;margin-bottom:4px;margin-top:10px}label:first-of-type{margin-top:0}input,textarea{width:100%;padding:8px 10px;background:#0a0a0f;border:0.5px solid #2e2510;color:#e8d9b0;border-radius:6px;font-size:13px;font-family:sans-serif}textarea{height:80px;resize:vertical}.full{grid-column:1/-1}button{padding:12px 24px;background:#c9a84c;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:16px}.success{background:#0f2e14;border:0.5px solid #22c55e;color:#22c55e;padding:10px 16px;border-radius:8px;margin-bottom:16px;display:none;font-size:13px}</style></head><body>
  <h1>🎧 ZARA ADMIN v3</h1><p>Update event details — changes go live instantly</p>
  <div id="success" class="success">✅ Saved! Zara is now live with the new details.</div>
  <form id="f"><div class="grid">
    <div class="card"><h3>Event Basics</h3>
      <label>Event Name</label><input name="name" value="${ev.name}"/>
      <label>Club</label><input name="club" value="${ev.club}"/>
      <label>Date</label><input name="date" value="${ev.date}"/>
      <label>Time</label><input name="time" value="${ev.time}"/>
      <label>Lineup</label><input name="lineup" value="${ev.lineup}"/>
    </div>
    <div class="card"><h3>Venue & Contact</h3>
      <label>Venue</label><input name="venue" value="${ev.venue}"/>
      <label>Organizers</label><input name="organizers" value="${ev.organizers}"/>
      <label>Reservations Number</label><input name="reservationsNumber" value="${ev.reservationsNumber}"/>
      <label>Google Maps Link</label><input name="mapsLink" value="${ev.mapsLink}"/>
    </div>
    <div class="card"><h3>Door Policy</h3>
      <label>Age Limit</label><input name="ageLimit" value="${ev.ageLimit}"/>
      <label>Ladies</label><input name="doorPolicyLadies" value="${ev.doorPolicyLadies}"/>
      <label>Couples</label><input name="doorPolicyCouples" value="${ev.doorPolicyCouples}"/>
      <label>Stag</label><input name="doorPolicyStag" value="${ev.doorPolicyStag}"/>
      <label>Table Minimum</label><input name="tableMinimum" value="${ev.tableMinimum}"/>
    </div>
    <div class="card"><h3>Group Discount</h3>
      <label>Trigger group size (e.g. 6)</label><input name="groupDiscountThreshold" value="${ev.groupDiscountThreshold || 6}"/>
      <label>Offer (e.g. a complimentary bottle)</label><input name="groupDiscountOffer" value="${ev.groupDiscountOffer || "a complimentary bottle"}"/>
      <label>Early Bird Price (optional)</label><input name="earlyBirdPrice" value="${ev.earlyBirdPrice || ""}"/>
    </div>
    <div class="card full"><h3>Other</h3>
      <label>Dress Code</label><textarea name="dressCode">${ev.dressCode}</textarea>
      <label>FAQ (optional — common questions Zara should know)</label>
      <textarea name="faq">${ev.faq || ""}</textarea>
      <label>Upcoming Events (optional)</label>
      <textarea name="upcomingEvents">${ev.upcomingEvents || ""}</textarea>
    </div>
  </div><button type="submit">💾 Save & Go Live</button></form>
  <script>document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));const r=await fetch("/admin/save?password=${password}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});if(r.ok){const s=document.getElementById("success");s.style.display="block";setTimeout(()=>s.style.display="none",4000);}});</script>
  </body></html>`);
});

app.post("/admin/save", (req, res) => {
  if (req.query.password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: "Unauthorized" });
  try { saveEvent(req.body); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// QR CODE
// ============================================================
app.get("/qr", async (req, res) => {
  const twilioNumber = (process.env.TWILIO_WHATSAPP_NUMBER || "").replace("whatsapp:", "").replace("+", "");
  const ev = loadEvent();
  const waLink = `https://wa.me/${twilioNumber}?text=Hey%20Zara!%20Tell%20me%20about%20${encodeURIComponent(ev.name)}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(waLink, { width: 400, margin: 2, color: { dark: "#c9a84c", light: "#0a0a0f" } });
    res.send(`<html><head><title>QR Code</title><style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}h1{color:#c9a84c;letter-spacing:3px;font-size:20px;margin-bottom:6px}p{color:#a89060;font-size:13px;margin-bottom:24px}img{border:3px solid #c9a84c;border-radius:12px;max-width:280px}.btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#c9a84c;color:#000;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px}.url{margin-top:16px;font-size:11px;color:#6b5c30;word-break:break-all;max-width:320px}</style></head>
    <body><h1>🎧 SCAN TO CHAT WITH ZARA</h1><p>${ev.name} · ${ev.club} · ${ev.date}</p>
    <img src="${qrDataUrl}" alt="QR Code"/>
    <a href="${qrDataUrl}" download="zara-qr.png" class="btn">⬇️ Download for Flyer</a>
    <p class="url">${waLink}</p></body></html>`);
  } catch (err) { res.status(500).send("QR error: " + err.message); }
});

// ============================================================
// GUEST LIST PAGE
// ============================================================
app.get("/guestlist", (req, res) => {
  const ev = loadEvent();
  const registered = Object.entries(guestProfiles).filter(([, p]) => p.registered)
    .map(([number, p]) => ({ name: p.name || "—", groupSize: p.groupSize || "—", phone: number.replace("whatsapp:", ""), time: new Date(p.firstSeen).toLocaleString("en-GB", { timeZone: "Asia/Dubai" }), vip: (p.eventCount || 0) >= 3, birthday: p.hasBirthday, referralCode: p.referralCode || "—" }));
  const totalPeople = registered.reduce((s, g) => s + (parseInt(g.groupSize) || 1), 0);
  const rows = registered.map((g, i) => `<tr><td>${i+1}</td><td><strong>${g.name}</strong>${g.vip ? ' ⭐' : ''}${g.birthday ? ' 🎂' : ''}</td><td>${g.groupSize}</td><td>${g.phone}</td><td>${g.referralCode}</td><td>${g.time}</td></tr>`).join("");
  res.send(`<html><head><title>Guest List</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:20px}h1{color:#c9a84c;letter-spacing:3px;font-size:18px;margin-bottom:4px}p{color:#a89060;font-size:12px;margin-bottom:16px}.badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}.badge{background:#1a1608;border:0.5px solid #2e2510;padding:8px 12px;border-radius:8px;font-size:12px}.badge span{color:#c9a84c;font-weight:bold;font-size:18px;display:block}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#1a1608;color:#c9a84c;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}td{padding:8px 10px;border-bottom:0.5px solid #1a1608}tr:hover td{background:#1a1608}</style></head>
  <body><h1>🎧 ${ev.name.toUpperCase()} — GUEST LIST</h1><p>${ev.club} · ${ev.date}</p>
  <div class="badges"><div class="badge"><span>${registered.length}</span>Groups</div><div class="badge"><span>${totalPeople}</span>People</div><div class="badge"><span>${stats.uniqueGuests.size}</span>Enquiries</div><div class="badge"><span>${stats.tableEnquiries}</span>Table leads</div><div class="badge"><span>${registered.filter(g=>g.vip).length}</span>VIPs ⭐</div><div class="badge"><span>${registered.filter(g=>g.birthday).length}</span>Birthdays 🎂</div></div>
  <table><thead><tr><th>#</th><th>Name</th><th>Group</th><th>WhatsApp</th><th>Ref Code</th><th>First Contact</th></tr></thead><tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:30px;color:#6b5c30">No guests yet</td></tr>'}</tbody></table>
  </body></html>`);
});

// ============================================================
// LIVE STATS DASHBOARD
// ============================================================
app.get("/dashboard", (req, res) => {
  const ev = loadEvent();
  const avgFeedback = stats.feedbackScores.length > 0 ? (stats.feedbackScores.reduce((a, b) => a + b, 0) / stats.feedbackScores.length).toFixed(1) : "—";
  const busiest = Object.entries(stats.hourlyMessages).sort(([, a], [, b]) => b - a)[0];
  const totalReferrals = Object.values(referralCodes).reduce((s, r) => s + r.referrals, 0);
  res.send(`<html><head><title>Zara Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><style>body{font-family:sans-serif;background:#0a0a0f;color:#e8d9b0;padding:20px}h1{color:#c9a84c;letter-spacing:3px;font-size:18px;margin-bottom:4px}p{color:#a89060;font-size:12px;margin-bottom:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.card{background:#1a1608;border:0.5px solid #2e2510;border-radius:12px;padding:14px}.val{font-size:30px;font-weight:bold;color:#c9a84c;line-height:1}.label{font-size:10px;color:#a89060;margin-top:5px;text-transform:uppercase;letter-spacing:0.5px}.live{display:inline-block;width:7px;height:7px;background:#22c55e;border-radius:50%;margin-right:5px;animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}</style></head>
  <body><h1><span class="live"></span>ZARA LIVE DASHBOARD</h1><p>${ev.name} · Refreshes every 30s · ${getDubaiTime()}</p>
  <div class="grid">
    <div class="card"><div class="val">${stats.totalMessages}</div><div class="label">Messages</div></div>
    <div class="card"><div class="val">${stats.uniqueGuests.size}</div><div class="label">Guests</div></div>
    <div class="card"><div class="val">${stats.guestListRegistrations}</div><div class="label">Registered</div></div>
    <div class="card"><div class="val">${stats.tableEnquiries}</div><div class="label">Table Leads</div></div>
    <div class="card"><div class="val">${stats.birthdayGuests}</div><div class="label">Birthdays</div></div>
    <div class="card"><div class="val">${avgFeedback}</div><div class="label">Avg Feedback</div></div>
    <div class="card"><div class="val">${totalReferrals}</div><div class="label">Referrals</div></div>
    <div class="card"><div class="val" style="font-size:13px">${busiest ? busiest[0]+":00" : "—"}</div><div class="label">Busiest Hour</div></div>
    <div class="card"><div class="val">${Object.values(guestProfiles).filter(p=>(p.eventCount||0)>=3).length}</div><div class="label">VIP Guests ⭐</div></div>
    <div class="card"><div class="val">${Object.keys(blockedGuests).length}</div><div class="label">Blocked</div></div>
  </div></body></html>`);
});

// Health check
app.get("/", (req, res) => res.send("Zara bot v3 is running! 🎧"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zara bot v3 running on port ${PORT}`));
