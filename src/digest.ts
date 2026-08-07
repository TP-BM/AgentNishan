import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { identityNames, type Identity } from "./db.ts";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface Decision {
  decision: string;
  rationale: string;
  owner: string;
  evidence_quote: string;
}

export interface ActionItem {
  owner: string;
  task: string;
  due: string;
  is_mine: boolean;
  evidence_quote: string;
}

export interface Digest {
  title: string;
  summary: string;
  decisions: Decision[];
  action_items: ActionItem[];
  open_questions: string[];
  risks: string[];
}

export interface DigestResult {
  digest: Digest;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class DigestRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestRefusal";
  }
}

const DIGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "decisions", "action_items", "open_questions", "risks"],
  properties: {
    title: {
      type: "string",
      description:
        "A short, specific title for this meeting, drawn from what was actually discussed. No date.",
    },
    summary: {
      type: "string",
      description:
        "2-4 sentences on what this meeting was for and where it landed. Plain prose, no bullets.",
    },
    decisions: {
      type: "array",
      description:
        "Things the group actually settled. Not topics discussed, not options floated — decisions.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "rationale", "owner", "evidence_quote"],
        properties: {
          decision: { type: "string", description: "What was decided, in one sentence." },
          rationale: {
            type: "string",
            description: "Why, if stated. Empty string if nobody gave a reason.",
          },
          owner: {
            type: "string",
            description:
              "Who drove or owns this decision, as named in the transcript. Empty string if unclear.",
          },
          evidence_quote: {
            type: "string",
            description:
              "A short verbatim quote from the transcript that shows this decision being made.",
          },
        },
      },
    },
    action_items: {
      type: "array",
      description: "Concrete commitments to do something, with a person attached.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "task", "due", "is_mine", "evidence_quote"],
        properties: {
          owner: {
            type: "string",
            description: "Who is on the hook, exactly as named in the transcript.",
          },
          task: { type: "string", description: "What they committed to do." },
          due: {
            type: "string",
            description:
              "The deadline as stated (e.g. 'Friday', 'end of sprint'). Empty string if none.",
          },
          is_mine: {
            type: "boolean",
            description: "True if the owner is the absent user described in the instructions.",
          },
          evidence_quote: {
            type: "string",
            description: "A short verbatim quote from the transcript assigning this task.",
          },
        },
      },
    },
    open_questions: {
      type: "array",
      description: "Questions raised but left unresolved.",
      items: { type: "string" },
    },
    risks: {
      type: "array",
      description: "Concerns, blockers, or risks raised. Empty array if none.",
      items: { type: "string" },
    },
  },
} as const;

const SYSTEM_PROMPT = `You extract decisions and action items from meeting transcripts for someone who could not attend.

The transcript is machine-generated, so expect garbled words, missing punctuation, and imperfect speaker labels. Read through those errors; do not quote them as if they were meaningful.

Rules:
- A decision is something the group settled on. A topic that was discussed without resolution is an open question, not a decision.
- An action item needs an owner and a concrete task. "We should probably look at that sometime" is not an action item.
- Attribute by the speaker labels in the transcript. If a task is assigned to someone whose name you cannot match, use the name as spoken and leave it at that.
- Every evidence_quote must be copied verbatim from the transcript. Never paraphrase into a quote, and never invent one. If you cannot find a supporting quote, the item probably is not real — leave it out.
- Do not pad. A short meeting with one decision should produce one decision. Empty arrays are the correct answer when nothing of that kind happened.
- The reader was absent and has no context beyond what you write. Name people and things explicitly rather than referring back to "the previous point".`;

function buildUserMessage(
  identity: Identity,
  transcript: string,
  meetingTitle: string,
  objective: string,
): string {
  const names = identityNames(identity);
  const identityLine =
    names.length > 0
      ? `The absent user is named: ${names.join(", ")}. Set is_mine to true for action items owned by any of those names, and false otherwise.`
      : `The absent user's name is unknown, so set is_mine to false on every action item.`;

  return `${identityLine}

The user was NOT in this meeting — a notetaker bot attended in their place. Anything assigned to them was assigned in their absence.

Meeting label (may just be the meeting code, ignore it if uninformative): ${meetingTitle}
${
  objective.trim() === ""
    ? ""
    : `
What the user asked you to watch for: ${objective.trim()}
Cover it if the meeting touched on it, and say so plainly if it did not. This steers emphasis — it does not narrow the digest, so still report decisions and action items outside it.
`
}

Transcript:
---
${transcript}
---`;
}

/** Belt-and-braces on is_mine: a missed action item of the user's is the expensive failure. */
function reconcileOwnership(digest: Digest, identity: Identity): Digest {
  const names = identityNames(identity).map((n) => n.toLowerCase());
  if (names.length === 0) return digest;

  const action_items = digest.action_items.map((item) => {
    if (item.is_mine) return item;
    const owner = item.owner.toLowerCase();
    const matches = names.some(
      (name) => owner === name || new RegExp(`\\b${escapeRegex(name)}\\b`).test(owner),
    );
    return matches ? { ...item, is_mine: true } : item;
  });

  return { ...digest, action_items };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function generateDigest(
  transcript: string,
  identity: Identity,
  meetingTitle: string,
  objective = "",
): Promise<DigestResult> {
  if (transcript.trim() === "") {
    throw new Error("Transcript is empty — nothing to summarise.");
  }

  const response = await client.messages.create({
    model: config.anthropic.model,
    // Covers thinking plus the JSON payload. Opus 5 thinks by default.
    max_tokens: 16_000,
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: DIGEST_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(identity, transcript, meetingTitle, objective),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new DigestRefusal(
      "Claude declined to summarise this transcript. The full transcript is still saved.",
    );
  }

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Digest was cut off before completing. The transcript may be unusually long.",
    );
  }

  const textBlock = response.content.find((block) => block.type === "text");
  if (textBlock === undefined || textBlock.type !== "text") {
    throw new Error("Claude returned no text content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Claude returned malformed JSON despite the schema constraint.");
  }

  const digest = normalise(parsed);

  return {
    digest: reconcileOwnership(digest, identity),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}

/** The schema is enforced server-side, but never trust a remote shape blindly. */
function normalise(value: unknown): Digest {
  const record = (value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  return {
    title: str(record["title"]),
    summary: str(record["summary"]),
    decisions: arr(record["decisions"]).map((d) => {
      const item = (d ?? {}) as Record<string, unknown>;
      return {
        decision: str(item["decision"]),
        rationale: str(item["rationale"]),
        owner: str(item["owner"]),
        evidence_quote: str(item["evidence_quote"]),
      };
    }),
    action_items: arr(record["action_items"]).map((a) => {
      const item = (a ?? {}) as Record<string, unknown>;
      return {
        owner: str(item["owner"]),
        task: str(item["task"]),
        due: str(item["due"]),
        is_mine: item["is_mine"] === true,
        evidence_quote: str(item["evidence_quote"]),
      };
    }),
    open_questions: arr(record["open_questions"]).map(str).filter(Boolean),
    risks: arr(record["risks"]).map(str).filter(Boolean),
  };
}
