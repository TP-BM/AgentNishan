import { test } from "node:test";
import assert from "node:assert/strict";
import {
  durationSeconds,
  formatTimestamp,
  toRows,
  toTurns,
  toPlainText,
} from "../src/transcript.ts";
import type { SegmentRow } from "../src/db.ts";

test("drops empty segments and defaults a missing speaker", () => {
  const rows = toRows("m1", [
    { segment_id: "a", speaker: "Ana", text: "Hello", start: 1, end: 2 },
    { segment_id: "b", speaker: "Ana", text: "   ", start: 3, end: 4 },
    { segment_id: "c", speaker: null, text: "Who said that", start: 5, end: 6 },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.speaker, "Unknown");
});

test("synthesises a stable id when Vexa omits segment_id", () => {
  const once = toRows("m1", [{ speaker: "Ana", text: "Hi", start: 1.5, end: 2 }]);
  const twice = toRows("m1", [{ speaker: "Ana", text: "Hi there", start: 1.5, end: 3 }]);

  // Same id both times, so the upsert overwrites rather than duplicating.
  assert.equal(once[0]?.segment_id, twice[0]?.segment_id);
});

function seg(over: Partial<SegmentRow>): SegmentRow {
  return {
    meeting_id: "m1",
    segment_id: "s",
    speaker: "Ana",
    text: "hi",
    start_s: 0,
    end_s: 1,
    ...over,
  };
}

test("merges consecutive turns from the same speaker", () => {
  const turns = toTurns([
    seg({ segment_id: "1", speaker: "Ana", text: "We should ship", start_s: 0 }),
    seg({ segment_id: "2", speaker: "Ana", text: "on Friday.", start_s: 3 }),
    seg({ segment_id: "3", speaker: "Bo", text: "Agreed.", start_s: 6 }),
    seg({ segment_id: "4", speaker: "Ana", text: "Good.", start_s: 9 }),
  ]);

  assert.equal(turns.length, 3);
  assert.equal(turns[0]?.text, "We should ship on Friday.");
  assert.equal(turns[0]?.start_s, 0, "merged turn keeps the first start time");
});

test("plain text carries speaker and timestamp for attribution", () => {
  const text = toPlainText([
    seg({ segment_id: "1", speaker: "Ana", text: "Ship Friday.", start_s: 75 }),
  ]);
  assert.equal(text, "[01:15] Ana: Ship Friday.");
});

test("timestamps roll over into hours", () => {
  assert.equal(formatTimestamp(0), "00:00");
  assert.equal(formatTimestamp(59), "00:59");
  assert.equal(formatTimestamp(600), "10:00");
  assert.equal(formatTimestamp(3661), "1:01:01");
});

test("absolute epoch timestamps are rebased to elapsed time", () => {
  // Real values from Vexa: `start` is epoch seconds, not an offset. Rendering
  // them raw produced "496103:25:32" as a meeting duration.
  const segs = [
    seg({ segment_id: "1", speaker: "Ana", text: "Kick off.", start_s: 1785972327.053, end_s: 1785972332.485 }),
    // Exactly 60s after the first, so the expectation isn't a rounding artefact.
    seg({ segment_id: "2", speaker: "Bo", text: "Agreed.", start_s: 1785972387.053, end_s: 1785972390.053 }),
  ];

  const turns = toTurns(segs);
  assert.equal(turns[0]?.start_s, 0);
  assert.equal(formatTimestamp(turns[1]?.start_s ?? 0), "01:00");
  assert.equal(formatTimestamp(durationSeconds(segs)), "01:03");
});

test("already-relative timestamps are unaffected by rebasing", () => {
  const segs = [
    seg({ segment_id: "1", speaker: "Ana", text: "Hi", start_s: 0, end_s: 4 }),
    seg({ segment_id: "2", speaker: "Bo", text: "Yo", start_s: 30, end_s: 34 }),
  ];
  assert.equal(toTurns(segs)[1]?.start_s, 30);
  assert.equal(durationSeconds(segs), 34);
});
