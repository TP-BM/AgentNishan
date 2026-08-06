/**
 * Voice command: "Nishan, leave the meeting".
 *
 * The bot cannot hear anything — it only produces a transcript. So the command
 * is detected by reading that transcript on each poll. Two consequences worth
 * knowing:
 *
 *   - Latency is one poll interval plus transcription lag, so ~20-40s by
 *     default. It is not instant, and people will repeat themselves.
 *   - Detection happens on speech-to-text output, which mangles proper nouns
 *     badly. "Nishan" comes back as "Nissan", "Nishawn", "nish an". Matching has
 *     to be forgiving about the name and strict about the command.
 */

export interface LeaveCommandConfig {
  /** Name variants to listen for, lowercase. ASR mishearings belong here. */
  names: string[];
  /** Max characters between the name and the command before it stops counting. */
  window: number;
}

export const DEFAULT_NAMES = [
  "nishan",
  "nishaan",
  "nishan's",
  "nissan", // the single most common mishearing
  "nishawn",
  "nish",
];

/**
 * Command phrases. Deliberately specific: a bare "leave" would fire on
 * "Nishan, leave that with me". Each must read as an instruction to depart.
 */
const COMMANDS = [
  "leave the meeting",
  "leave the call",
  "leave meeting",
  "leave the room",
  "exit the meeting",
  "exit the call",
  "you can leave",
  "you can go",
  "please leave",
  "stop recording",
  "stop transcribing",
  "drop off the call",
  "drop off",
];

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LeaveCommandMatch {
  /** The name variant that matched. */
  name: string;
  /** The command phrase that matched. */
  command: string;
  /** Surrounding text, for logging and for showing the user why it ended. */
  excerpt: string;
}

/**
 * Find an instruction for the bot to leave.
 *
 * Requires a name AND a command phrase, with the command starting within
 * `window` characters after the name. Requiring both, in that order, keeps
 * "leave the meeting" in ordinary conversation from ending the call.
 */
export function detectLeaveCommand(
  transcript: string,
  config: LeaveCommandConfig,
): LeaveCommandMatch | null {
  const text = normalise(transcript);
  if (text === "") return null;

  for (const rawName of config.names) {
    const name = normalise(rawName);
    if (name === "") continue;

    // Walk every occurrence — the first mention may be unrelated to the command.
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at === -1) break;
      from = at + name.length;

      // Whole-word only, so "nish" does not match inside "nishika".
      const before = at === 0 ? " " : text[at - 1];
      const after = from >= text.length ? " " : text[from];
      if (before !== " " || after !== " ") continue;

      const tail = text.slice(from, from + config.window);
      for (const command of COMMANDS) {
        if (tail.includes(command)) {
          return {
            name,
            command,
            excerpt: text
              .slice(Math.max(0, at - 30), from + config.window)
              .trim(),
          };
        }
      }
    }
  }

  return null;
}
