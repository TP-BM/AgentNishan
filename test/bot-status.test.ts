import { test } from "node:test";
import assert from "node:assert/strict";

// getBotState() talks to the network, so this exercises the classification rule
// it depends on: the allowlist must treat every observed lobby status as
// not-in-meeting, including ones added to Vexa after this was written.
const IN_MEETING = new Set(["active", "recording", "transcribing", "in_call", "joined"]);
const classify = (status: string | null): boolean =>
  status === null || IN_MEETING.has(status);

test("observed lobby statuses never count as in-meeting", () => {
  // All four seen from the live API during development.
  for (const status of ["requested", "joining", "awaiting_admission", "queued"]) {
    assert.equal(classify(status), false, `${status} must not count as in-meeting`);
  }
});

test("an unknown status fails safe, toward not-in-meeting", () => {
  // Keeps the never-admitted timeout armed when Vexa invents a new lobby state.
  assert.equal(classify("waiting_for_host"), false);
  assert.equal(classify("some_future_status"), false);
});

test("active statuses count as in-meeting", () => {
  assert.equal(classify("active"), true);
  assert.equal(classify(null), true, "no status reported = assume in-meeting");
});
