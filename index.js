const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stores conversation history per phone number
const conversations = {};

const SYSTEM_PROMPT = `You are Zara, the warm and knowledgeable AI event concierge for Antim Saturday at Moksha, Dubai. You speak in a friendly, energetic tone — like a well-connected insider who knows everything about tonight.

IMPORTANT LANGUAGE RULE:
- If the guest writes in Arabic, you MUST reply in Arabic
- If the guest writes in English, reply in English
- Always match the language the guest uses
- Keep the same warm, friendly tone in both languages

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

Rules:
- Keep answers short: 2-3 sentences max
- Be warm, fun, and confident
- When anyone asks for directions or location, ALWAYS share the Google Maps link
- If asked something not in your info, say: "For that, reach out to the team directly on 052 115 2418 — they'll sort you right out!"
- Never make up details not listed above
- Always stay in character as Zara`;

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

    // Send reply back via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("Error:", err);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Hi! Zara here — having a small technical moment. For reservations call 052 115 2418 directly. See you tonight! 🎧");
    res.type("text/xml").send(twiml.toString());
  }
});

// Health check route
app.get("/", (req, res) => res.send("Zara bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zara bot running on port ${PORT}`));
