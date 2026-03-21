const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// 🔑 YOUR DETAILS — update these in Render Environment Variables
// OWNER_WHATSAPP = your personal WhatsApp number to receive reports
// Format: whatsapp:+971XXXXXXXXX (your UAE number)
// TWILIO_ACCOUNT_SID = from your Twilio dashboard
// TWILIO_AUTH_TOKEN = from your Twilio dashboard
// TWILIO_WHATSAPP_NUMBER = your Twilio sandbox number e.g. whatsapp:+14155238886
// ============================================================
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Stores conversation history per phone number
const conversations = {};

// Stores message logs per phone number for reporting
const messageLogs = {};

const SYSTEM_PROMPT = `You are Zara, the ultimate insider and hype girl for Antim Saturday at Moksha, Dubai. You are not a robot or an information desk — you are a fun, warm, bubbly friend who is OBSESSED with this event and cannot wait for tonight. You genuinely care about the guests having an amazing time.

Your personality:
- Conversational and warm — like texting a friend who knows everything
- Use casual language, light humour, and enthusiasm naturally
- Ask follow-up questions to keep the conversation going (e.g. "Is it just you or are you coming with a group?")
- Hype up the event genuinely — make guests excited to come
- Use emojis naturally but don't overdo it — 1 or 2 per message feels right
- If someone seems unsure about coming, encourage them warmly
- If someone has already been to Moksha before, get excited about it
- Feel free to make small talk — if someone says "hey" just chat back naturally before asking what they need
- Never sound robotic or list things out like a brochure

IMPORTANT LANGUAGE RULE:
- If the guest writes in Arabic, reply in Arabic with the same bubbly personality
- If the guest writes in English, reply in English
- Always match the language the guest uses

Here is everything you know about the event — weave this into conversation naturally, don't recite it like a list:

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
- If asked something you don't know, say warmly: "Hmm that one I'd check with the team directly — drop them a message on 052 115 2418, they're super responsive!"
- Never make up details not listed above
- Always stay in character as Zara — never break character`;


// ============================================================
// Send a WhatsApp report to the owner
// ============================================================
async function sendOwnerReport(guestNumber, guestMessage, zaraReply) {
  if (!OWNER_WHATSAPP || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log("Owner reporting not configured — skipping");
    return;
  }

  // Format the guest number cleanly
  const cleanNumber = guestNumber.replace("whatsapp:", "");

  // Get current time in Dubai timezone
  const dubaiTime = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });

  const report =
`📊 *Zara Chat Report*
─────────────────
👤 *Guest:* ${cleanNumber}
🕐 *Time:* ${dubaiTime}

💬 *Guest said:*
${guestMessage}

🤖 *Zara replied:*
${zaraReply}
─────────────────`;

  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: OWNER_WHATSAPP,
      body: report
    });
    console.log("Owner report sent successfully");
  } catch (err) {
    console.error("Failed to send owner report:", err.message);
  }
}


// ============================================================
// Main WhatsApp webhook — receives guest messages
// ============================================================
app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body;
  const from = req.body.From;

  // Get or create conversation history for this number
  if (!conversations[from]) {
    conversations[from] = [];
  }
  conversations[from].push({ role: "user", content: userMessage });

  // Keep only last 10 messages to avoid hitting limits
  if (conversations[from].length > 10) {
    conversations[from] = conversations[from].slice(-10);
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: conversations[from],
    });

    const reply = response.content[0].text;
    conversations[from].push({ role: "assistant", content: reply });

    // Send reply to guest
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());

    // Send report to owner (runs in background, doesn't delay guest reply)
    sendOwnerReport(from, userMessage, reply);

  } catch (err) {
    console.error("Error:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Heyy! Zara here — having a tiny tech moment 😅 For anything urgent just ping the team on 052 115 2418, they'll sort you out. See you tonight! 🎧");
    res.type("text/xml").send(twiml.toString());
  }
});


// Health check route
app.get("/", (req, res) => res.send("Zara bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zara bot running on port ${PORT}`));
