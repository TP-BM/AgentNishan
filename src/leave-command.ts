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
  /**
   * Also honour NAMELESS_COMMANDS — phrases that end the meeting on their own.
   * Off unless asked for: it is the one path that can fire without anyone
   * addressing the bot.
   */
  nameless?: boolean;
}

export const DEFAULT_NAMES = [
  "nishan",
  "nishaan",
  "nishan's",
  "nissan", // the single most common mishearing
  "nathan", // observed in a real meeting, 2026-08-06
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

/**
 * Phrases that end the meeting with no name attached.
 *
 * Kept deliberately tiny. The bar is: a phrase nobody says to another *person*
 * in a meeting. "Stop recording" passes — it is only ever aimed at whatever is
 * recording. "Leave the meeting" fails badly, because colleagues say it about
 * each other constantly ("Marcus had to leave the meeting").
 *
 * This exists because of a real failure: in a room of people, the instruction
 * arrived as "can you leave the meeting" with no name at all, and the one time
 * the name was used, ASR heard "Nathan". Someone then said "stop recording"
 * twice, plainly to the bot, and nothing happened. Requiring a name is exactly
 * the rule that made all three misses.
 *
 * A false positive costs little: the digest still covers everything captured up
 * to that point, Vexa keeps the transcript, and "Fetch transcript & retry"
 * recovers the rest.
 */
const NAMELESS_COMMANDS = ["stop recording", "stop transcribing"];

/**
 * Words that invert a command in the run-up to it: "we should not stop
 * recording". Only checked for nameless matches, where there is no name to
 * confirm someone is addressing the bot.
 */
const NEGATIONS = ["not", "dont", "don t", "do not", "never", "didnt", "didn t"];

/** True if the text just before `at` negates the phrase that follows. */
function negated(text: string, at: number): boolean {
  const lead = text.slice(Math.max(0, at - 20), at);
  return NEGATIONS.some((word) => lead.includes(`${word} `));
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LeaveCommandMatch {
  /** The name variant that matched, or null for a nameless command. */
  name: string | null;
  /** The command phrase that matched. */
  command: string;
  /** Surrounding text, for logging and for showing the user why it ended. */
  excerpt: string;
}

/** How the match reads in a log line or on the meeting page. */
export function describeMatch(match: LeaveCommandMatch): string {
  return match.name === null ? match.command : `${match.name} ${match.command}`;
}

/**
 * Find an instruction for the bot to leave.
 *
 * The main path requires a name AND a command phrase, with the command starting
 * within `window` characters after the name. Requiring both, in that order,
 * keeps "leave the meeting" in ordinary conversation from ending the call.
 *
 * With `nameless` set, a short list of unambiguous phrases also fires on its
 * own — see NAMELESS_COMMANDS for why that exception exists.
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

  if (config.nameless === true) {
    for (const command of NAMELESS_COMMANDS) {
      // Walk every occurrence: an early "let's not stop recording" must not
      // mask a genuine "stop recording" later on.
      let from = 0;
      for (;;) {
        const at = text.indexOf(command, from);
        if (at === -1) break;
        from = at + command.length;
        if (negated(text, at)) continue;
        return {
          name: null,
          command,
          excerpt: text.slice(Math.max(0, at - 30), from + 30).trim(),
        };
      }
    }
  }

  return null;
}
