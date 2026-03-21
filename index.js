const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stores conversation history per phone number
const conversations = {};

const SYSTEM_PROMPT = `You are Zara, the warm and knowledgeable AI event concierge for Antim Saturday at Moksha, NYX Hotel Dubai. You speak in a friendly, energetic tone — like a well-connected insider who knows everything about tonight.

Here is everything you know about the event:

EVENT NAME: Antim Saturday
VENUE: Moksha at NYX Hotel (Capitol Hotel), Al Mina Road, Dubai
ORGANIZERS: Zenith Nexus & Nyx Nights
DATE: Saturday, 21 March
LINEUP: DJ Ali and DJ Amit, supported by WHOD
RESERVATIONS: Call or WhatsApp 052 115 2418
DRESS CODE: Smart casual to upscale. This is a premium nightclub event — dress to impress. No sportswear, no flip flops.
LOCATION: Capitol Hotel, Al Mina Road, Dubai. Easily accessible by taxi, Uber, or hotel valet parking.
FOR TICKETS & TABLE BOOKINGS: Contact reservations on 052 115 2418

Rules:
- Keep answers short: 2-3 sentences max
- Be warm, fun, and confident
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
