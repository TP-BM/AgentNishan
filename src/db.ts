import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";

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

export function getIdentity(): Identity {
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
}): MeetingRow {
  const id = newId();
  db.prepare(
    `INSERT INTO meetings (id, meet_url, native_meeting_id, title, status, created_at)
     VALUES (?, ?, ?, ?, 'dispatched', ?)`,
  ).run(id, input.meetUrl, input.nativeMeetingId, input.title, Date.now());
  return getMeeting(id)!;
}

export function getMeeting(id: string): MeetingRow | undefined {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as
    | MeetingRow
    | undefined;
}

export function listMeetings(): MeetingRow[] {
  return db
    .prepare("SELECT * FROM meetings ORDER BY created_at DESC")
    .all() as unknown as MeetingRow[];
}

/** Meetings the poller still needs to watch. */
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

export function deleteMeeting(id: string): void {
  db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
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
