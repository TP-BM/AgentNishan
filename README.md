# MeetNish

Paste a Google Meet link when you know you'll miss a meeting. A Vexa bot joins,
transcribes, and when the meeting ends you get an emailed digest with the
decisions and your action items.

No bot speech. No calendar access. One always-on Node process, SQLite on disk.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the three keys below
npm start
```

Four values are required before it will boot:

| Variable | Where to get it |
|---|---|
| `VEXA_BOT_API_KEY` | Vexa dashboard → Create API Key → **Bot Key** (`vxa_bot_…`) |
| `VEXA_TX_API_KEY` | Vexa dashboard → Create API Key → **Transcription Key** (`vxa_tx_…`) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `APP_SECRET` | Generate one: `openssl rand -base64 32` |

**Vexa needs two keys, not one.** Its cloud dashboard issues a single scope per
key: a Bot Key sends bots into meetings, a Transcription Key reads what they
transcribed. A bot key alone gets `403 Insufficient scope` on every transcript
read — bots join fine and nothing is ever captured. Both keys are validated at
startup so that mismatch surfaces immediately:

```
[vexa] both keys OK (bot + transcription)
```

Then open the app, log in with `APP_SECRET`, and set your name under
**Settings** — without it nothing can be flagged as *your* action item.

Email defaults to Resend (`MAILER=resend`). On the free tier you can send from
`onboarding@resend.dev` to your own account address with no domain setup. Set
`MAILER=smtp` to use Gmail or any SMTP server instead, or `MAILER=none` to skip
email entirely and just read digests in the app.

## How it works

```
paste URL ──▶ POST /bots ──▶ bot waits in the Meet lobby
                                    │ (someone admits it)
                             poll every 20s
                          GET /transcripts/…  ──▶ SQLite
                                    │
                          meeting ends ──▶ Claude ──▶ digest ──▶ email
```

The bot **has to be admitted** by someone already in the meeting. If nobody lets
it in, you get an email saying so rather than silence.

### Detecting the end of a meeting

This is the hard part, because **Vexa does not withdraw its bot when the call
ends**. Once everyone hangs up the bot stays listed as `status: "active"` with
`end_time: null`, apparently indefinitely. Waiting for it to leave means waiting
for the 3-hour ceiling, burning bot credits the whole way.

So three signals, in priority order:

| Signal | Ends the meeting after | Covers |
|---|---|---|
| Transcript stops growing while the bot is still active | 6 polls (2 min) | The normal case — a call that ended |
| Bot disappears from `/bots/status` | 2 polls (~40s) | Bot crashed or was withdrawn |
| Bot never admitted, nothing transcribed | 45 polls (15 min) | Nobody let it in from the lobby |

The stall threshold is a trade-off: any silence longer than it ends the meeting
early. Two minutes suits conversational calls; raise `POLL_STALE_THRESHOLD` if a
meeting might go quiet for a demo or a long read. It only applies once something
has actually been transcribed, so a silent-but-admitted bot is handled by the
admission timeout instead.

That logic is pure and tested — see `src/poll-decision.ts` and
`test/poll-decision.test.ts`.

### Voice command: "Nishan, leave the meeting"

Say the bot's name followed by a departure instruction and it leaves, then
digests what it captured. The bot cannot hear — this reads the transcript on
each poll — so there are two consequences worth setting expectations around:

- **It is not instant.** One poll interval plus transcription lag: roughly
  20–40s. People will repeat themselves. Lower `POLL_INTERVAL_MS` if that
  matters more than API calls.
- **It depends on speech-to-text getting the name close.** "Nishan" routinely
  arrives as "Nissan". `LEAVE_COMMAND_NAMES` is a list of variants for exactly
  this reason — add whatever mishearings you observe in real transcripts.

Matching requires a name *and* a command phrase, with the command starting
within 60 characters after the name. Both halves are needed so that "Marcus had
to leave the meeting early" doesn't end the call. Recognised commands: `leave
the meeting/call/room`, `exit the meeting/call`, `you can leave/go`, `please
leave`, `stop recording/transcribing`, `drop off`.

Set `LEAVE_COMMAND_ENABLED=false`, or leave `LEAVE_COMMAND_NAMES` empty, to
turn it off. When it fires, the reason is recorded and shown on the meeting page
so an unexpected ending is explainable.

**Known limitation:** "should we ask Nishan to leave the meeting?" will trigger
it. Distinguishing a question from an instruction in unpunctuated ASR output is
not reliably solvable, and the cost is low — the digest is still produced from
everything captured up to that point, and Vexa keeps the transcript, so
**Fetch transcript & retry** recovers anything said afterwards.

### Transcript timestamps

Vexa reports `start`/`end` as **absolute epoch seconds** (`1785972327.053`), not
offsets from the start of the meeting. `src/transcript.ts` rebases them onto the
first segment; without that a one-minute meeting renders as `496103:25:32`. The
rebase only triggers on values above a year-2001 epoch floor, so genuine
relative offsets (and the leading silence they encode) pass through untouched.

## Digests

One `claude-opus-5` call per meeting, with the output shape enforced server-side
via structured outputs, so there's no JSON repair code. Every decision and action
item carries a verbatim `evidence_quote` — the digest is checkable against the
transcript rather than something you have to take on faith.

`is_mine` is set by the model from your name and aliases, then re-checked
locally by string match. It errs toward over-flagging: missing one of your action
items is the expensive failure, seeing an extra one is not.

If a digest fails, the transcript is still saved and **Regenerate digest** re-runs
it. If the digest succeeds but the email fails, the digest is still in the app —
email is the notification, not the storage.

## Commands

```bash
npm start        # run
npm run dev      # run with --watch
npm test         # unit tests
npm run typecheck
```

TypeScript runs directly on Node's built-in type stripping — no build step, no
bundler. Storage is `node:sqlite`, so there's no native module to compile.

## Deploying

The poller must survive between meetings, so this needs to run somewhere always
on — not your laptop. `Dockerfile` and `fly.toml` are set up for Fly.io with a
persistent volume:

```bash
fly launch --no-deploy
fly volumes create meetnish_data --size 1
fly secrets set VEXA_API_KEY=… ANTHROPIC_API_KEY=… APP_SECRET=… \
                RESEND_API_KEY=… NOTIFY_EMAIL=… APP_BASE_URL=https://your-app.fly.dev
fly deploy
```

`auto_stop_machines` is off deliberately — a suspended machine stops polling and
you lose the meeting.

## Layout

| File | |
|---|---|
| `src/server.ts` | Routes, auth, lifecycle |
| `src/poller.ts` | Poll loop, finalisation, digest orchestration |
| `src/poll-decision.ts` | "Is the meeting over?" — pure, tested |
| `src/digest.ts` | Claude call + schema |
| `src/vexa.ts` | Vexa API client |
| `src/mailer.ts` | Resend/SMTP adapters, email bodies |
| `src/views.ts` | Server-rendered HTML |
| `src/db.ts` | SQLite schema and queries |

### Lobby vs in-meeting

`/bots/status` entries look like this (confirmed against the live API):

```json
{"running_bots":[{"id":25539,"native_meeting_id":"mgb-piaf-ogn","status":"joining", ...}]}
```

**`status` matters as much as presence.** A bot waiting in the Google Meet lobby
is listed with `status: "joining"` and stays that way indefinitely if nobody
admits it. Treating "listed" as "in the meeting" would defeat the never-admitted
timeout entirely — the meeting would look live until the 3h ceiling. So
`getBotState()` only reports `inMeeting` once the status is past the lobby set
(`joining`, `requested`, `queued`, `starting`).
