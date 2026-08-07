import { config } from "./config.ts";

export class VexaError extends Error {
  status: number;
  body: string;
  /** Which key was used, so messages can name the right env var. */
  scope: "bot" | "tx" | null;

  constructor(
    status: number,
    body: string,
    message?: string,
    scope: "bot" | "tx" | null = null,
  ) {
    super(message ?? `Vexa API error ${status}: ${body.slice(0, 300)}`);
    this.name = "VexaError";
    this.status = status;
    this.body = body;
    this.scope = scope;
  }

  /** A message worth showing the user rather than a raw HTTP dump. */
  friendly(): string {
    // status 0 = never reached the server; the message already explains why.
    if (this.status === 0) {
      return this.message;
    }
    if (this.status === 409) {
      return "A bot is already active in that meeting.";
    }
    if (this.status === 429) {
      return "Vexa concurrency limit reached — too many bots running. Try again shortly.";
    }
    const envVar =
      this.scope === "tx" ? "VEXA_TX_API_KEY" : "VEXA_BOT_API_KEY";

    if (this.status === 401) {
      return `Vexa rejected the API key. Check ${envVar}.`;
    }
    if (this.status === 403) {
      return this.scope === "tx"
        ? "VEXA_TX_API_KEY is not a Transcription Key. Vexa issues one scope per " +
            "key — create a Transcription Key (vxa_tx_…) in the dashboard; a bot " +
            "key cannot read transcripts."
        : "VEXA_BOT_API_KEY is not a Bot Key. Create a Bot Key (vxa_bot_…) in the " +
            "Vexa dashboard — a transcription key cannot dispatch bots.";
    }
    if (this.status === 404) {
      return "Vexa could not find that meeting.";
    }
    return `Vexa error ${this.status}. ${this.body.slice(0, 200)}`;
  }
}

export interface VexaTranscriptSegment {
  segment_id?: string | number;
  speaker?: string | null;
  text?: string | null;
  start?: number | null;
  end?: number | null;
  completed?: boolean;
}

/**
 * Which credential a call needs. Vexa's cloud issues single-scope keys, so
 * bot control and transcript reads authenticate with different ones.
 */
type Scope = "bot" | "tx";

async function request(
  scope: Scope,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${config.vexa.baseUrl}${path}`;
  const key = scope === "bot" ? config.vexa.botKey : config.vexa.txKey;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // Node surfaces every transport failure as a bare "fetch failed"; the useful
    // part (ENOTFOUND, ECONNREFUSED, timeout) is hidden on `cause`. Dig it out,
    // otherwise a wrong VEXA_BASE_URL is indistinguishable from an outage.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (error as Error).message;
    const hint =
      cause?.code === "ENOTFOUND"
        ? ` — that hostname does not resolve, so check VEXA_BASE_URL`
        : cause?.code === "ECONNREFUSED"
          ? ` — nothing is listening there, so check VEXA_BASE_URL`
          : "";
    throw new VexaError(0, "", `Could not reach Vexa at ${url} (${detail})${hint}.`, scope);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new VexaError(response.status, text, undefined, scope);
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new VexaError(response.status, text, "Vexa returned a non-JSON response", scope);
  }
}

/**
 * Ask Vexa to send a bot into a Google Meet. Returns Vexa's internal meeting id
 * if it gives one.
 *
 * `botName` is per request because it is what everyone in the room sees in the
 * participant list — it is how the bot announces itself, so a demo run should
 * be able to say whose it is rather than inheriting the owner's name.
 */
export async function sendBot(
  nativeMeetingId: string,
  botName = config.vexa.botName,
): Promise<string | null> {
  const result = (await request("bot", "POST", "/bots", {
    platform: "google_meet",
    native_meeting_id: nativeMeetingId,
    bot_name: botName,
    language: config.vexa.language,
    task: "transcribe",
    transcribe_enabled: true,
    recording_enabled: false,
  })) as Record<string, unknown>;

  const id = result?.["id"] ?? (result?.["meeting"] as Record<string, unknown>)?.["id"];
  return id === undefined || id === null ? null : String(id);
}

export async function stopBot(nativeMeetingId: string): Promise<void> {
  await request("bot", "DELETE", `/bots/google_meet/${encodeURIComponent(nativeMeetingId)}`);
}

export async function getTranscript(
  nativeMeetingId: string,
): Promise<VexaTranscriptSegment[]> {
  const result = (await request(
    "tx",
    "GET",
    `/transcripts/google_meet/${encodeURIComponent(nativeMeetingId)}`,
  )) as Record<string, unknown>;

  const segments = result?.["segments"];
  return Array.isArray(segments) ? (segments as VexaTranscriptSegment[]) : [];
}

/**
 * Statuses that mean the bot is actually in the meeting.
 *
 * Deliberately an allowlist. Vexa's status vocabulary is larger than the docs
 * describe — `requested`, `joining`, `awaiting_admission` and `active` have all
 * been observed — and the failure modes are asymmetric:
 *
 *   - Mistaking a lobby status for "in the meeting" sets bot_seen, which
 *     disables the never-admitted timeout. A bot nobody admits then runs to the
 *     3-hour ceiling, burning credits.
 *   - Mistaking an in-meeting status for a lobby one is nearly harmless: the
 *     never-admitted path also requires zero transcript, so a bot that is
 *     actually transcribing is never killed by it.
 *
 * So an unrecognised status is treated as "not in the meeting", and logged once
 * so the set can be extended.
 */
const IN_MEETING = new Set([
  "active",
  "recording",
  "transcribing",
  "in_call",
  "joined",
]);

const seenStatuses = new Set<string>();

export interface BotState {
  /** Vexa still lists a bot for this meeting. */
  present: boolean;
  /** Raw status string, e.g. "joining", "active". Null when not listed. */
  status: string | null;
  /** Present AND past the lobby. */
  inMeeting: boolean;
}

/**
 * Current state of our bot according to /bots/status.
 *
 * Entry shape confirmed against the live API: each carries a top-level
 * `native_meeting_id` plus a `status`. Other id fields are still checked
 * defensively in case the shape varies by platform.
 */
export async function getBotState(nativeMeetingId: string): Promise<BotState> {
  const result = (await request("bot", "GET", "/bots/status")) as Record<string, unknown>;
  const bots = result?.["running_bots"];

  if (!Array.isArray(bots)) {
    return { present: false, status: null, inMeeting: false };
  }

  const match = bots.find((bot) => {
    if (bot === null || typeof bot !== "object") return false;
    const record = bot as Record<string, unknown>;
    return [record["native_meeting_id"], record["meeting_id"], record["id"]].some(
      (c) => c !== undefined && String(c) === nativeMeetingId,
    );
  }) as Record<string, unknown> | undefined;

  if (match === undefined) {
    return { present: false, status: null, inMeeting: false };
  }

  const status = typeof match["status"] === "string" ? match["status"] : null;

  if (status !== null && !seenStatuses.has(status)) {
    seenStatuses.add(status);
    if (!IN_MEETING.has(status)) {
      console.log(
        `[vexa] bot status "${status}" treated as not-yet-in-meeting. ` +
          `If that is wrong, add it to IN_MEETING in src/vexa.ts.`,
      );
    }
  }

  return {
    present: true,
    // A null status means Vexa told us nothing; assume in-meeting, since it is
    // listed at all and the transcript signals will still end the meeting.
    inMeeting: status === null || IN_MEETING.has(status),
    status,
  };
}

/**
 * Validate both keys at startup, so a misconfigured pair is caught before a
 * meeting rather than after it, when the transcript is already unreachable.
 *
 * The transcript probe uses a well-formed but nonexistent meeting code: a
 * Transcription Key gets 404 (no such meeting), a Bot Key gets 403.
 */
export async function checkKeys(): Promise<{ bot: string | null; tx: string | null }> {
  const result: { bot: string | null; tx: string | null } = { bot: null, tx: null };

  try {
    await request("bot", "GET", "/bots/status");
  } catch (error) {
    result.bot =
      error instanceof VexaError ? error.friendly() : (error as Error).message;
  }

  try {
    await request("tx", "GET", "/transcripts/google_meet/aaa-aaaa-aaa");
  } catch (error) {
    // 404 is the healthy answer here — the key worked, the meeting just isn't real.
    if (error instanceof VexaError && error.status === 404) {
      return result;
    }
    result.tx =
      error instanceof VexaError ? error.friendly() : (error as Error).message;
  }

  return result;
}

export interface VexaMeetingDetail {
  status?: string;
  bot_outcome?: string;
  /** e.g. "awaiting_admission_rejected" — someone denied the bot. */
  completion_reason?: string;
  /** Which step failed, e.g. "awaiting_admission". */
  failure_stage?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Cross-check of meeting state. Returns null if Vexa has nothing useful. */
export async function getMeetingDetail(
  vexaMeetingId: string | null,
): Promise<VexaMeetingDetail | null> {
  if (vexaMeetingId === null) return null;
  try {
    const result = (await request(
      "tx",
      "GET",
      `/meetings/${encodeURIComponent(vexaMeetingId)}`,
    )) as Record<string, unknown>;

    const provenance = result?.["service_provenance"] as
      | Record<string, unknown>
      | undefined;

    return {
      status: str(result?.["status"]),
      bot_outcome: str(provenance?.["bot_outcome"]),
      completion_reason: str(result?.["completion_reason"]),
      failure_stage: str(result?.["failure_stage"]),
    };
  } catch (error) {
    // A missing/failed detail lookup must never break the poll loop — the
    // bot-status signal is the primary one.
    console.warn("[vexa] meeting detail lookup failed:", (error as Error).message);
    return null;
  }
}
