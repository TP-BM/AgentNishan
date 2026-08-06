import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAdmission,
  decide,
  type PollState,
  type Thresholds,
} from "../src/poll-decision.ts";

const LIMITS: Thresholds = {
  goneThreshold: 2,
  staleThreshold: 15,
  quietThreshold: 15,
  admitThreshold: 45,
  maxDurationMs: 3 * 60 * 60 * 1000,
};

function state(overrides: Partial<PollState> = {}): PollState {
  return {
    botSeen: false,
    gonePolls: 0,
    stalePolls: 0,
    pollCount: 1,
    segmentCount: 0,
    lastSegmentCount: 0,
    botRunning: false,
    ageMs: 60_000,
    ...overrides,
  };
}

test("a running bot keeps the meeting live", () => {
  assert.deepEqual(decide(state({ botRunning: true }), LIMITS), { action: "live" });
});

test("waits in the lobby before giving up on admission", () => {
  assert.deepEqual(decide(state({ pollCount: 44 }), LIMITS), { action: "wait" });
  assert.deepEqual(decide(state({ pollCount: 45 }), LIMITS), { action: "not-admitted" });
});

test("a confirmed bot going away ends the meeting after goneThreshold polls", () => {
  const gone = { botSeen: true, segmentCount: 12, lastSegmentCount: 12 };
  assert.equal(decide(state({ ...gone, gonePolls: 0 }), LIMITS).action, "wait");
  assert.equal(decide(state({ ...gone, gonePolls: 1 }), LIMITS).action, "finalise");
});

test("does not end while the transcript is still growing", () => {
  const decision = decide(
    state({ botSeen: true, gonePolls: 5, segmentCount: 30, lastSegmentCount: 24 }),
    LIMITS,
  );
  assert.equal(decision.action, "wait");
});

test("without a confirmed bot, a short silence is not the end of the meeting", () => {
  // The regression this guards: if /bots/status never reports our bot, two
  // quiet polls (40s of silence) must NOT truncate a live meeting.
  const quiet = { botSeen: false, segmentCount: 40, lastSegmentCount: 40 };
  assert.equal(decide(state({ ...quiet, gonePolls: 1 }), LIMITS).action, "wait");
  assert.equal(decide(state({ ...quiet, gonePolls: 10 }), LIMITS).action, "wait");
  assert.equal(decide(state({ ...quiet, gonePolls: 14 }), LIMITS).action, "finalise");
});

test("the duration ceiling ends a meeting that has transcript", () => {
  const decision = decide(
    state({ ageMs: LIMITS.maxDurationMs + 1, segmentCount: 100, botRunning: true }),
    LIMITS,
  );
  assert.equal(decision.action, "finalise");
});

test("the duration ceiling fails a meeting that never produced transcript", () => {
  const decision = decide(
    state({ ageMs: LIMITS.maxDurationMs + 1, segmentCount: 0 }),
    LIMITS,
  );
  assert.equal(decision.action, "timeout-no-transcript");
});

test("a bot stuck in the lobby still times out as never-admitted", () => {
  // Vexa lists a lobby-bound bot with status "joining" indefinitely. The caller
  // maps that to botRunning=false, so the admission timeout can still fire —
  // otherwise a bot nobody admits looks "live" until the 3h ceiling.
  const lobby = { botRunning: false, botSeen: false, segmentCount: 0 };
  assert.equal(decide(state({ ...lobby, pollCount: 44 }), LIMITS).action, "wait");
  assert.equal(
    decide(state({ ...lobby, pollCount: 45 }), LIMITS).action,
    "not-admitted",
  );
});

test("transcript arriving without a status sighting still counts as live", () => {
  // Segments exist, so we are past the lobby even though botSeen is false.
  const decision = decide(
    state({ segmentCount: 3, lastSegmentCount: 0, pollCount: 50 }),
    LIMITS,
  );
  assert.equal(decision.action, "wait", "must not be treated as never-admitted");
});

test("a lingering bot does not keep a finished meeting alive forever", () => {
  // Vexa leaves the bot in the call after everyone hangs up: status stays
  // "active" and end_time stays null. Without a stall check the meeting would
  // run to the 3h ceiling, burning bot credits the whole way.
  const lingering = {
    botRunning: true,
    botSeen: true,
    segmentCount: 11,
    lastSegmentCount: 11,
  };
  assert.equal(decide(state({ ...lingering, stalePolls: 5 }), LIMITS).action, "live");
  assert.equal(decide(state({ ...lingering, stalePolls: 13 }), LIMITS).action, "live");
  assert.equal(
    decide(state({ ...lingering, stalePolls: 14 }), LIMITS).action,
    "finalise",
  );
});

test("an ongoing meeting is never ended by the stall check", () => {
  const talking = {
    botRunning: true,
    botSeen: true,
    segmentCount: 40,
    lastSegmentCount: 31,
    stalePolls: 99,
  };
  assert.equal(decide(state(talking), LIMITS).action, "live");
});

test("a silent bot that never captured anything is not finalised", () => {
  // segmentCount 0 means nothing was ever transcribed; finalising would just
  // produce an empty digest. The admission timeout owns this case instead.
  const silent = {
    botRunning: true,
    botSeen: true,
    segmentCount: 0,
    lastSegmentCount: 0,
    stalePolls: 99,
  };
  assert.equal(decide(state(silent), LIMITS).action, "live");
});

// ── Admission outcome ────────────────────────────────────────────────────────

test("a denied bot is recognised from the payload Vexa actually returns", () => {
  // Verbatim from GET /bots for meeting 25561 on 2026-08-06: requested at
  // 08:00:43, rejected at 08:01:18. Our admission timeout would have waited
  // until 08:05:43 to say anything.
  const verdict = classifyAdmission({
    status: "failed",
    completion_reason: "awaiting_admission_rejected",
    failure_stage: "awaiting_admission",
  });
  assert.deepEqual(verdict, {
    rejected: true,
    outcome: "awaiting_admission_rejected",
  });
});

test("a failure at the admission step counts even if the reason is renamed", () => {
  const verdict = classifyAdmission({
    status: "failed",
    failure_stage: "awaiting_admission",
  });
  assert.equal(verdict.rejected, true);
});

test("waiting in the lobby is not a rejection", () => {
  assert.equal(classifyAdmission({ status: "requested" }).rejected, false);
  assert.equal(classifyAdmission({ status: "active" }).rejected, false);
  assert.equal(classifyAdmission(null).rejected, false);
});

test("an unknown reason falls through to the timeout rather than ending early", () => {
  // The allowlist has to fail this way round: a reason we have never seen must
  // not end a meeting that is merely slow to start.
  assert.equal(
    classifyAdmission({ status: "failed", completion_reason: "something_new" })
      .rejected,
    false,
  );
});

test("a failure somewhere other than admission is not a lobby rejection", () => {
  assert.equal(
    classifyAdmission({ status: "failed", failure_stage: "transcription" })
      .rejected,
    false,
  );
});
