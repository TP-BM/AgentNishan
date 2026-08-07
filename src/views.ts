import { createHash } from "node:crypto";
import type { MeetingRow, DigestRow, SegmentRow, Identity } from "./db.ts";
import type { ActionItem, Decision } from "./digest.ts";
import { formatInviteToken, inviteUsable, type Invite } from "./invite.ts";
import { formatTimestamp, toTurns, durationSeconds } from "./transcript.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const STYLES = `
:root {
  --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb;
  --card: #f9fafb; --accent: #2563eb; --ok: #047857; --warn: #b45309; --err: #b91c1c;
  --quote: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0f19; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937;
    --card: #111827; --accent: #60a5fa; --ok: #34d399; --warn: #fbbf24; --err: #f87171;
    --quote: #131c2e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 80px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
h1 { font-size: 21px; margin: 0; letter-spacing: -0.01em; }
h1 a { color: inherit; text-decoration: none; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 32px 0 12px; }
a { color: var(--accent); }
nav a { margin-left: 14px; font-size: 14px; }
form.paste { display: flex; gap: 8px; margin-bottom: 8px; }
input[type=text], input[type=password], input[type=email] {
  flex: 1; padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--fg); font-size: 15px; font-family: inherit;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  padding: 11px 18px; border: 0; border-radius: 8px; background: var(--accent);
  color: #fff; font: 600 15px/1 inherit; cursor: pointer;
}
button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); }
button.danger { background: transparent; color: var(--err); border: 1px solid var(--line); }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
.flash { padding: 12px 14px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
.flash.err { background: color-mix(in srgb, var(--err) 12%, transparent); color: var(--err); }
.flash.ok  { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
ul.invites { list-style: none; padding: 0; margin: 0; }
ul.invites li { border-top: 1px solid var(--line); padding: 14px 2px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
ul.invites .who { font-weight: 500; flex: 1; min-width: 120px; }
ul.invites .code { font: 600 15px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
/* Deliberately not an <input>: the mobile rule below forces inputs to 16px to
   stop iOS zooming on focus, which overflows a link this long and shows it
   truncated. A div wraps instead, and tapping still selects the whole thing. */
.link {
  flex-basis: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--card); color: var(--muted); cursor: pointer;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere;
}
ul.meetings { list-style: none; padding: 0; margin: 0; }
ul.meetings li { border-top: 1px solid var(--line); }
ul.meetings a { display: flex; align-items: center; gap: 12px; padding: 14px 2px; text-decoration: none; color: inherit; }
ul.meetings a:hover { background: var(--card); }
.title { flex: 1; font-weight: 500; }
.when { color: var(--muted); font-size: 13px; white-space: nowrap; }
.chip { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.chip.live { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
.chip.dispatched, .chip.transcribing { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
.chip.done { background: var(--card); color: var(--muted); }
.chip.failed { background: color-mix(in srgb, var(--err) 15%, transparent); color: var(--err); }
.summary { font-size: 16px; margin: 0 0 4px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.card .task { font-weight: 600; }
.card .meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
blockquote {
  margin: 8px 0 0; padding: 8px 12px; border-left: 3px solid var(--line);
  background: var(--quote); border-radius: 0 6px 6px 0; color: var(--muted);
  font-size: 13.5px; font-style: italic;
}
.empty { color: var(--muted); font-style: italic; }
ul.plain { margin: 0; padding-left: 20px; }
ul.plain li { margin-bottom: 7px; }
details.transcript { margin-top: 36px; border-top: 1px solid var(--line); padding-top: 20px; }
details.transcript summary { cursor: pointer; color: var(--muted); font-size: 14px; }
.turn { margin: 14px 0; }
.turn .who { font-weight: 600; font-size: 14px; }
.turn .ts { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; margin-left: 6px; }
.turn p { margin: 2px 0 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
.actions form { margin: 0; }
label { display: block; font-weight: 600; font-size: 14px; margin: 18px 0 6px; }
label + .hint { margin: -2px 0 0; }
.login { max-width: 360px; margin: 12vh auto; }
textarea {
  width: 100%; padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--fg); resize: vertical; min-height: 72px;
  /* Separate properties, not the font shorthand: inherit is not a valid family
     inside it, so the whole declaration is dropped and a textarea falls back to
     the UA default, which is monospace. */
  font-family: inherit; font-size: 15px; line-height: 1.5;
}
textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.optional { font-weight: 400; color: var(--muted); text-transform: none; letter-spacing: 0; }
.two-up { display: flex; gap: 12px; }
.two-up > * { flex: 1; min-width: 0; }
/* The shared input rule uses flex:1, which sizes correctly inside form.paste
   and does nothing at all in a stacked form — leaving default-width boxes. */
form.demo input, form.demo textarea { width: 100%; }
form.demo button { width: 100%; margin-top: 24px; padding: 13px; font-size: 16px; }
.closed { max-width: 420px; margin: 12vh auto; text-align: center; }
.pitch { max-width: 560px; margin: 8vh auto 0; }
.pitch h1 { font-size: 30px; letter-spacing: -0.02em; margin-bottom: 10px; }
.pitch .lede { font-size: 17px; color: var(--muted); margin: 0 0 30px; }
.pitch form { display: flex; gap: 8px; }
.pitch input { text-transform: uppercase; letter-spacing: .08em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sample { border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 14px; }
.sample .tag {
  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted); border: 1px solid var(--line);
  border-radius: 999px; padding: 3px 9px; margin-bottom: 14px;
}
.steps { list-style: none; padding: 0; margin: 0 0 30px; counter-reset: step; }
.steps li { position: relative; padding-left: 30px; margin-bottom: 10px; color: var(--muted); }
.steps li::before {
  counter-increment: step; content: counter(step);
  position: absolute; left: 0; top: 1px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--card); border: 1px solid var(--line); color: var(--fg);
  font-size: 11px; font-weight: 700; display: grid; place-items: center;
}
/* Pulse next to a live status line, so an auto-refreshing page reads as alive. */
.live-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; margin-left: 9px; vertical-align: middle;
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
.end-reason { font-size: 13px; color: var(--muted); }
@media (prefers-reduced-motion: reduce) { .live-dot { animation: none; opacity: .6 } }

/* Long meeting titles, URLs and quotes must never push the page sideways. */
h1, .title, .summary, blockquote, .card .task, .turn p { overflow-wrap: anywhere; }

@media (max-width: 640px) {
  .wrap { padding: 20px 16px 64px; }

  /* Two fields side by side is already tight at 375px once labels wrap. */
  .two-up { flex-direction: column; gap: 0; }
  textarea { font-size: 16px; }

  /* Stack the title above the nav; three links don't fit beside it. */
  header { flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 20px; }
  nav { margin-left: -2px; }
  nav a { margin: 0 16px 0 0; }

  /* Full-width input above a full-width button — side by side leaves the input
     too narrow to read a pasted Meet URL. */
  form.paste { flex-direction: column; }
  form.paste button { width: 100%; }

  /* 16px stops iOS Safari zooming the page when a field is focused. */
  input[type=text], input[type=password], input[type=email] { font-size: 16px; }

  /* Meeting title on its own line, status and time beneath it. */
  ul.meetings a { flex-wrap: wrap; gap: 6px 10px; padding: 13px 2px; }
  .title { flex-basis: 100%; }

  h1 { font-size: 19px; }
  .actions form, .actions button { width: 100%; }
}
`;

/**
 * Cache-buster for the stylesheet, derived from the stylesheet itself.
 *
 * /styles.css is served with a long max-age, which is right — it barely
 * changes. But without this, a CSS change ships and every browser that has
 * already seen the old sheet keeps it for an hour, so a deploy appears to have
 * rendered the app broken. Hashing the content means the URL changes exactly
 * when the content does, and never otherwise.
 */
export const STYLES_VERSION = createHash("sha256")
  .update(STYLES)
  .digest("hex")
  .slice(0, 8);

export function layout(
  title: string,
  body: string,
  nav = true,
  /** Seconds between auto-refreshes; omit for a static page. */
  refreshSeconds?: number,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${refreshSeconds}">`}
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css?v=${STYLES_VERSION}">
</head>
<body>
<div class="wrap">
${
  nav
    ? `<header>
  <h1><a href="/">MeetNish</a></h1>
  <nav><a href="/">Meetings</a><a href="/admin/invites">Invites</a><a href="/settings">Settings</a><a href="/logout">Log out</a></nav>
</header>`
    : ""
}
${body}
</div>
</body>
</html>`;
}

function flash(error: string, notice: string): string {
  if (error !== "") return `<div class="flash err">${escapeHtml(error)}</div>`;
  if (notice !== "") return `<div class="flash ok">${escapeHtml(notice)}</div>`;
  return "";
}

function relative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

const STATUS_LABEL: Record<string, string> = {
  dispatched: "waiting for bot",
  live: "live",
  transcribing: "summarising",
  done: "done",
  failed: "failed",
};

export function loginPage(error: string): string {
  return layout(
    "Log in — MeetNish",
    `<div class="login">
<h1 style="margin-bottom:20px">MeetNish</h1>
${flash(error, "")}
<form method="post" action="/login">
  <input type="password" name="secret" placeholder="Shared secret" autofocus required>
  <button type="submit" style="width:100%;margin-top:10px">Log in</button>
</form>
</div>`,
    false,
  );
}

export interface HomeOptions {
  /** Owner only. A guest's bot is sent by the invite flow, which counts it. */
  canDispatch: boolean;
  /** A guest whose invite still has a run left, so they can start another. */
  resumeToken: string | null;
}

export function homePage(
  meetings: MeetingRow[],
  error: string,
  notice: string,
  identity: Identity,
  options: HomeOptions = { canDispatch: true, resumeToken: null },
): string {
  const setupWarning =
    options.canDispatch && identity.displayName === ""
      ? `<div class="flash err">No name set yet, so nothing can be flagged as <em>your</em> action item. <a href="/settings">Add it in settings</a>.</div>`
      : "";

  const list =
    meetings.length === 0
      ? options.canDispatch
        ? `<p class="empty">No meetings yet. Paste a Meet link above when you know you'll miss one.</p>`
        : `<p class="empty">Nothing here yet.</p>`
      : `<ul class="meetings">${meetings
          .map(
            (m) => `<li><a href="/m/${m.id}">
  <span class="title">${escapeHtml(m.title === "" ? m.native_meeting_id : m.title)}</span>
  <span class="chip ${m.status}">${escapeHtml(STATUS_LABEL[m.status] ?? m.status)}</span>
  <span class="when">${escapeHtml(relative(m.created_at))}</span>
</a></li>`,
          )
          .join("")}</ul>`;

  const dispatch = options.canDispatch
    ? `<form class="paste" method="post" action="/meetings">
  <input type="text" name="url" placeholder="https://meet.google.com/abc-defg-hij" autofocus required>
  <button type="submit">Send bot</button>
</form>
<p class="hint">The bot joins immediately and waits in the lobby until someone admits it.</p>`
    : options.resumeToken !== null
      ? `<p class="hint"><a href="/try/${encodeURIComponent(options.resumeToken)}">Send another notetaker →</a></p>`
      : "";

  return layout(
    "MeetNish",
    `${flash(error, notice)}${setupWarning}
${dispatch}
<h2>Meetings</h2>
${list}`,
    options.canDispatch,
    meetings.some((m) => m.status !== "done" && m.status !== "failed") ? 15 : undefined,
  );
}

function decisionCard(decision: Decision): string {
  return `<div class="card">
  <div class="task">${escapeHtml(decision.decision)}</div>
  ${
    decision.owner === "" && decision.rationale === ""
      ? ""
      : `<div class="meta">${[
          decision.owner === "" ? "" : escapeHtml(decision.owner),
          decision.rationale === "" ? "" : escapeHtml(decision.rationale),
        ]
          .filter(Boolean)
          .join(" · ")}</div>`
  }
  ${decision.evidence_quote === "" ? "" : `<blockquote>${escapeHtml(decision.evidence_quote)}</blockquote>`}
</div>`;
}

function actionCard(item: ActionItem, showOwner: boolean): string {
  const meta = [
    showOwner && item.owner !== "" ? escapeHtml(item.owner) : "",
    item.due === "" ? "" : `due ${escapeHtml(item.due)}`,
  ].filter(Boolean);

  return `<div class="card">
  <div class="task">${escapeHtml(item.task)}</div>
  ${meta.length === 0 ? "" : `<div class="meta">${meta.join(" · ")}</div>`}
  ${item.evidence_quote === "" ? "" : `<blockquote>${escapeHtml(item.evidence_quote)}</blockquote>`}
</div>`;
}

export function meetingPage(
  meeting: MeetingRow,
  digest: DigestRow | undefined,
  segments: SegmentRow[],
  error: string,
  notice: string,
): string {
  const decisions: Decision[] =
    digest === undefined ? [] : JSON.parse(digest.decisions_json);
  const actions: ActionItem[] =
    digest === undefined ? [] : JSON.parse(digest.action_items_json);
  const questions: string[] =
    digest === undefined ? [] : JSON.parse(digest.open_questions_json);
  const risks: string[] = digest === undefined ? [] : JSON.parse(digest.risks_json);

  const mine = actions.filter((a) => a.is_mine);
  const others = actions.filter((a) => !a.is_mine);

  const statusLine =
    meeting.status === "done"
      ? ""
      : `<div class="flash ${meeting.status === "failed" ? "err" : "ok"}">${escapeHtml(
          meeting.error ??
            (meeting.status === "live"
              ? "Bot is in the meeting and transcribing."
              : meeting.status === "dispatched"
                ? "Bot is waiting in the lobby — someone in the meeting has to admit it."
                : "Meeting ended. Generating the digest…"),
        )}${meeting.error === null && meeting.status !== "failed" ? `<span class="live-dot"></span>` : ""}</div>`;

  const digestBody =
    digest === undefined
      ? ""
      : `<p class="summary">${escapeHtml(digest.summary)}</p>

<h2>Your action items${mine.length > 0 ? ` (${mine.length})` : ""}</h2>
${mine.length === 0 ? `<p class="empty">Nothing was assigned to you.</p>` : mine.map((a) => actionCard(a, false)).join("")}

<h2>Decisions</h2>
${decisions.length === 0 ? `<p class="empty">No decisions were recorded.</p>` : decisions.map(decisionCard).join("")}

${others.length === 0 ? "" : `<h2>Other action items</h2>${others.map((a) => actionCard(a, true)).join("")}`}

${
  questions.length === 0
    ? ""
    : `<h2>Open questions</h2><ul class="plain">${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`
}

${
  risks.length === 0
    ? ""
    : `<h2>Risks raised</h2><ul class="plain">${risks.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
}`;

  const turns = toTurns(segments);
  const transcript =
    turns.length === 0
      ? `<p class="empty">No transcript captured.</p>`
      : `<details class="transcript">
<summary>Full transcript — ${turns.length} turns, ${formatTimestamp(durationSeconds(segments))}</summary>
${turns
  .map(
    (t) => `<div class="turn">
  <span class="who">${escapeHtml(t.speaker)}</span><span class="ts">${escapeHtml(formatTimestamp(t.start_s))}</span>
  <p>${escapeHtml(t.text)}</p>
</div>`,
  )
  .join("")}
</details>`;

  const isActive = meeting.status === "dispatched" || meeting.status === "live";
  // Offered even with no local transcript: Vexa keeps its copy, so a re-pull can
  // still rescue the meeting.
  const canRetry = !isActive && meeting.status !== "transcribing";
  const retryLabel =
    segments.length === 0
      ? "Fetch transcript &amp; retry"
      : digest === undefined
        ? "Generate digest"
        : "Regenerate digest";

  // Refresh while anything is still moving, so admission and the finished
  // digest appear without the reader having to reload by hand.
  const refresh = meeting.status === "transcribing" ? 8 : isActive ? 15 : undefined;

  return layout(
    meeting.title === "" ? "Meeting" : meeting.title,
    `${flash(error, notice)}
<h1 style="margin-bottom:6px">${escapeHtml(meeting.title === "" ? meeting.native_meeting_id : meeting.title)}</h1>
<p class="hint"><a href="${escapeHtml(meeting.meet_url)}">${escapeHtml(meeting.native_meeting_id)}</a> · ${escapeHtml(relative(meeting.created_at))}${
      digest === undefined ? "" : ` · digest by ${escapeHtml(digest.model)}`
    }${
      meeting.end_reason === null || isActive
        ? ""
        : `<br><span class="end-reason">Ended: ${escapeHtml(meeting.end_reason)}</span>`
    }</p>
${statusLine}
${digestBody}
${transcript}
<div class="actions">
  ${isActive ? `<form method="post" action="/m/${meeting.id}/end"><button class="ghost" type="submit">End now</button></form>` : ""}
  ${canRetry ? `<form method="post" action="/m/${meeting.id}/retry"><button class="ghost" type="submit">${retryLabel}</button></form>` : ""}
  <form method="post" action="/m/${meeting.id}/delete" onsubmit="return confirm('Delete this meeting and its transcript?')"><button class="danger" type="submit">Delete</button></form>
</div>`,
    true,
    refresh,
  );
}

export function settingsPage(
  identity: Identity,
  error: string,
  notice: string,
): string {
  return layout(
    "Settings — MeetNish",
    `${flash(error, notice)}
<h1 style="margin-bottom:20px">Settings</h1>
<form method="post" action="/settings">
  <label for="display_name">Your name</label>
  <p class="hint">As people say it in meetings. Used to flag which action items are yours.</p>
  <input type="text" id="display_name" name="display_name" value="${escapeHtml(identity.displayName)}" placeholder="Thilina">

  <label for="aliases">Also called</label>
  <p class="hint">Comma-separated nicknames, so "Nish will handle it" still gets flagged.</p>
  <input type="text" id="aliases" name="aliases" value="${escapeHtml(identity.aliases.join(", "))}" placeholder="Nish, TP">

  <label for="notify_email">Send digests to</label>
  <input type="email" id="notify_email" name="notify_email" value="${escapeHtml(identity.email)}" placeholder="you@example.com">

  <button type="submit" style="margin-top:24px">Save</button>
</form>`,
  );
}

/**
 * The owner's invite desk: mint a link, see who has one, close it again.
 *
 * The link field is the point of the page — it is read-only and full-width so
 * it can be selected and pasted into a chat without hunting. The grouped code
 * is shown next to it for the case where someone reads it out instead.
 */
export function invitesPage(
  invites: Invite[],
  baseUrl: string,
  error: string,
  notice: string,
): string {
  const now = Date.now();

  const row = (invite: Invite): string => {
    const verdict = inviteUsable(invite, now);
    const spent = invite.meetings_used >= invite.max_meetings;
    const chip = verdict.usable
      ? `<span class="chip live">open</span>`
      : `<span class="chip ${spent ? "done" : "failed"}">${spent ? "used" : "revoked"}</span>`;
    const link = `${baseUrl}/try/${invite.token}`;
    const minutes = Math.round(invite.max_duration_ms / 60000);

    return `<li>
  <span class="who">${escapeHtml(invite.label)}</span>
  <span class="code">${escapeHtml(formatInviteToken(invite.token))}</span>
  ${chip}
  <span class="when">${escapeHtml(`${minutes} min · ${relative(invite.created_at)}`)}</span>
  ${
    verdict.usable
      ? `<form method="post" action="/admin/invites/${encodeURIComponent(invite.token)}/revoke">
  <button type="submit" class="danger">Revoke</button>
</form>`
      : ""
  }
  ${
    verdict.usable
      ? `<div class="link" title="Tap to select" onclick="const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r)">${escapeHtml(link)}</div>`
      : ""
  }
</li>`;
  };

  const list =
    invites.length === 0
      ? `<p class="empty">No invites yet. Create one above and send the link.</p>`
      : `<ul class="invites">${invites.map(row).join("")}</ul>`;

  return layout(
    "Invites — MeetNish",
    `${flash(error, notice)}
<form class="paste" method="post" action="/admin/invites">
  <input type="text" name="label" placeholder="Who is it for? e.g. Marcus" autofocus required>
  <button type="submit">Create invite</button>
</form>
<p class="hint">One meeting each, ten minutes, no expiry until you revoke it. The name is
what the digest attributes their action items to, so use the one they go by in meetings.</p>
<h2>Invites</h2>
${list}`,
  );
}

/**
 * The demo form a friend lands on. Their invite is already established by the
 * time this renders — the link was the login — so it asks only what the run
 * itself needs, and not who they are: the invite label already says that.
 */
export function tryPage(invite: Invite, error: string, notice: string): string {
  const minutes = Math.round(invite.max_duration_ms / 60000);

  return layout(
    "Send your notetaker — MeetNish",
    `<div class="login" style="max-width:520px">
<h1 style="margin-bottom:6px">Send your notetaker</h1>
<p class="hint" style="margin-bottom:24px">Hello ${escapeHtml(invite.label)} — it joins the meeting,
listens for up to ${minutes} minutes, then emails you the decisions and your action items.</p>
${flash(error, notice)}
<form class="demo" method="post" action="/try/${encodeURIComponent(invite.token)}">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" placeholder="you@example.com" required>
  <p class="hint" style="margin-top:4px">Where the digest goes. Nothing else is sent here.</p>

  <label for="url">Meeting link</label>
  <input id="url" type="text" name="url" placeholder="https://meet.google.com/abc-defg-hij" required>
  <p class="hint" style="margin-top:4px">Google Meet only for now.</p>

  <div class="two-up">
    <div>
      <label for="title">Meeting name <span class="optional">(optional)</span></label>
      <input id="title" type="text" name="title" placeholder="e.g. Q1 planning">
    </div>
    <div>
      <label for="bot_name">Bot name</label>
      <input id="bot_name" type="text" name="bot_name"
             value="${escapeHtml(`${invite.label}'s notetaker`)}" maxlength="60" required>
    </div>
  </div>
  <p class="hint" style="margin-top:4px">Everyone in the meeting sees the bot name in the
  participant list — that is how it announces itself, so keep it recognisable.</p>

  <label for="objective">What should it focus on? <span class="optional">(optional)</span></label>
  <textarea id="objective" name="objective" maxlength="500"
            placeholder="e.g. pricing details, action items, technical requirements…"></textarea>

  <button type="submit">Send the notetaker</button>
</form>
<p class="hint" style="margin-top:20px">Someone already in the meeting has to admit it from the
lobby — it cannot let itself in. Anyone can say <em>&ldquo;stop recording&rdquo;</em> to send it away.</p>
</div>`,
    false,
  );
}

/** An invite that has been spent, revoked or never existed. All look alike. */
export function inviteClosedPage(reason: string): string {
  return layout(
    "Invite closed — MeetNish",
    `<div class="closed">
<h1 style="margin-bottom:12px">MeetNish</h1>
<p>${escapeHtml(reason)}</p>
</div>`,
    false,
  );
}

/**
 * What a stranger sees at the root.
 *
 * There is no signup, so the page has one job beyond explaining itself: take a
 * code. The link is the usual way in, and the field is the fallback for every
 * way a link fails to survive the trip — truncated in a chat preview, wrapped
 * in an email, read aloud off someone's screen.
 *
 * The sample digest is the pitch. Describing the output convinces nobody;
 * showing it costs one synthetic example and no invite.
 */
export function landingPage(error: string): string {
  const sample: Decision = {
    decision: "Ship the CSV importer behind a flag for the March release",
    rationale: "The parser is done but the error reporting isn't, and support can't triage it yet",
    owner: "Priya",
    evidence_quote: "let's put it behind a flag and turn it on for the pilot accounts first",
  };
  const mine: ActionItem = {
    owner: "Marcus",
    task: "Write the migration note for existing importer users",
    due: "before the release cut",
    is_mine: true,
    evidence_quote: "marcus can you take the migration note, before we cut the release",
  };

  return layout(
    "MeetNish — a notetaker for the meetings you miss",
    `<div class="pitch">
<h1>Send a notetaker to the meeting you're missing</h1>
<p class="lede">It joins, listens, and emails you what was decided and what landed on
your plate — with a quote from the transcript for every line, so you can check it.</p>

${flash(error, "")}

<ol class="steps">
  <li>Paste the meeting link and your email.</li>
  <li>Someone in the meeting admits the bot from the lobby.</li>
  <li>The digest arrives when the meeting ends.</li>
</ol>

<h2>Have an invite code?</h2>
<form method="post" action="/code">
  <input type="text" name="code" placeholder="4K2P-9WXM" maxlength="12" autocomplete="off"
         spellcheck="false" autofocus required aria-label="Invite code">
  <button type="submit">Go</button>
</form>
<p class="hint" style="margin-top:8px">MeetNish is invite-only while it's being tried out.
Ask Thilina for a code.</p>

<h2>What you get</h2>
<div class="sample">
  <span class="tag">Example</span>
  <p class="summary">The team agreed to ship the CSV importer behind a feature flag for
  March, and to hold the bulk-edit work until after the release.</p>
  <h2>Decisions</h2>
  ${decisionCard(sample)}
  <h2>Your action items</h2>
  ${actionCard(mine, false)}
</div>
<p class="hint" style="margin-top:24px"><a href="/login">Owner login</a></p>
</div>`,
    false,
  );
}
