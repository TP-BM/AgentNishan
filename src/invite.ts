/**
 * Invite tokens — the credential for a demo run.
 *
 * The token is the whole login: possession of it is the authorisation, the way
 * an "anyone with the link" share works. That puts two demands on the format
 * which pull against each other, and the alphabet is the compromise:
 *
 *   - It rides in a URL, so it has to be short enough to paste anywhere.
 *   - It has to survive being *typed*, because links get truncated in Slack
 *     previews, mangled by chat apps, and read aloud off someone's screen.
 *
 * Hence Crockford base32: no I, L, O or U, so nothing is ambiguous when spoken
 * and there is no obscenity to stumble into. 32^8 is ~10^12 combinations
 * against a handful of live invites, so guessing is hopeless — but the caller
 * should still rate-limit the typed-code route, because cheap guesses are
 * cheap.
 *
 * Storage and lookup are the caller's business; everything here is pure.
 */

/** Crockford base32: 0-9 and A-Z minus I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const TOKEN_LENGTH = 8;

export interface Invite {
  token: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  max_meetings: number;
  meetings_used: number;
  max_duration_ms: number;
}

/**
 * A fresh token. `bytes` is injected so tests are deterministic; the caller
 * passes `randomBytes`.
 *
 * `byte % 32` is unbiased here because 256 divides evenly by 32 — worth stating
 * because the same line with a 33-character alphabet would quietly skew.
 */
export function newInviteToken(bytes: (n: number) => Uint8Array): string {
  const raw = bytes(TOKEN_LENGTH);
  let out = "";
  for (const b of raw) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Clean up a token a human typed or pasted.
 *
 * Drops separators and whitespace, uppercases, and applies Crockford's
 * confusable rules — I and L read as 1, O reads as 0 — so someone transcribing
 * `4K2P-9WXM` off a screen lands on the right invite even if they see an "l"
 * where there is a "1".
 */
export function normaliseInviteToken(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** Grouped for display and for reading out loud. Never stored in this form. */
export function formatInviteToken(token: string): string {
  return token.length <= 4 ? token : `${token.slice(0, 4)}-${token.slice(4)}`;
}

export type InviteVerdict =
  | { usable: true }
  | { usable: false; reason: string };

/**
 * Can this invite still be used?
 *
 * The reason string is shown to whoever followed the link, so it says what
 * happened and what to do about it — a friend bounced to a bare "invalid" (or
 * worse, a password prompt) assumes the thing is broken rather than spent.
 */
export function inviteUsable(invite: Invite, now: number): InviteVerdict {
  if (invite.expires_at !== null && now >= invite.expires_at) {
    return { usable: false, reason: "This invite has expired. Ask Thilina for a new one." };
  }
  if (invite.meetings_used >= invite.max_meetings) {
    return {
      usable: false,
      reason:
        invite.max_meetings === 1
          ? "This invite has already been used. Ask Thilina for a new one."
          : "This invite has run out of meetings. Ask Thilina for a new one.",
    };
  }
  return { usable: true };
}
