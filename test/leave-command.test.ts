import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NAMES,
  describeMatch,
  detectLeaveCommand,
  normalise,
} from "../src/leave-command.ts";

const CONFIG = { names: DEFAULT_NAMES, window: 60 };
const detect = (text: string) => detectLeaveCommand(text, CONFIG);

test("fires on the phrase as spoken", () => {
  assert.ok(detect("Nishan, leave the meeting"));
  assert.ok(detect("nishan leave the meeting"));
  assert.ok(detect("OK Nishan you can leave"));
});

test("survives the way transcripts actually arrive", () => {
  // No punctuation, no capitals, run together with surrounding speech —
  // this is what Vexa returns.
  assert.ok(detect("okay i think thats everything nishan leave the meeting thanks"));
  assert.ok(
    detect("[04:12] Priya Raman: right thats us done nishan you can leave now"),
  );
});

test("tolerates the name being misheard", () => {
  // "Nissan" is the common one; the others show up too.
  assert.ok(detect("nissan leave the meeting"));
  assert.ok(detect("nishawn you can go"));
  assert.ok(detect("nishaan please leave"));
});

test("accepts alternative phrasings of the command", () => {
  for (const phrase of [
    "nishan leave the call",
    "nishan exit the meeting",
    "nishan stop recording",
    "nishan you can go",
    "nishan drop off the call",
  ]) {
    assert.ok(detect(phrase), `should have fired on: ${phrase}`);
  }
});

test("does not fire without the name", () => {
  // Someone talking about leaving is not addressing the bot.
  assert.equal(detect("I need to leave the meeting early today"), null);
  assert.equal(detect("she had to leave the call to pick up her kid"), null);
  assert.equal(detect("can everyone please leave the room"), null);
});

test("does not fire on the name alone", () => {
  assert.equal(detect("nishan is going to write that up"), null);
  assert.equal(detect("did nishan send the notes"), null);
});

test("does not fire when name and command are far apart", () => {
  // Name at the start, an unrelated departure a paragraph later.
  const text =
    "nishan will take the action item on pricing " +
    "and we should double check the numbers before friday because the board " +
    "wants them early and then marcus had to leave the meeting";
  assert.equal(detect(text), null);
});

test("does not match a name embedded in another word", () => {
  assert.equal(detect("nishika leave the meeting"), null);
  assert.equal(detect("banish leave the meeting"), null);
});

test("requires the command to follow the name, not precede it", () => {
  // "leave the meeting, Nishan" is a real phrasing but ordering the match this
  // way is what keeps ordinary talk about leaving from ending the call.
  assert.equal(detect("leave the meeting nishan"), null);
});

test("reports what matched, for the audit trail", () => {
  const match = detect("alright thats it nishan leave the meeting cheers");
  assert.equal(match?.name, "nishan");
  assert.equal(match?.command, "leave the meeting");
  assert.ok(match?.excerpt.includes("nishan leave the meeting"));
});

test("finds the command on a later mention of the name", () => {
  // First mention is unrelated; the second carries the instruction.
  const match = detect(
    "nishan should own that one yes agreed okay nishan leave the meeting",
  );
  assert.ok(match);
});

// ── Nameless commands ────────────────────────────────────────────────────────
// Off by default, so every test above describes behaviour with a name required.

const loose = (text: string) =>
  detectLeaveCommand(text, { ...CONFIG, nameless: true });

test("nameless commands stay off unless asked for", () => {
  assert.equal(detect("okay everyone stop recording"), null);
});

test("fires on a nameless phrase aimed only at a recorder", () => {
  assert.ok(loose("i don't get it stop recording stop recording is this native"));
  assert.ok(loose("right we're done here stop transcribing"));
});

test("nameless matching stays narrow", () => {
  // The whole point of the short list: these are things people say about each
  // other, and they must not end the meeting on their own.
  assert.equal(loose("marcus had to leave the meeting early"), null);
  assert.equal(loose("can you leave the call when you're done"), null);
  assert.equal(loose("she said you can go ahead"), null);
});

test("a negated phrase is not an instruction", () => {
  assert.equal(loose("we should not stop recording this one"), null);
  assert.equal(loose("don't stop recording yet"), null);
  assert.equal(loose("please do not stop transcribing"), null);
});

test("a negation earlier does not mask a real command later", () => {
  assert.ok(loose("don't stop recording yet ... okay we're done stop recording"));
});

test("reports a nameless match with no name", () => {
  const match = loose("alright thats everything stop recording thanks");
  assert.equal(match?.name, null);
  assert.equal(match?.command, "stop recording");
  assert.equal(describeMatch(match!), "stop recording");
});

test("real meeting, 2026-08-06: the command was missed three ways", () => {
  // Verbatim from Vexa for meeting zzn-fhbq-xyg, which ended on the stale
  // timeout three minutes after the last word rather than on the instruction.
  // Every miss in this excerpt is a different failure, which is why it is here.
  const transcript = [
    "pre-peak let's let's add that to that epic now i will send the epic over in the channel too",
    "can you leave the meeting", // the ask — no name in it at all
    "okay thank you guys",
    "Let's see if Nathan leaves. So, the beginning of the system.", // "Nishan" → "Nathan"
    "I don't get it. Stop recording. Stop recording. Is this native?",
    "but to leave in about 20 seconds",
    "AFL So he stays in the meeting",
    "Thanks for staying here", // the room noticing it did not work
  ].join("\n");

  // What shipped at the time: a name was required, and "nathan" was not a
  // known variant.
  assert.equal(
    detectLeaveCommand(transcript, {
      names: ["nishan", "nishaan", "nishawn", "nissan", "nish"],
      window: 60,
    }),
    null,
  );

  // "nathan" alone still misses: the name lands 100+ characters from any
  // command, so widening the window would only stitch together unrelated
  // speech.
  assert.equal(detect(transcript), null);

  // The nameless phrase is what actually catches it.
  const match = loose(transcript);
  assert.equal(match?.command, "stop recording");
  assert.equal(match?.name, null);
});

test("normalise strips punctuation and case", () => {
  assert.equal(normalise("Nishan, LEAVE the meeting!"), "nishan leave the meeting");
  assert.equal(normalise("  spaced   out  "), "spaced out");
});
