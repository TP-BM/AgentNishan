import { config } from "./config.ts";
import {
  activeMeetings,
  countSegments,
  getIdentity,
  getMeeting,
  getSegments,
  interruptedMeetings,
  saveDigest,
  updateMeeting,
  upsertSegments,
  type MeetingRow,
} from "./db.ts";
import { generateDigest } from "./digest.ts";
import { digestEmail, digestSubject, mailer, notAdmittedEmail } from "./mailer.ts";
import { decide } from "./poll-decision.ts";
import { toPlainText, toRows } from "./transcript.ts";
import {
  getBotState,
  getMeetingDetail,
  getTranscript,
  stopBot,
  VexaError,
} from "./vexa.ts";

const THRESHOLDS = {
  goneThreshold: config.poll.goneThreshold,
  staleThreshold: config.poll.staleThreshold,
  /**
   * Polls with no new transcript before ending, when the bot was never
   * confirmed running. Deliberately long (15 x 20s = 5 min): without the status
   * signal, a quiet stretch is indistinguishable from the end of the meeting,
   * and ending early truncates the digest.
   */
  quietThreshold: 15,
  admitThreshold: config.poll.admitThreshold,
  maxDurationMs: config.poll.maxDurationMs,
};

const inFlight = new Set<string>();
let timer: NodeJS.Timeout | null = null;

export function startPoller(): void {
  if (timer !== null) return;

  // A meeting that was mid-digest when the process died is invisible to the
  // poll loop (it only watches dispatched/live), so pick those up explicitly.
  for (const meeting of interruptedMeetings()) {
    console.log(`[poll] resuming interrupted digest for ${meeting.id}`);
    void runDigest(meeting.id).catch((error: Error) => {
      console.error(`[digest] resume failed for ${meeting.id}:`, error.message);
    });
  }

  timer = setInterval(() => {
    void tick();
  }, config.poll.intervalMs);
  // Live meetings resume on the first tick — active state lives in SQLite
  // rather than in this process.
  void tick();
}

export function stopPoller(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  for (const meeting of activeMeetings()) {
    if (inFlight.has(meeting.id)) continue;
    inFlight.add(meeting.id);
    try {
      await pollMeeting(meeting);
    } catch (error) {
      console.error(`[poll] ${meeting.id} failed:`, (error as Error).message);
    } finally {
      inFlight.delete(meeting.id);
    }
  }
}

async function pollMeeting(meeting: MeetingRow): Promise<void> {
  const pollCount = meeting.poll_count + 1;
  updateMeeting(meeting.id, { poll_count: pollCount });

  // 1. Pull transcript first — it is the signal that matters most.
  //
  // This must not throw out of the poll: an unguarded failure here skips the
  // bot-status check below, so the meeting never advances and never ends. A
  // scope error is terminal (it will fail identically forever), so fail loudly
  // rather than retrying for hours.
  try {
    const segments = await getTranscript(meeting.native_meeting_id);
    upsertSegments(meeting.id, toRows(meeting.id, segments));
  } catch (error) {
    if (error instanceof VexaError && (error.status === 401 || error.status === 403)) {
      console.error(`[poll] ${meeting.id} cannot read transcripts:`, error.friendly());
      updateMeeting(meeting.id, {
        status: "failed",
        error: error.friendly(),
        ended_at: Date.now(),
      });
      await stopBot(meeting.native_meeting_id).catch(() => {});
      return;
    }
    console.warn("[poll] transcript fetch failed:", (error as Error).message);
  }

  const segmentCount = countSegments(meeting.id);

  // 2. Is the bot actually in the room?
  //
  // "Listed" is not the same as "in the meeting": a bot waiting in the Google
  // Meet lobby is listed with status "joining" and stays that way forever if
  // nobody admits it. Only a bot past the lobby counts as running, otherwise
  // the never-admitted timeout can never fire.
  let running: boolean;
  try {
    const state = await getBotState(meeting.native_meeting_id);
    running = state.inMeeting;

    if (state.present && !state.inMeeting && meeting.poll_count % 5 === 0) {
      console.log(
        `[poll] ${meeting.id} still in the lobby (status=${state.status}) — someone has to admit the bot`,
      );
    }
    if (running && meeting.bot_seen === 0) {
      console.log(`[poll] ${meeting.id} bot admitted (status=${state.status})`);
    }
    if (!state.present && meeting.bot_seen === 1) {
      console.log(`[poll] ${meeting.id} bot has left the meeting`);
    }
  } catch (error) {
    // A status-endpoint failure means "unknown", not "gone". Skip this poll —
    // the quiet threshold still terminates the meeting eventually.
    console.warn("[poll] bot status check failed:", (error as Error).message);
    updateMeeting(meeting.id, { last_segment_count: segmentCount });
    return;
  }

  const stalled = segmentCount === meeting.last_segment_count;

  const decision = decide(
    {
      botSeen: meeting.bot_seen === 1,
      gonePolls: meeting.gone_polls,
      stalePolls: meeting.stale_polls,
      pollCount,
      segmentCount,
      lastSegmentCount: meeting.last_segment_count,
      botRunning: running,
      ageMs: Date.now() - meeting.created_at,
    },
    THRESHOLDS,
  );

  switch (decision.action) {
    case "live": {
      const stalePolls = stalled ? meeting.stale_polls + 1 : 0;
      if (stalePolls > 0 && stalePolls % 5 === 0) {
        console.log(
          `[poll] ${meeting.id} no new transcript for ${stalePolls} polls ` +
            `(ends at ${THRESHOLDS.staleThreshold})`,
        );
      }
      updateMeeting(meeting.id, {
        bot_seen: 1,
        status: "live",
        gone_polls: 0,
        stale_polls: stalePolls,
        last_segment_count: segmentCount,
      });
      return;
    }

    case "wait":
      updateMeeting(meeting.id, {
        gone_polls: running ? 0 : meeting.gone_polls + 1,
        last_segment_count: segmentCount,
        status: segmentCount > 0 ? "live" : meeting.status,
      });
      return;

    case "finalise":
      updateMeeting(meeting.id, { last_segment_count: segmentCount });
      await finalise(meeting.id, decision.reason);
      return;

    case "not-admitted": {
      const detail = await getMeetingDetail(meeting.vexa_meeting_id);
      await failNotAdmitted(meeting, detail?.bot_outcome ?? "never_admitted");
      return;
    }

    case "timeout-no-transcript":
      updateMeeting(meeting.id, {
        status: "failed",
        error: "Timed out with no transcript captured.",
        ended_at: Date.now(),
      });
      await stopBot(meeting.native_meeting_id).catch(() => {});
      return;
  }
}

async function failNotAdmitted(meeting: MeetingRow, outcome: string): Promise<void> {
  updateMeeting(meeting.id, {
    status: "failed",
    error:
      "The bot was never admitted to the meeting, so there is no transcript. Someone already in the meeting has to let it in from the lobby.",
    bot_outcome: outcome,
    ended_at: Date.now(),
  });

  await stopBot(meeting.native_meeting_id).catch(() => {});

  const identity = getIdentity();
  if (identity.email === "") return;

  const message = notAdmittedEmail(
    meeting.meet_url,
    `${config.baseUrl}/m/${meeting.id}`,
  );
  try {
    await mailer().send({ to: identity.email, ...message });
    updateMeeting(meeting.id, { emailed_at: Date.now() });
  } catch (error) {
    console.error("[mail] not-admitted notice failed:", (error as Error).message);
  }
}

/** End the meeting and produce the digest. Safe to call from the UI too. */
export async function finalise(meetingId: string, reason: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  if (meeting === undefined) return;

  console.log(`[poll] finalising ${meetingId}: ${reason}`);
  updateMeeting(meetingId, { status: "transcribing", ended_at: Date.now() });

  await stopBot(meeting.native_meeting_id).catch(() => {});

  // One last transcript pull — the tail often lands after the bot departs.
  try {
    const segments = await getTranscript(meeting.native_meeting_id);
    upsertSegments(meetingId, toRows(meetingId, segments));
  } catch (error) {
    console.warn("[poll] final transcript pull failed:", (error as Error).message);
  }

  await runDigest(meetingId);
}

/**
 * Re-pull the transcript from Vexa, then digest. This is the retry path: Vexa
 * keeps the transcript server-side, so a meeting that failed locally (bad key
 * scope, an outage mid-poll) can be recovered in full afterwards.
 */
export async function refetchAndDigest(meetingId: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  if (meeting === undefined) return;

  updateMeeting(meetingId, { status: "transcribing", error: null });

  try {
    const segments = await getTranscript(meeting.native_meeting_id);
    upsertSegments(meetingId, toRows(meetingId, segments));
    console.log(
      `[poll] refetched ${segments.length} segments for ${meetingId}`,
    );
  } catch (error) {
    const message =
      error instanceof VexaError ? error.friendly() : (error as Error).message;
    console.error(`[poll] refetch failed for ${meetingId}:`, message);
    updateMeeting(meetingId, {
      status: "failed",
      error: `Could not fetch the transcript from Vexa. ${message}`,
    });
    return;
  }

  await runDigest(meetingId);
}

/** Generate + save + email the digest. Exposed so the UI can retry it. */
export async function runDigest(meetingId: string): Promise<void> {
  const meeting = getMeeting(meetingId);
  if (meeting === undefined) return;

  const segments = getSegments(meetingId);
  if (segments.length === 0) {
    updateMeeting(meetingId, {
      status: "failed",
      error:
        "No transcript was captured. If Vexa's dashboard shows one for this meeting, " +
        "use Fetch transcript & retry — the transcript lives on Vexa's side and can " +
        "still be pulled.",
    });
    return;
  }

  updateMeeting(meetingId, { status: "transcribing", error: null });

  const identity = getIdentity();
  let result;
  try {
    result = await generateDigest(toPlainText(segments), identity, meeting.title);
  } catch (error) {
    console.error(`[digest] ${meetingId} failed:`, (error as Error).message);
    updateMeeting(meetingId, {
      status: "failed",
      error: `Digest failed: ${(error as Error).message}`,
    });
    return;
  }

  const { digest } = result;
  saveDigest({
    meeting_id: meetingId,
    summary: digest.summary,
    decisions_json: JSON.stringify(digest.decisions),
    action_items_json: JSON.stringify(digest.action_items),
    open_questions_json: JSON.stringify(digest.open_questions),
    risks_json: JSON.stringify(digest.risks),
    model: result.model,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    created_at: Date.now(),
  });

  updateMeeting(meetingId, {
    status: "done",
    error: null,
    // Prefer the model's title over the raw meeting code.
    title: digest.title.trim() === "" ? meeting.title : digest.title.trim(),
  });

  // The digest is already saved and visible in the app. A failed send is a
  // missing notification, not a lost meeting.
  if (identity.email === "") {
    console.warn("[mail] no notify address configured, skipping digest email");
    return;
  }

  try {
    const body = digestEmail(digest, `${config.baseUrl}/m/${meetingId}`);
    await mailer().send({
      to: identity.email,
      subject: digestSubject(digest),
      ...body,
    });
    updateMeeting(meetingId, { emailed_at: Date.now() });
  } catch (error) {
    console.error("[mail] digest email failed:", (error as Error).message);
  }
}
