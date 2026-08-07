import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { newInviteToken, type Invite } from "./invite.ts";

export type { Invite };

export type MeetingStatus =
  | "dispatched" // bot requested, not yet seen in the meeting
  | "live" // bot admitted, transcript accumulating
  | "transcribing" // meeting over, digest being generated
  | "done"
  | "failed";

export interface MeetingRow {
  id: string;
  meet_url: string;
  native_meeting_id: string;
  vexa_meeting_id: string | null;
  title: string;
  status: MeetingStatus;
  error: string | null;
  created_at: number;
  ended_at: number | null;
  bot_seen: number;
  gone_polls: number;
  stale_polls: number;
  poll_count: number;
  last_segment_count: number;
  bot_outcome: string | null;
  end_reason: string | null;
  emailed_at: number | null;
  /** Invite that created this meeting. Null means it is the owner's own. */
  invite_id: string | null;
  /** When the bot was first seen past the lobby — the demo clock starts here. */
  admitted_at: number | null;
}

/**
 * Who is asking.
 *
 * Admin is the owner via APP_SECRET and sees every meeting; an invite sees only
 * the meetings its own token created, and never the owner's.
 *
 * Deliberately an explicit parameter rather than an ambient "current user":
 * every read that can be reached from a URL takes it, so forgetting one is a
 * type error at build time instead of one person's transcript rendered for
 * another. The cost is churn at the call sites, which is the point.
 */
export type Scope = { kind: "admin" } | { kind: "invite"; token: string };

export const ADMIN: Scope = { kind: "admin" };

/** The scope that owns a meeting — for background work acting on its behalf. */
export function scopeOf(meeting: MeetingRow): Scope {
  return meeting.invite_id === null
    ? ADMIN
    : { kind: "invite", token: meeting.invite_id };
}

function visible(scope: Scope, meeting: MeetingRow): boolean {
  return scope.kind === "admin" || meeting.invite_id === scope.token;
}

export interface SegmentRow {
  meeting_id: string;
  segment_id: string;
  speaker: string;
  text: string;
  start_s: number;
  end_s: number;
}

export interface DigestRow {
  meeting_id: string;
  summary: string;
  decisions_json: string;
  action_items_json: string;
  open_questions_json: string;
  risks_json: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
}

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id                 TEXT PRIMARY KEY,
  meet_url           TEXT NOT NULL,
  native_meeting_id  TEXT NOT NULL,
  vexa_meeting_id    TEXT,
  title              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  bot_seen           INTEGER NOT NULL DEFAULT 0,
  gone_polls         INTEGER NOT NULL DEFAULT 0,
  poll_count         INTEGER NOT NULL DEFAULT 0,
  last_segment_count INTEGER NOT NULL DEFAULT 0,
  bot_outcome        TEXT,
  emailed_at         INTEGER
);

CREATE TABLE IF NOT EXISTS segments (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  speaker    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  start_s    REAL NOT NULL DEFAULT 0,
  end_s      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (meeting_id, segment_id)
);

CREATE TABLE IF NOT EXISTS digests (
  meeting_id         TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  summary            TEXT NOT NULL,
  decisions_json     TEXT NOT NULL,
  action_items_json  TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  risks_json         TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token           TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  max_meetings    INTEGER NOT NULL DEFAULT 1,
  meetings_used   INTEGER NOT NULL DEFAULT 0,
  max_duration_ms INTEGER NOT NULL DEFAULT 600000
);
`);

/** Add a column to an existing table if it isn't there yet (cheap migration). */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
}

// Consecutive polls where the transcript did not grow while the bot was still
// reported in the meeting. Added after Vexa turned out to leave bots running
// indefinitely once a call ends.
ensureColumn("meetings", "stale_polls", "INTEGER NOT NULL DEFAULT 0");

// Why the meeting ended — shown in the UI so a surprise ending is explainable
// (especially the voice command, which fires without anyone touching the app).
ensureColumn("meetings", "end_reason", "TEXT");

// Which invite created this meeting. Existing rows migrate to NULL, which means
// "the owner's own" — so nothing already in the database becomes visible to a
// demo visitor as a side effect of this migration.
ensureColumn("meetings", "invite_id", "TEXT");

// When the bot got past the lobby. A demo's time limit is measured from here,
// not from dispatch: a first-timer hunting for the Admit button would otherwise
// spend their whole allowance in the waiting room.
ensureColumn("meetings", "admitted_at", "INTEGER");

export function newId(): string {
  return randomBytes(6).toString("hex");
}

// --- settings ----------------------------------------------------------------

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export interface Identity {
  displayName: string;
  aliases: string[];
  email: string;
}

/**
 * Who the digest should treat as "me".
 *
 * For the owner this is the settings table. For an invite it is the label typed
 * when the link was minted — you already know your friend's name at that point,
 * so the demo form doesn't have to ask, and it can't be got wrong.
 *
 * An invite has no email here yet; the address comes off the demo form and is
 * carried on the meeting. An empty address makes `runDigest` skip the send with
 * a warning rather than fail, which is the behaviour we want either way.
 */
export function getIdentity(scope: Scope): Identity {
  if (scope.kind === "invite") {
    const invite = getInvite(scope.token);
    return { displayName: invite?.label ?? "", aliases: [], email: "" };
  }
  const raw = getSetting("aliases", "");
  return {
    displayName: getSetting("display_name", ""),
    aliases: raw
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    email: getSetting("notify_email", config.mail.to),
  };
}

/** Every name the user might be called in a transcript, deduped. */
export function identityNames(identity: Identity): string[] {
  const all = [identity.displayName, ...identity.aliases]
    .map((n) => n.trim())
    .filter(Boolean);
  return [...new Set(all)];
}

// --- meetings ----------------------------------------------------------------

export function createMeeting(input: {
  meetUrl: string;
  nativeMeetingId: string;
  title: string;
  scope: Scope;
}): MeetingRow {
  const id = newId();
  const inviteId = input.scope.kind === "invite" ? input.scope.token : null;
  db.prepare(
    `INSERT INTO meetings (id, meet_url, native_meeting_id, title, status, created_at, invite_id)
     VALUES (?, ?, ?, ?, 'dispatched', ?, ?)`,
  ).run(id, input.meetUrl, input.nativeMeetingId, input.title, Date.now(), inviteId);
  return getMeeting(input.scope, id)!;
}

/**
 * Undefined both when the meeting doesn't exist and when it isn't yours — the
 * caller renders the same not-found either way, so a guessed id can't be used
 * to learn that someone else's meeting exists.
 */
export function getMeeting(scope: Scope, id: string): MeetingRow | undefined {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | MeetingRow
    | undefined;
  return row !== undefined && visible(scope, row) ? row : undefined;
}

export function listMeetings(scope: Scope): MeetingRow[] {
  if (scope.kind === "admin") {
    return db
      .prepare("SELECT * FROM meetings ORDER BY created_at DESC")
      .all() as unknown as MeetingRow[];
  }
  return db
    .prepare("SELECT * FROM meetings WHERE invite_id = ? ORDER BY created_at DESC")
    .all(scope.token) as unknown as MeetingRow[];
}

/**
 * Meetings the poller still needs to watch, across every invite.
 *
 * Deliberately unscoped — the poll loop is background work on behalf of the
 * system, not a request from anyone. Callers must not render these to a
 * visitor; go through `getMeeting` for that.
 */
export function activeMeetings(): MeetingRow[] {
  return db
    .prepare(
      "SELECT * FROM meetings WHERE status IN ('dispatched','live') ORDER BY created_at ASC",
    )
    .all() as unknown as MeetingRow[];
}

/**
 * Meetings that were mid-digest when the process died. Without this they sit in
 * `transcribing` forever, since the poller only watches dispatched/live.
 */
export function interruptedMeetings(): MeetingRow[] {
  return db
    .prepare("SELECT * FROM meetings WHERE status = 'transcribing'")
    .all() as unknown as MeetingRow[];
}

export function updateMeeting(id: string, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE meetings SET ${assignments} WHERE id = ?`).run(
    ...keys.map((k) => fields[k] as never),
    id,
  );
}

export function deleteMeeting(scope: Scope, id: string): void {
  const meeting = getMeeting(scope, id);
  if (meeting === undefined) return;
  db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
}

// --- invites -----------------------------------------------------------------

export function createInvite(input: {
  label: string;
  expiresAt?: number | null;
  maxMeetings?: number;
  maxDurationMs?: number;
}): Invite {
  const token = newInviteToken((n) => randomBytes(n));
  db.prepare(
    `INSERT INTO invites (token, label, created_at, expires_at, max_meetings, max_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    input.label,
    Date.now(),
    input.expiresAt ?? null,
    input.maxMeetings ?? 1,
    input.maxDurationMs ?? 600_000,
  );
  return getInvite(token)!;
}

export function getInvite(token: string): Invite | undefined {
  return db.prepare("SELECT * FROM invites WHERE token = ?").get(token) as
    | Invite
    | undefined;
}

export function listInvites(): Invite[] {
  return db
    .prepare("SELECT * FROM invites ORDER BY created_at DESC")
    .all() as unknown as Invite[];
}

/**
 * Spend one of the invite's meetings.
 *
 * The `meetings_used < max_meetings` guard is in the UPDATE rather than checked
 * beforehand, so two simultaneous submissions on the same link can't both pass
 * a read-then-write check and get two bots. Returns whether it succeeded.
 */
export function consumeInvite(token: string): boolean {
  const result = db
    .prepare(
      `UPDATE invites SET meetings_used = meetings_used + 1
       WHERE token = ? AND meetings_used < max_meetings`,
    )
    .run(token);
  return result.changes > 0;
}

export function deleteInvite(token: string): void {
  db.prepare("DELETE FROM invites WHERE token = ?").run(token);
}

// --- segments ----------------------------------------------------------------

export function upsertSegments(meetingId: string, segments: SegmentRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO segments (meeting_id, segment_id, speaker, text, start_s, end_s)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id, segment_id) DO UPDATE SET
       speaker = excluded.speaker,
       text    = excluded.text,
       start_s = excluded.start_s,
       end_s   = excluded.end_s`,
  );
  for (const s of segments) {
    stmt.run(meetingId, s.segment_id, s.speaker, s.text, s.start_s, s.end_s);
  }
}

export function getSegments(meetingId: string): SegmentRow[] {
  return db
    .prepare(
      "SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_s ASC, segment_id ASC",
    )
    .all(meetingId) as unknown as SegmentRow[];
}

export function countSegments(meetingId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?")
    .get(meetingId) as { n: number };
  return row.n;
}

// --- digests -----------------------------------------------------------------

export function saveDigest(row: DigestRow): void {
  db.prepare(
    `INSERT INTO digests (meeting_id, summary, decisions_json, action_items_json,
                          open_questions_json, risks_json, model, input_tokens,
                          output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET
       summary = excluded.summary,
       decisions_json = excluded.decisions_json,
       action_items_json = excluded.action_items_json,
       open_questions_json = excluded.open_questions_json,
       risks_json = excluded.risks_json,
       model = excluded.model,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       created_at = excluded.created_at`,
  ).run(
    row.meeting_id,
    row.summary,
    row.decisions_json,
    row.action_items_json,
    row.open_questions_json,
    row.risks_json,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.created_at,
  );
}

export function getDigest(meetingId: string): DigestRow | undefined {
  return db.prepare("SELECT * FROM digests WHERE meeting_id = ?").get(meetingId) as
    | DigestRow
    | undefined;
}
