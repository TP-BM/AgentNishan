const missing: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    // Collected rather than thrown, so a first run reports every missing key at
    // once instead of one per restart.
    missing.push(name);
    return "";
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

export type MailerKind = "resend" | "smtp" | "none";

const mailerKind = optional("MAILER", "resend");
if (mailerKind !== "resend" && mailerKind !== "smtp" && mailerKind !== "none") {
  console.error(`MAILER must be one of: resend, smtp, none — got "${mailerKind}"`);
  process.exit(1);
}

// A pre-split .env may still carry a single VEXA_API_KEY; fall back to it so an
// existing setup keeps working, even though it can only satisfy one of the two.
const legacyKey = optional("VEXA_API_KEY", "");
const botKey = optional("VEXA_BOT_API_KEY", "") || legacyKey;
const txKey = optional("VEXA_TX_API_KEY", "") || legacyKey;
if (botKey === "") missing.push("VEXA_BOT_API_KEY");
if (txKey === "") missing.push("VEXA_TX_API_KEY");

export const config = {
  port: Number(optional("PORT", "3000")),
  appSecret: required("APP_SECRET"),
  baseUrl: optional("APP_BASE_URL", `http://localhost:${optional("PORT", "3000")}`),
  databasePath: optional("DATABASE_PATH", "./data/meetnish.db"),

  vexa: {
    // Vexa's cloud dashboard issues one scope per key, so dispatching bots and
    // reading transcripts need two different keys.
    botKey: botKey,
    txKey: txKey,
    baseUrl: optional("VEXA_BASE_URL", "https://api.cloud.vexa.ai").replace(
      /\/+$/,
      "",
    ),
    botName: optional("VEXA_BOT_NAME", "Notetaker"),
    language: optional("VEXA_LANGUAGE", "en"),
  },

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-opus-5"),
  },

  mail: {
    kind: mailerKind as MailerKind,
    to: optional("NOTIFY_EMAIL", ""),
    from: optional("MAIL_FROM", "onboarding@resend.dev"),
    resendApiKey: optional("RESEND_API_KEY", ""),
    smtp: {
      host: optional("SMTP_HOST", ""),
      port: Number(optional("SMTP_PORT", "587")),
      user: optional("SMTP_USER", ""),
      pass: optional("SMTP_PASS", ""),
    },
  },

  poll: {
    /** How often to poll Vexa for each live meeting. */
    intervalMs: Number(optional("POLL_INTERVAL_MS", "20000")),
    /** Consecutive polls with the bot absent before we call the meeting over. */
    goneThreshold: 2,
    /**
     * Polls with no new transcript before ending a meeting whose bot is still
     * reported active (20s x 6 = 2 min). Vexa leaves bots in the call after it
     * ends, so this is the signal that actually terminates most meetings.
     *
     * Trade-off: any silence longer than this ends the meeting early. Two
     * minutes is fine for conversational calls; raise it if a meeting might go
     * quiet for a demo or a long read.
     */
    staleThreshold: Number(optional("POLL_STALE_THRESHOLD", "6")),
    /**
     * Polls to wait for the bot to be admitted before giving up (20s x 15 =
     * 5 min). Too short and it abandons a meeting that starts late; too long
     * and an unnoticed bot sits in a lobby burning credits.
     */
    admitThreshold: Number(optional("POLL_ADMIT_THRESHOLD", "15")),
    /** Absolute ceiling on a single meeting. */
    maxDurationMs: 3 * 60 * 60 * 1000,
  },

  /** Voice command: someone says "<name>, leave the meeting" and the bot goes. */
  leaveCommand: {
    enabled: optional("LEAVE_COMMAND_ENABLED", "true") !== "false",
    /** Name variants, including likely speech-to-text mishearings. */
    names: optional("LEAVE_COMMAND_NAMES", "")
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
    /** Characters allowed between the name and the command phrase. */
    window: Number(optional("LEAVE_COMMAND_WINDOW", "60")),
  },
} as const;

if (missing.length > 0) {
  console.error(
    `\nMeetNish can't start — ${missing.length} required setting${missing.length === 1 ? " is" : "s are"} missing:\n` +
      missing.map((name) => `  - ${name}`).join("\n") +
      `\n\nCopy .env.example to .env and fill these in. For APP_SECRET, generate one with:\n` +
      `  openssl rand -base64 32\n`,
  );
  process.exit(1);
}
