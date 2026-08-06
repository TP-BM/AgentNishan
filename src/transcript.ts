import type { SegmentRow } from "./db.ts";
import type { VexaTranscriptSegment } from "./vexa.ts";

/** Turn Vexa's wire segments into rows we can upsert. */
export function toRows(
  meetingId: string,
  segments: VexaTranscriptSegment[],
): SegmentRow[] {
  const rows: SegmentRow[] = [];

  for (const segment of segments) {
    const text = (segment.text ?? "").trim();
    if (text === "") continue;

    const start = typeof segment.start === "number" ? segment.start : 0;
    const end = typeof segment.end === "number" ? segment.end : start;
    const speaker = (segment.speaker ?? "").trim() || "Unknown";

    // segment_id is the upsert key: a draft segment and its later confirmed
    // version share an id, so the confirmation overwrites the draft. When Vexa
    // omits the id, synthesise a stable one from speaker + start time.
    const id =
      segment.segment_id === undefined || segment.segment_id === null
        ? `${speaker}@${start.toFixed(3)}`
        : String(segment.segment_id);

    rows.push({
      meeting_id: meetingId,
      segment_id: id,
      speaker,
      text,
      start_s: start,
      end_s: end,
    });
  }

  return rows;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface Turn {
  speaker: string;
  text: string;
  start_s: number;
}

/** Epoch seconds for 2001-09-09. No meeting offset can plausibly reach this. */
const ABSOLUTE_TIME_FLOOR = 1_000_000_000;

/**
 * Vexa reports `start` as an absolute epoch timestamp (e.g. 1785972327.053),
 * not seconds from the top of the meeting — rendering it raw produced
 * "496103:25:32" as a duration. Rebase on the first segment to get elapsed time.
 *
 * Only applied when the values really are absolute: rebasing genuine offsets
 * would silently discard leading silence (a first segment 75s in would render
 * as 00:00).
 */
function baseTime(segments: SegmentRow[]): number {
  const first = segments[0];
  if (first === undefined || first.start_s < ABSOLUTE_TIME_FLOOR) return 0;
  return first.start_s;
}

/** Merge consecutive segments from the same speaker into readable turns. */
export function toTurns(segments: SegmentRow[]): Turn[] {
  const base = baseTime(segments);
  const turns: Turn[] = [];

  for (const segment of segments) {
    const last = turns.at(-1);
    if (last !== undefined && last.speaker === segment.speaker) {
      last.text = `${last.text} ${segment.text}`.trim();
    } else {
      turns.push({
        speaker: segment.speaker,
        text: segment.text,
        start_s: segment.start_s - base,
      });
    }
  }

  return turns;
}

/** Plain-text transcript, the form the model sees. */
export function toPlainText(segments: SegmentRow[]): string {
  return toTurns(segments)
    .map((t) => `[${formatTimestamp(t.start_s)}] ${t.speaker}: ${t.text}`)
    .join("\n");
}

export function durationSeconds(segments: SegmentRow[]): number {
  const last = segments.at(-1);
  return last === undefined ? 0 : Math.max(0, last.end_s - baseTime(segments));
}
