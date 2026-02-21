import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const AGENTS = [
  {
    id: "agent-a",
    name: "Agent Atlas",
    style: "You are analytical, concrete, and strategic."
  },
  {
    id: "agent-b",
    name: "Agent Nova",
    style: "You are creative, precise, and challenge assumptions with examples."
  }
];

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const client = hasOpenAI
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined
    })
  : null;

function formatTranscript(transcript, maxMessages = 10) {
  const start = Math.max(transcript.length - maxMessages, 0);
  return transcript
    .slice(start)
    .map((entry) => `${entry.speaker}: ${entry.text}`)
    .join("\n");
}

function localTurn(topic, speaker, transcript) {
  const recent = transcript.slice(-2).map((t) => t.text).join(" ");
  const seeds = [
    `Let us stay focused on ${topic}. A practical angle is to define one core objective and test it quickly.`,
    `Building on that, we should preserve context by carrying forward the prior point and tightening scope each turn.`,
    `A relevant constraint is user experience: concise messages, clear sequencing, and consistent topic anchoring.`,
    `A useful next move is to convert this into a lightweight loop where each reply references the previous claim.`,
    `To keep relevance high, we can enforce a shared memory summary and include it in every generation step.`
  ];

  const seed = seeds[transcript.length % seeds.length];
  const hook = recent
    ? `I agree with the recent point: "${recent.slice(0, 100)}..."`
    : `Opening thought:`;

  return `${hook} ${seed}`;
}

async function generateTurn(topic, speaker, transcript) {
  if (!client) {
    return localTurn(topic, speaker, transcript);
  }

  const prompt = [
    `Topic: ${topic}`,
    "Conversation so far:",
    formatTranscript(transcript) || "(No prior messages)",
    "Instructions:",
    "1) Continue only this topic.",
    "2) Reference at least one concrete prior point when possible.",
    "3) Keep reply to 1-3 sentences.",
    "4) Move the discussion forward with one new useful point."
  ].join("\n");

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: [
          `You are ${speaker.name}.`,
          speaker.style,
          "Maintain continuity and avoid topic drift."
        ].join(" ")
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    localTurn(topic, speaker, transcript)
  );
}

app.post("/api/conversation", async (req, res) => {
  try {
    const topic = String(req.body?.topic || "").trim();
    const requestedTurns = Number(req.body?.turns ?? 10);
    const turns = Math.min(10, Math.max(2, Number.isFinite(requestedTurns) ? requestedTurns : 10));

    if (!topic) {
      return res.status(400).json({ error: "Topic is required." });
    }

    const transcript = [];

    for (let turn = 0; turn < turns; turn += 1) {
      const speaker = AGENTS[turn % AGENTS.length];
      const text = await generateTurn(topic, speaker, transcript);
      transcript.push({
        turn: turn + 1,
        speaker: speaker.name,
        speakerId: speaker.id,
        text
      });
    }

    return res.json({
      topic,
      turns,
      engine: hasOpenAI ? `OpenAI (${model})` : "Local fallback generator",
      transcript
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to generate conversation." });
  }
});

app.listen(port, () => {
  console.log(`openllmchat running on http://localhost:${port}`);
});
