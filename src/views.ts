import type { MeetingRow, DigestRow, SegmentRow, Identity } from "./db.ts";
import type { ActionItem, Decision } from "./digest.ts";
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
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="wrap">
${
  nav
    ? `<header>
  <h1><a href="/">MeetNish</a></h1>
  <nav><a href="/">Meetings</a><a href="/settings">Settings</a><a href="/logout">Log out</a></nav>
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

export function homePage(
  meetings: MeetingRow[],
  error: string,
  notice: string,
  identity: Identity,
): string {
  const setupWarning =
    identity.displayName === ""
      ? `<div class="flash err">No name set yet, so nothing can be flagged as <em>your</em> action item. <a href="/settings">Add it in settings</a>.</div>`
      : "";

  const list =
    meetings.length === 0
      ? `<p class="empty">No meetings yet. Paste a Meet link above when you know you'll miss one.</p>`
      : `<ul class="meetings">${meetings
          .map(
            (m) => `<li><a href="/m/${m.id}">
  <span class="title">${escapeHtml(m.title === "" ? m.native_meeting_id : m.title)}</span>
  <span class="chip ${m.status}">${escapeHtml(STATUS_LABEL[m.status] ?? m.status)}</span>
  <span class="when">${escapeHtml(relative(m.created_at))}</span>
</a></li>`,
          )
          .join("")}</ul>`;

  return layout(
    "MeetNish",
    `${flash(error, notice)}${setupWarning}
<form class="paste" method="post" action="/meetings">
  <input type="text" name="url" placeholder="https://meet.google.com/abc-defg-hij" autofocus required>
  <button type="submit">Send bot</button>
</form>
<p class="hint">The bot joins immediately and waits in the lobby until someone admits it.</p>
<h2>Meetings</h2>
${list}`,
    true,
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
