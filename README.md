# Sendlegate

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

Email defaults to Resend (`MAILER=resend`). **`onboarding@resend.dev` only
delivers to your own Resend account address** — it is a sandbox, and sending to
anyone else returns 403, so a verified domain is required before guests can be
emailed. Set
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
| Bot never admitted, nothing transcribed | 15 polls (5 min) | Nobody let it in from the lobby |
| Vexa reports `awaiting_admission_rejected` | next poll (~20s) | Someone clicked Deny |
| Demo ceiling reached | per invite (10 min) | A guest's trial run is over |

The demo ceiling is measured **from admission, not from dispatch** — see
`elapsedMs` in `src/poll-decision.ts`. Charging lobby time to a ten-minute trial
means a first-timer hunting for the Admit button gets a bot that leaves almost
as soon as it arrives. The owner's own meetings keep the three-hour ceiling from
`config.poll.maxDurationMs`, where the distinction is noise.

The `awaiting_admission_rejected` row is a shortcut, not a separate timer. Admission fails in two ways
that read very differently — nobody got round to it, versus somebody looked and
said no — and Vexa records the second within seconds. Reading it turns a
five-minute silence into a 20-second answer with the right explanation. The
match is an allowlist of known reasons, so an unrecognised value simply falls
back to the 5-minute timeout.

The stall threshold is a trade-off: any silence longer than it ends the meeting
early. Two minutes suits conversational calls; raise `POLL_STALE_THRESHOLD` if a
meeting might go quiet for a demo or a long read. It only applies once something
has actually been transcribed, so a silent-but-admitted bot is handled by the
admission timeout instead.

That logic is pure and tested — see `src/poll-decision.ts` and
`test/poll-decision.test.ts`.

## Letting someone else try it

The app is single-tenant by default — `APP_SECRET` is the owner's login and the
owner sees everything. Guests come in on **invite links** instead, minted at
`/admin/invites`:

```
https://sendlegate.online/try/4K2P9WXM
```

The link *is* the login: possession of the token is the authorisation, so there
is no account, no password and no signup. It carries one meeting and a ten-minute
ceiling by default, and the label typed when minting is what the digest
attributes that guest's action items to.

The token is Crockford base32 (no `I`, `L`, `O` or `U`) because links get
truncated in chat previews and read aloud off screens — the same value has to
survive being typed, so `/` takes a code as well as the link.

Every read that a URL can reach takes a `Scope`, so a guest sees only the
meetings their own token created and never the owner's. That is a compile-time
property, not a convention: the parameter is required, so a missed call site is
a type error rather than a leaked transcript.

Revoking an invite expires it rather than deleting it — the label is what past
digests attribute to, so closing the door shouldn't rewrite the history behind
it. A guest keeps access to the meeting they already ran.

### Voice command: "<bot name>, leave the meeting"

Say the bot's name followed by a departure instruction and it leaves, then
digests what it captured. The bot cannot hear — this reads the transcript on
each poll — so there are two consequences worth setting expectations around:

- **It is not instant.** One poll interval plus transcription lag: roughly
  20–40s. People will repeat themselves. Lower `POLL_INTERVAL_MS` if that
  matters more than API calls.
- **It depends on speech-to-text getting the name close.** Proper nouns are
  what ASR mangles worst, which is why the nameless phrases below exist.

**The name is not configured anywhere — it is derived from the name the bot
joined under** (`namesFromBotName`). The participant list is the only clue
anyone in the room has, so what it says there is what they will say out loud;
deriving from it means the trigger can never drift from what people can see.

Two rules keep that safe. Words describing the job — *notetaker*, *bot*,
*assistant* — are not names and are dropped. And **the requester's own name is
excluded**: the default bot name is `<requester>'s notetaker`, so without that
exclusion the bot would listen for a person sitting in the meeting, and "Marcus,
you can go" said to Marcus would end the recording. If nothing distinctive
survives, the meeting simply has no spoken name and relies on the phrases below.

Matching requires a name *and* a command phrase, with the command starting
within 60 characters after the name. Both halves are needed so that "Marcus had
to leave the meeting early" doesn't end the call. Recognised commands: `leave
the meeting/call/room`, `exit the meeting/call`, `you can leave/go`, `please
leave`, `stop recording/transcribing`, `drop off`.

#### Why two phrases also work without a name

Requiring a name is the right default and it is also what made the command miss
in the first real meeting it was used in — a conference room, one microphone,
several people. From that transcript:

```
07:55  can you leave the meeting        ← the actual instruction: no name in it
08:25  Let's see if Nathan leaves        ← "Nishan" heard as "Nathan"
08:37  Stop recording. Stop recording.   ← plainly aimed at the bot
09:01  So he stays in the meeting        ← the room noticing it hadn't worked
```

Three misses, three different causes. The bot ended up leaving on the 2-minute
stale timeout, three minutes after the last word.

So `LEAVE_COMMAND_NAMELESS=true` (the default) lets a very short list fire with
no name: **`stop recording`** and **`stop transcribing`**. The bar for that list
is *a phrase nobody says to another person in a meeting* — which is why "leave
the meeting" is not on it and never will be. A preceding negation ("don't stop
recording") is ignored.

Widening the 60-character window was the obvious alternative and it is wrong:
on this transcript it does produce a match, by stitching "nathan" to a "stop
recording" said 100 characters later by someone else. The test in
`test/leave-command.test.ts` pins that transcript so the tradeoff stays visible.

Set `LEAVE_COMMAND_ENABLED=false` to turn the whole thing off, or
`LEAVE_COMMAND_NAMELESS=false` for name-only matching. When it fires, the reason is
recorded and shown on the meeting page so an unexpected ending is explainable.

**Known limitation:** "should we ask Ghost to leave the meeting?" will trigger
it. Distinguishing a question from an instruction in unpunctuated ASR output is
not reliably solvable, and the cost is low — the digest is still produced from
everything captured up to that point, and Vexa keeps the transcript, so
**Fetch transcript & retry** recovers anything said afterwards.

#### Chat commands are not possible

The obvious fix for bad ASR is to type the command into the meeting chat
instead. Vexa cannot do this on Google Meet. Its bot has a chat-capture module
for Jitsi, Teams and Zoom, and none for Meet, so `GET /bots/google_meet/{id}/chat`
returns `{"messages":[]}` no matter what anyone types. `POST` to the same path
(sending chat) is declared in Vexa's API contract but explicitly waived as
unimplemented, and the live cloud answers `405 allow: GET`. Setting a bot avatar
is unimplemented in the same way. Revisit if Vexa ships the voice/media-agent
handler ([issue #591](https://github.com/Vexa-ai/vexa/issues/591)).

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
persistent volume.

**Don't use `fly launch`.** It regenerates `fly.toml` from its own template and
overwrites `auto_stop_machines = false`. Fly sleeps machines when web traffic
goes quiet, which here means the poller stops and the meeting is lost — the one
failure this app cannot tolerate. Create the app explicitly instead:

```bash
fly apps create <name> --org personal
fly volumes create sendlegate_data --size 1 --region fra --yes
fly secrets set VEXA_BOT_API_KEY=… VEXA_TX_API_KEY=… ANTHROPIC_API_KEY=… \
                RESEND_API_KEY=… APP_SECRET=… NOTIFY_EMAIL=…
fly deploy --ha=false
```

Everything non-secret lives in `fly.toml` under `[env]` — base URL, bot name,
thresholds, leave-command names — so it is version-controlled and reviewable.
Only the six credentials go to the secret store. `--ha=false` keeps it to one
machine; two would mean two pollers racing on the same Vexa account.

Confirm it came up correctly:

```bash
fly logs --app <name> --no-tail | grep -E "\[web\]|\[vexa\]"
# [web] Sendlegate listening on https://<name>.fly.dev
# [vexa] both keys OK (bot + transcription)
```

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
