# Sendlegate — Plan

Paste a Google Meet URL → a Vexa bot joins, transcribes, and when the meeting ends you get an
emailed digest with the decisions and *your* action items. No bot speech, no calendar access.

## Decisions locked in

| Question | Answer |
|---|---|
| Vexa access | Hosted API key (`X-API-Key: vx_sk_…`) |
| Dispatch | Immediately on submit — no scheduler |
| Delivery | Email (Resend), plus an in-app page as the baseline UI |
| Summarizer | Anthropic Claude API (`claude-opus-5`) |

## Assumptions I'm making (say the word to change any)

1. **Single user, single tenant.** It's your app. But it *will* be internet-reachable (see #2), so
   it gets a shared-secret login — otherwise anyone who finds the URL can burn your Vexa minutes.
2. **Deployed, not laptop-local.** "Email me the digest" implies you're away. The poller has to
   survive a closed lid, so this runs as one always-on Node process (Fly.io / Railway, ~$5/mo) with
   a persistent volume for SQLite. Local dev is the identical command.
3. **Your identity is a setting.** Action items are attributed to whoever is named in the transcript.
   You're not in the room, so "my action items" = things assigned to your name in absentia. First run
   asks for your display name + aliases (e.g. "Thilina", "Nish", "TP") and your email.
4. **Email via Resend** (`RESEND_API_KEY`), with a plain SMTP fallback behind the same interface.

---

## Architecture

One Node 26 + TypeScript process. Fastify serves both the API and three server-rendered pages
(no build step, one hand-written CSS file). SQLite via `better-sqlite3`. An in-process poller loop
owns all live meetings; all state lives in SQLite so a restart resumes cleanly.

```
browser ──POST /meetings──▶ Fastify ──POST /bots──▶ Vexa
                              │                       │
                          SQLite                 (bot joins Meet)
                              │                       │
                          poller ◀──GET /transcripts/…┘
                              │
                     meeting ends → Claude → digest → Resend → your inbox
```

### Vexa API surface used

Verified against [docs.vexa.ai](https://docs.vexa.ai/api/meetings.md):

| Call | Purpose |
|---|---|
| `POST /bots` `{platform:"google_meet", native_meeting_id, bot_name, language, transcribe_enabled:true, recording_enabled:false}` | Send the bot |
| `GET /transcripts/google_meet/{id}` | Poll segments (`speaker`, `text`, `start`, `end`, `completed`) |
| `GET /bots/status` | `running_bots` — primary end-of-meeting signal |
| `GET /meetings/{id}` | Cross-check `status` → `completed` / `failed`, read `service_provenance` |
| `DELETE /bots/google_meet/{id}` | Manual "end now" button |

`native_meeting_id` is parsed from the URL: `/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i`.
Error mapping: `409` → "a bot is already in that meeting", `429` → "concurrency limit reached, try again".

### Data model

```sql
meetings(id, meet_url, native_meeting_id, title, status, error,
         created_at, dispatched_at, ended_at, bot_outcome)
-- status: dispatched | joining | live | ending | transcribing | done | failed
segments(meeting_id, segment_id, speaker, text, start, end, completed)  -- upsert by segment_id
digests(meeting_id, summary_md, decisions_json, action_items_json,
        open_questions_json, model, input_tokens, output_tokens, created_at)
settings(key, value)  -- display_name, aliases, notify_email
```

### End-of-meeting detection (the part that's actually fiddly)

Belt *and* braces, because a false "ended" produces a digest of half a meeting:

1. Poll every 20s per live meeting.
2. Consider it over when the bot leaves `running_bots` **and** two consecutive polls add no new
   `completed:true` segments.
3. Confirm against `GET /meetings/{id}.status ∈ {completed, failed}` when available.
4. Hard cap at 3h, plus a manual **End now** button (`DELETE /bots/...`).
5. `bot_outcome: "never_admitted"` → skip the digest, email *"the bot was never let into the meeting"*.
   This is the most likely real-world failure: **Google Meet puts unknown participants in a lobby, and
   someone in the room has to admit the bot.** Worth knowing before you rely on it for a meeting that
   matters.

### Digest generation

One Claude call per meeting, on the merged transcript (consecutive same-speaker segments joined,
`completed:false` drafts dropped).

- Model `claude-opus-5`; adaptive thinking is on by default; `max_tokens: 16000` (non-streaming is
  safe at that size, and the cap covers thinking + output).
- Structured output via `client.messages.parse()` + `zodOutputFormat(DigestSchema)` — the schema is
  enforced server-side, so no JSON repair code.
- Schema: `summary`, `decisions[{decision, rationale, owner, evidence_quote}]`,
  `action_items[{owner, task, due, is_mine, evidence_quote}]`, `open_questions[]`, `risks[]`.
- `is_mine` is set by the model from your name + aliases, then re-checked locally by string match —
  a missed action item of yours is the expensive failure mode, so I'd rather over-flag.
- Every decision and action item carries an `evidence_quote` so you can jump to it in the transcript
  instead of trusting the summary.
- Token math: a 60-min meeting is roughly 10k words ≈ 15–20k tokens. Nowhere near the 1M window,
  and a few cents per digest.
- Check `stop_reason === "refusal"` before reading content (Opus 5 can decline); on failure the
  meeting stays retryable — a **Retry digest** button re-runs it without re-recording anything.

### Email

Subject: `Digest: <title> — 3 decisions, 2 for you`. Body leads with **your** action items, then
decisions, then everything else, then a link to the full transcript in the app. HTML + plaintext.

### UI

- `/` — paste box, plus a list of meetings with status chips (live / transcribing / done / failed).
- `/m/:id` — digest at the top (your items first), collapsible full transcript with speaker labels
  and timestamps, **Retry digest** / **End now** / **Delete**.
- `/settings` — your name, aliases, notify email.

---

## Milestones

| # | Deliverable |
|---|---|
| M0 | Scaffold: Fastify + SQLite + config, `.env.example`, shared-secret auth |
| M1 | Paste URL → dispatch bot → persist → meetings list renders |
| M2 | Poller: segment upsert, end detection, transcript view, End now |
| M3 | Claude digest with structured output + retry path |
| M4 | Resend email on completion (incl. the `never_admitted` notice) |
| M5 | Hardening: resume-on-boot, retries/backoff, deploy config |

M0–M4 is one focused build; M5 is a short follow-up. I can start at M0 and go straight through.

## Config

```
VEXA_API_KEY=vx_sk_…
VEXA_BASE_URL=https://api.vexa.ai
ANTHROPIC_API_KEY=sk-ant-…
RESEND_API_KEY=re_…
NOTIFY_EMAIL=thilina.pitiwala@bettermile.com
APP_SECRET=…            # shared-secret login
DATABASE_PATH=./data/sendlegate.db
```

## Two things worth flagging before we build

- **The bot needs to be admitted.** Nothing in the app can work around a lobby. Name it clearly
  (`"Nish's Notetaker"`) so whoever's hosting knows what they're waving through, and expect the
  occasional meeting where nobody does.
- **Everyone in the room is being transcribed by a bot you sent.** A recognisable bot name is the
  courtesy here; some orgs also require an explicit heads-up. Your call, but worth a thought.
