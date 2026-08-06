/**
 * The "is this meeting over?" decision, isolated from I/O so it can be tested.
 *
 * Two signals are available and neither is fully trustworthy on its own:
 *   - /bots/status telling us the bot is gone (fast, but the payload shape is
 *     not pinned down in Vexa's docs, so it may never report our bot)
 *   - the transcript not growing (reliable, but indistinguishable from silence)
 *
 * So: when the bot has been *confirmed* running via status, trust its departure
 * quickly. When it hasn't, fall back to a much longer quiet period.
 */

export interface PollState {
  /** Bot was confirmed running via /bots/status at some point. */
  botSeen: boolean;
  /** Consecutive polls so far where the bot was reported absent. */
  gonePolls: number;
  /** Consecutive polls so far where the transcript did not grow. */
  stalePolls: number;
  /** Polls taken for this meeting, including the current one. */
  pollCount: number;
  segmentCount: number;
  lastSegmentCount: number;
  botRunning: boolean;
  ageMs: number;
}

export interface Thresholds {
  /** Absent polls before ending, once the bot was confirmed running. */
  goneThreshold: number;
  /**
   * Polls with no new transcript before ending a meeting whose bot is *still*
   * reported active. Vexa does not withdraw a bot when the call ends, so
   * without this a finished meeting runs to the duration ceiling, burning bot
   * credits the whole way.
   */
  staleThreshold: number;
  /** Absent polls before ending, when the bot was never confirmed. */
  quietThreshold: number;
  /** Polls to wait for admission before giving up. */
  admitThreshold: number;
  maxDurationMs: number;
}

export type PollDecision =
  | { action: "live" }
  | { action: "wait" }
  | { action: "finalise"; reason: string }
  | { action: "not-admitted" }
  | { action: "timeout-no-transcript" };

/** The parts of Vexa's meeting record that say how admission went. */
export interface AdmissionDetail {
  status?: string | undefined;
  completion_reason?: string | undefined;
  failure_stage?: string | undefined;
}

export type AdmissionVerdict =
  | { rejected: true; outcome: string }
  | { rejected: false };

/**
 * Completion reasons that mean someone actively denied the bot at the lobby
 * door, as opposed to nobody getting round to admitting it.
 *
 * An allowlist, for the usual reason: an unrecognised value falls through to
 * the admission timeout, which is slower but never wrong. A missing entry here
 * costs five minutes; a wrong entry would end a meeting that was about to
 * start.
 *
 * Only `awaiting_admission_rejected` has been seen live — Vexa recorded it 35
 * seconds after the request, while our own timeout would have waited 5 minutes.
 */
const REJECTED_REASONS = new Set(["awaiting_admission_rejected"]);

/**
 * Did Vexa already record that this bot will never get in?
 *
 * Called only while waiting in the lobby, so a `rejected` verdict is safe to
 * act on immediately.
 */
export function classifyAdmission(detail: AdmissionDetail | null): AdmissionVerdict {
  if (detail === null) return { rejected: false };

  const reason = detail.completion_reason;
  if (reason !== undefined && REJECTED_REASONS.has(reason)) {
    return { rejected: true, outcome: reason };
  }

  // Belt and braces: the stage is recorded separately from the reason string,
  // so a renamed reason still lands here as long as the meeting is marked
  // failed *at the admission step*.
  if (detail.status === "failed" && detail.failure_stage === "awaiting_admission") {
    return { rejected: true, outcome: reason ?? "awaiting_admission" };
  }

  return { rejected: false };
}

export function decide(state: PollState, limits: Thresholds): PollDecision {
  // A meeting that has run past the ceiling ends regardless of signals.
  if (state.ageMs >= limits.maxDurationMs) {
    return state.segmentCount > 0
      ? { action: "finalise", reason: "maximum meeting duration reached" }
      : { action: "timeout-no-transcript" };
  }

  if (state.botRunning) {
    // The bot being present is NOT evidence the meeting is still happening:
    // Vexa leaves it in the call after everyone else hangs up. Once a meeting
    // that produced transcript goes quiet for long enough, treat it as over
    // and withdraw the bot ourselves.
    const stalled = state.segmentCount === state.lastSegmentCount;
    if (
      state.botSeen &&
      state.segmentCount > 0 &&
      stalled &&
      state.stalePolls + 1 >= limits.staleThreshold
    ) {
      return {
        action: "finalise",
        reason: "transcript went quiet while the bot was still in the meeting",
      };
    }
    return { action: "live" };
  }

  // Nothing has happened at all: still in the lobby, or never admitted.
  if (!state.botSeen && state.segmentCount === 0) {
    return state.pollCount >= limits.admitThreshold
      ? { action: "not-admitted" }
      : { action: "wait" };
  }

  const threshold = state.botSeen ? limits.goneThreshold : limits.quietThreshold;
  const stalled = state.segmentCount === state.lastSegmentCount;

  if (state.gonePolls + 1 >= threshold && stalled) {
    return {
      action: "finalise",
      reason: state.botSeen
        ? "bot left the meeting"
        : "transcript stopped growing and the bot is not reported running",
    };
  }

  return { action: "wait" };
}
