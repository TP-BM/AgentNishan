import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_LENGTH,
  formatInviteToken,
  inviteUsable,
  newInviteToken,
  normaliseInviteToken,
  type Invite,
} from "../src/invite.ts";

/** Deterministic byte source, so a token can be asserted exactly. */
const bytes = (values: number[]) => (n: number) =>
  Uint8Array.from(Array.from({ length: n }, (_, i) => values[i % values.length]!));

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    token: "4K2P9WXM",
    label: "Marcus",
    created_at: 0,
    expires_at: null,
    max_meetings: 1,
    meetings_used: 0,
    max_duration_ms: 600_000,
    ...overrides,
  };
}

test("a token is the right length and uses only the alphabet", () => {
  const token = newInviteToken(bytes([0, 1, 2, 3, 250, 251, 252, 253]));
  assert.equal(token.length, TOKEN_LENGTH);
  assert.match(token, /^[0-9A-HJKMNP-TV-Z]+$/);
});

test("the alphabet excludes every confusable letter", () => {
  // I, L, O and U are the whole reason for Crockford base32 here: the token has
  // to survive being read aloud or copied off a screenshot.
  let seen = "";
  for (let b = 0; b < 256; b++) seen += newInviteToken(bytes([b]));
  for (const bad of ["I", "L", "O", "U"]) {
    assert.ok(!seen.includes(bad), `alphabet should not contain ${bad}`);
  }
});

test("normalising a generated token leaves it untouched", () => {
  // The load-bearing property. normalise() rewrites I/L to 1 and O to 0, so an
  // alphabet containing any of them would silently corrupt valid tokens on the
  // typed-code path.
  for (let b = 0; b < 256; b++) {
    const token = newInviteToken(bytes([b]));
    assert.equal(normaliseInviteToken(token), token);
  }
});

test("normalising accepts what a human would actually type", () => {
  assert.equal(normaliseInviteToken("4k2p-9wxm"), "4K2P9WXM");
  assert.equal(normaliseInviteToken("4K2P 9WXM"), "4K2P9WXM");
  assert.equal(normaliseInviteToken("  4K2P-9WXM  "), "4K2P9WXM");
});

test("normalising fixes the letters people mis-read", () => {
  // Someone transcribing off a screen sees an l where there is a 1.
  assert.equal(normaliseInviteToken("4K2Pl9XM"), "4K2P19XM");
  assert.equal(normaliseInviteToken("4K2PI9XM"), "4K2P19XM");
  assert.equal(normaliseInviteToken("4K2PO9XM"), "4K2P09XM");
});

test("formatting groups for reading, and survives a round trip", () => {
  assert.equal(formatInviteToken("4K2P9WXM"), "4K2P-9WXM");
  assert.equal(normaliseInviteToken(formatInviteToken("4K2P9WXM")), "4K2P9WXM");
});

test("a fresh invite is usable", () => {
  assert.deepEqual(inviteUsable(invite(), 1_000), { usable: true });
});

test("an expired invite is not, and says so", () => {
  const verdict = inviteUsable(invite({ expires_at: 500 }), 1_000);
  assert.equal(verdict.usable, false);
  assert.match(verdict.usable === false ? verdict.reason : "", /expired/i);
});

test("expiry is inclusive at the boundary", () => {
  assert.equal(inviteUsable(invite({ expires_at: 1_000 }), 999).usable, true);
  assert.equal(inviteUsable(invite({ expires_at: 1_000 }), 1_000).usable, false);
});

test("a spent invite is not usable", () => {
  const verdict = inviteUsable(invite({ meetings_used: 1 }), 1_000);
  assert.equal(verdict.usable, false);
  assert.match(verdict.usable === false ? verdict.reason : "", /already been used/i);
});

test("a multi-meeting invite counts down rather than dying at one", () => {
  const multi = { max_meetings: 3 };
  assert.equal(inviteUsable(invite({ ...multi, meetings_used: 0 }), 0).usable, true);
  assert.equal(inviteUsable(invite({ ...multi, meetings_used: 2 }), 0).usable, true);
  assert.equal(inviteUsable(invite({ ...multi, meetings_used: 3 }), 0).usable, false);
});

test("the exhausted message reflects how many meetings the invite had", () => {
  const single = inviteUsable(invite({ meetings_used: 1 }), 0);
  const multi = inviteUsable(invite({ max_meetings: 3, meetings_used: 3 }), 0);
  assert.match(single.usable === false ? single.reason : "", /already been used/i);
  assert.match(multi.usable === false ? multi.reason : "", /run out of meetings/i);
});
