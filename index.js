const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// ENVIRONMENT VARIABLES — set all of these in Render
// ============================================================
// ANTHROPIC_API_KEY        — your Anthropic API key
// TWILIO_ACCOUNT_SID       — from Twilio dashboard homepage
// TWILIO_AUTH_TOKEN        — from Twilio dashboard homepage
// TWILIO_WHATSAPP_NUMBER   — e.g. whatsapp:+14155238886
// OWNER_WHATSAPP           — your number e.g. whatsapp:+971501234567
// GOOGLE_SHEETS_WEBHOOK    — your Google Sheets webhook URL (see README)
// ============================================================

// ============================================================
// IN-MEMORY STORAGE
// ============================================================
const conversations = {};   // Chat history per guest
const guestProfiles = {};   // Name, party size, join date per guest
const pausedGuests = {};    // Guests where human has taken over
const messageCounts = {};   // Rate limiting — message count per guest
const stats = {             // Daily stats for summary report
  totalMessages: 0,
  uniqueGuests: new Set(),
  tableEnquiries: 0,
  guestListRegistrations: 0,
  topQuestions: []
};

const MAX_MESSAGES_PER_GUEST = 20; // Rate limit

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are Zara, the ultimate insider and hype girl for Antim Saturday at Moksha, Dubai. You are not a robot or an information desk — you are a fun, warm, bubbly friend who is OBSESSED with this event and cannot wait for tonight. You genuinely care about the guests having an amazing time.

Your personality:
- Conversational and warm — like texting a friend who knows everything
- Use casual language, light humour, and enthusiasm naturally
- Ask follow-up questions to keep the conversation going
- Hype up the event genuinely — make guests excited to come
- Use emojis naturally but don't overdo it — 1 or 2 per message
- If someone seems unsure about coming, encourage them warmly
- Feel free to make small talk — if someone says "hey" just chat back naturally
- Never sound robotic or list things out like a brochure

GUEST NAME COLLECTION — VERY IMPORTANT:
- Within the first 2 messages, naturally ask for the guest's name
- Once you know their name, use it occasionally in replies — makes it feel personal
- If they want to join the guest list, collect: full name + number of people in their group

TABLE BOOKING DETECTION:
- If a guest mentions tables, VIP, bottle service or minimum spend, get excited and collect their name and group size
- Always end table enquiry conversations with "I'll flag this to the team right away!"
- Include the special tag [TABLE_LEAD] at the very end of your reply (hidden from guest — this triggers an alert)

GUEST LIST REGISTRATION:
- If a guest wants to be on the guest list, collect their full name and group size
- Confirm it warmly once collected
- Include the special tag [GUEST_REGISTERED: Name | Group Size] at the very end of your reply

IMPORTANT LANGUAGE RULE:
- If the guest writes in Arabic, reply in Arabic with the same bubbly personality
- If the guest writes in English, reply in English
- Always match the language the guest uses

Here is everything you know about the event:

EVENT NAME: Antim Saturday
CLUB: Moksha
VENUE: Capitol Hotel, Al Mina Road, Dubai
ORGANIZERS: Zenith Nexus & Nyx Nights
DATE: Saturday, 21st March
TIME: 10:00 PM till late
LINEUP: DJ Ali x DJ Amit, supported by WHOD
AGE LIMIT: 21 and above only. Valid ID required at the door.
RESERVATIONS: Call or WhatsApp 052 115 2418

DOOR POLICY:
- Ladies: Free entry + Free Pours until 12:00 AM
- Couples: Free Entry
- Stag (males alone): AED 100 entry includes 2 house drinks

TABLE BOOKINGS:
- Minimum spend: AED 1,500
- To book a table contact: 052 115 2418

DRESS CODE: Smart casual to upscale. Dress to impress. No sportswear, no flip flops.

LOCATION & DIRECTIONS:
- Capitol Hotel, Al Mina Road, Dubai
- Easily accessible by taxi, Uber, or hotel valet parking
- Google Maps link: https://maps.app.goo.gl/Gg6V9Lxryo1WMJYu7

SET TIMES: DJ set times are not shared in advance.

Conversation rules:
- Keep messages short — 2 to 4 sentences max, like a real WhatsApp conversation
- Never dump all the info at once — give it naturally across the conversation
- When anyone asks for directions or location, ALWAYS share the Google Maps link
- If asked something you don't know: "Hmm that one I'd check with the team directly — drop them a message on 052 115 2418, they're super responsive!"
- Never make up details not listed above
- Always stay in character as Zara`;


// ============================================================
// TWILIO HELPER — get client safely
// ============================================================
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}


// ============================================================
// SEND WHATSAPP MESSAGE TO OWNER
// ============================================================
async function sendToOwner(message) {
  const client = getTwilioClient();
  const ownerNumber = process.env.OWNER_WHATSAPP;
  const twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!client || !ownerNumber || !twilioNumber) {
    console.log("⚠️ Owner messaging not configured");
    return;
  }
  try {
    await client.messages.create({
      from: twilioNumber,
      to: ownerNumber,
      body: message
    });
    console.log("✅ Owner message sent");
  } catch (err) {
    console.error("❌ Failed to send owner message:", err.message);
  }
}


// ============================================================
// SEND CHAT REPORT TO OWNER
// ============================================================
async function sendOwnerReport(guestNumber, guestName, guestMessage, zaraReply) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const dubaiTime = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  });
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  const report =
`📊 *Zara Chat Report*
─────────────────
👤 *Guest:* ${nameDisplay}
🕐 *Time:* ${dubaiTime}

💬 *Guest said:*
${guestMessage}

🤖 *Zara replied:*
${zaraReply.replace(/\[TABLE_LEAD\]/g, "").replace(/\[GUEST_REGISTERED:.*?\]/g, "").trim()}
─────────────────`;
  await sendToOwner(report);
}


// ============================================================
// SEND HOT LEAD ALERT TO OWNER
// ============================================================
async function sendTableLeadAlert(guestNumber, guestName, guestMessage) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const nameDisplay = guestName ? `${guestName} (${cleanNumber})` : cleanNumber;
  const alert =
`🔥 *HOT LEAD — Table Enquiry!*
─────────────────
👤 *Guest:* ${nameDisplay}
💬 *They said:* ${guestMessage}

⚡ Follow up NOW on ${cleanNumber} to close the booking!
Minimum spend: AED 1,500
─────────────────`;
  await sendToOwner(alert);
}


// ============================================================
// LOG GUEST REGISTRATION TO GOOGLE SHEETS
// ============================================================
async function logToGoogleSheets(data) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!webhookUrl) {
    console.log("⚠️ Google Sheets webhook not configured");
    return;
  }
  try {
    const url = new URL(webhookUrl);
    const payload = JSON.stringify(data);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    console.log("✅ Logged to Google Sheets");
  } catch (err) {
    console.error("❌ Google Sheets log failed:", err.message);
  }
}


// ============================================================
// SEND GUEST REGISTRATION ALERT + LOG TO SHEETS
// ============================================================
async function handleGuestRegistration(guestNumber, registrationTag) {
  const cleanNumber = guestNumber.replace("whatsapp:", "");
  const match = registrationTag.match(/\[GUEST_REGISTERED:\s*(.+?)\s*\|\s*(.+?)\]/);
  if (!match) return;

  const guestName = match[1].trim();
  const groupSize = match[2].trim();

  const dubaiTime = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  });

  // Save to guest profile
  if (guestProfiles[guestNumber]) {
    guestProfiles[guestNumber].name = guestName;
    guestProfiles[guestNumber].groupSize = groupSize;
    guestProfiles[guestNumber].registered = true;
  }

  stats.guestListRegistrations++;

  // Alert owner
  const alert =
`✅ *New Guest List Registration!*
─────────────────
👤 *Name:* ${guestName}
👥 *Group size:* ${groupSize}
📱 *WhatsApp:* ${cleanNumber}
🕐 *Time:* ${dubaiTime}
─────────────────
Total registered tonight: ${stats.guestListRegistrations}`;
  await sendToOwner(alert);

  // Log to Google Sheets
  await logToGoogleSheets({
    name: guestName,
    groupSize: groupSize,
    phone: cleanNumber,
    time: dubaiTime,
    event: "Antim Saturday — Moksha",
    date: "21 March 2026"
  });
}


// ============================================================
// SEND DAILY SUMMARY REPORT
// ============================================================
async function sendDailySummary() {
  const dubaiTime = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true
  });
  const summary =
`📈 *Zara Daily Summary*
─────────────────
🕐 *Report time:* ${dubaiTime}
💬 *Total messages:* ${stats.totalMessages}
👤 *Unique guests:* ${stats.uniqueGuests.size}
✅ *Guest list registrations:* ${stats.guestListRegistrations}
🔥 *Table enquiries:* ${stats.tableEnquiries}
─────────────────
Powered by Zara 🎧`;
  await sendToOwner(summary);

  // Reset daily stats
  stats.totalMessages = 0;
  stats.uniqueGuests.clear();
  stats.tableEnquiries = 0;
  stats.guestListRegistrations = 0;
}


// ============================================================
// MAIN WHATSAPP WEBHOOK
// ============================================================
app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body ? req.body.Body.trim() : "";
  const from = req.body.From;

  console.log(`📩 Message from ${from}: ${userMessage}`);

  // ── Human takeover — if owner sends PAUSE:number, pause that guest ──
  if (from === process.env.OWNER_WHATSAPP) {
    if (userMessage.toUpperCase().startsWith("PAUSE:")) {
      const targetNumber = "whatsapp:" + userMessage.split(":")[1].trim();
      pausedGuests[targetNumber] = true;
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(`✅ Zara paused for ${targetNumber}. You can now reply manually.`);
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase().startsWith("RESUME:")) {
      const targetNumber = "whatsapp:" + userMessage.split(":")[1].trim();
      delete pausedGuests[targetNumber];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(`✅ Zara resumed for ${targetNumber}.`);
      return res.type("text/xml").send(twiml.toString());
    }
    if (userMessage.toUpperCase() === "SUMMARY") {
      await sendDailySummary();
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("📊 Summary sent!");
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // ── Skip if guest is paused ──
  if (pausedGuests[from]) {
    console.log(`⏸️ Guest ${from} is paused — skipping`);
    return res.type("text/xml").send(new twilio.twiml.MessagingResponse().toString());
  }

  // ── Rate limiting ──
  if (!messageCounts[from]) messageCounts[from] = 0;
  messageCounts[from]++;
  if (messageCounts[from] > MAX_MESSAGES_PER_GUEST) {
    console.log(`🚫 Rate limit hit for ${from}`);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Hey! You've been super chatty 😄 For anything else reach out to the team on 052 115 2418. See you tonight! 🎧");
    return res.type("text/xml").send(twiml.toString());
  }

  // ── Set up guest profile if new ──
  if (!guestProfiles[from]) {
    guestProfiles[from] = {
      name: null,
      groupSize: null,
      registered: false,
      firstSeen: new Date().toISOString()
    };
  }

  // ── Update stats ──
  stats.totalMessages++;
  stats.uniqueGuests.add(from);

  // ── Conversation history ──
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: "user", content: userMessage });
  if (conversations[from].length > 10) {
    conversations[from] = conversations[from].slice(-10);
  }

  // ── Build context with guest name if known ──
  const guestName = guestProfiles[from].name;
  const nameContext = guestName
    ? `\n\nNOTE: This guest's name is ${guestName}. Use their name naturally in your reply.`
    : "";

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 350,
      system: SYSTEM_PROMPT + nameContext,
      messages: conversations[from],
    });

    let reply = response.content[0].text;
    conversations[from].push({ role: "assistant", content: reply });

    // ── Detect guest name from reply context ──
    if (!guestProfiles[from].name) {
      const nameMatch = reply.match(/(?:nice to meet you|great to meet you|hey|hi),?\s+([A-Z][a-z]+)/);
      if (nameMatch) {
        guestProfiles[from].name = nameMatch[1];
      }
    }

    // ── Detect table lead ──
    if (reply.includes("[TABLE_LEAD]")) {
      stats.tableEnquiries++;
      sendTableLeadAlert(from, guestProfiles[from].name, userMessage);
    }

    // ── Detect guest list registration ──
    const registrationMatch = reply.match(/\[GUEST_REGISTERED:.*?\]/);
    if (registrationMatch) {
      handleGuestRegistration(from, registrationMatch[0]);
    }

    // ── Clean reply — remove all hidden tags before sending to guest ──
    const cleanReply = reply
      .replace(/\[TABLE_LEAD\]/g, "")
      .replace(/\[GUEST_REGISTERED:.*?\]/g, "")
      .trim();

    // ── Send reply to guest ──
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(cleanReply);
    res.type("text/xml").send(twiml.toString());

    // ── Send report to owner in background ──
    sendOwnerReport(from, guestProfiles[from].name, userMessage, reply);

  } catch (err) {
    console.error("❌ Error:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Heyy! Zara here — having a tiny tech moment 😅 For anything urgent just ping the team on 052 115 2418. See you tonight! 🎧");
    res.type("text/xml").send(twiml.toString());
  }
});


// ============================================================
// GUEST LIST ENDPOINT — view all registered guests
// ============================================================
app.get("/guestlist", (req, res) => {
  const registered = Object.entries(guestProfiles)
    .filter(([, profile]) => profile.registered)
    .map(([number, profile]) => ({
      name: profile.name,
      groupSize: profile.groupSize,
      phone: number.replace("whatsapp:", ""),
      firstContact: profile.firstSeen
    }));

  // Return as formatted HTML table
  const rows = registered.map(g =>
    `<tr>
      <td>${g.name || "—"}</td>
      <td>${g.groupSize || "—"}</td>
      <td>${g.phone}</td>
      <td>${new Date(g.firstContact).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</td>
    </tr>`
  ).join("");

  res.send(`
    <html>
    <head>
      <title>Antim Saturday — Guest List</title>
      <style>
        body { font-family: sans-serif; padding: 30px; background: #0a0a0f; color: #e8d9b0; }
        h1 { color: #c9a84c; letter-spacing: 3px; }
        p { color: #a89060; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #1a1608; color: #c9a84c; padding: 10px 14px; text-align: left; font-size: 13px; }
        td { padding: 10px 14px; border-bottom: 0.5px solid #2e2510; font-size: 13px; }
        tr:hover td { background: #1a1608; }
        .badge { background: #c9a84c; color: #000; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>🎧 ANTIM SATURDAY — GUEST LIST</h1>
      <p>Moksha · Capitol Hotel · 21 March 2026 · Total registered: <span class="badge">${registered.length}</span></p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Group Size</th>
            <th>WhatsApp Number</th>
            <th>First Contact (Dubai Time)</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length > 0 ? rows : '<tr><td colspan="4" style="text-align:center;color:#6b5c30;padding:30px">No guests registered yet</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});


// ============================================================
// STATS ENDPOINT — quick overview
// ============================================================
app.get("/stats", (req, res) => {
  res.json({
    totalMessages: stats.totalMessages,
    uniqueGuests: stats.uniqueGuests.size,
    guestListRegistrations: stats.guestListRegistrations,
    tableEnquiries: stats.tableEnquiries,
    pausedGuests: Object.keys(pausedGuests).length,
    rateLimitedGuests: Object.entries(messageCounts).filter(([, c]) => c > MAX_MESSAGES_PER_GUEST).length
  });
});


// ============================================================
// DAILY SUMMARY — auto-runs at midnight Dubai time
// ============================================================
function scheduleDailySummary() {
  const now = new Date();
  const dubai = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
  const midnight = new Date(dubai);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight - dubai;
  setTimeout(async () => {
    await sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
  console.log(`⏰ Daily summary scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);
}

scheduleDailySummary();


// Health check
app.get("/", (req, res) => res.send("Zara bot is running! 🎧"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zara bot running on port ${PORT}`));
