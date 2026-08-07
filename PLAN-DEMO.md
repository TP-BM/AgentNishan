# Demo plan — invite links

Let friends try the bot for five minutes each, from a landing page. No accounts,
no billing, no public signup.

Supersedes `PLAN-PUBLIC.md` (billable multi-tenant users), which is deleted —
that plan solved problems demo scale doesn't have.

---

## The shape of it

**The link is the login.** Possession of a URL is the credential, the way an
"anyone with the link" share works. No password to type, no account to create,
no email round-trip.

```
you                          friend
───                          ──────
mint invite ──▶ copy link ──▶ opens /try/8f3kd9x2
                                     │
                             cookie set, scoped to that invite
                                     │
                                     ▼
                             the form
                                     │
                             submit ─▶ bot dispatched; meeting row
                                     │   carries invite_id
                                     ▼
                             /m/<id> — live page, auto-refreshing
                                     │
                             admit bot ──▶ 5 min ──▶ digest + email
```

`APP_SECRET` stays exactly what it is: **your** admin login. It is not shared,
not rotated, and not given to anyone. That was the flaw in the shared-secret
idea — one value doing three jobs (cookie key, session value, password), so
there can only ever be one of it, changing it restarts the machine, and it
revokes everybody at once.

---

## Data model

```sql
CREATE TABLE invites (
  token           TEXT PRIMARY KEY,   -- 8 chars, Crockford base32, stored upper
  label           TEXT NOT NULL,      -- "Marcus" — also the digest display name
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,            -- null = no expiry
  max_meetings    INTEGER NOT NULL DEFAULT 1,
  meetings_used   INTEGER NOT NULL DEFAULT 0,
  max_duration_ms INTEGER NOT NULL DEFAULT 600000   -- 10 minutes
);
```

**The token is typeable on purpose** — see *Two doors* below. Eight characters
of Crockford base32 (no `I`, `L`, `O`, `U`, so nothing is ambiguous read aloud),
stored uppercase, normalized on input.

`meetings` gains `invite_id TEXT` (null = yours) and `admitted_at INTEGER`. Both
go through the existing `ensureColumn()` helper, so the live database migrates
on boot without a dump.

**The label does double duty.** You type your friend's name when you mint the
link; the digest uses it for `is_mine` attribution. So the form doesn't need to
ask who they are — one less field, and it can't be got wrong.

---

## Scoping — the part that must be right

Every read in `src/db.ts` is currently global. `listMeetings()`, `getMeeting()`,
`activeMeetings()`, `interruptedMeetings()` and `getIdentity()` each need an
invite scope: admin passes `null` and sees everything, an invite sees only rows
carrying its own token.

`getMeeting(id)` matters most — it's reached straight from a URL, so unscoped it
hands a stranger's transcript to anyone who guesses an id.

> Make the scope a **required first parameter** on every one of those functions.
> A missed call site then fails `npm run typecheck` instead of leaking a
> transcript. Worth the churn.

The poller is the deliberate exception: `activeMeetings()` inside `tick()`
legitimately sweeps every invite's live meetings. Keep it global there, but
`runDigest` must resolve the *owning* invite's label and email — otherwise every
friend's action items get attributed to you.

---

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /try/:token` | public | Validate token → set signed cookie → render the form |
| `POST /try/:token` | invite | Create meeting with `invite_id`, dispatch bot, redirect to `/m/<id>` |
| `GET /admin/invites` | admin | List invites, mint new ones |
| `POST /admin/invites` | admin | Insert a row, show the link |
| `GET /` | public | Landing page — pitch, sample digest, code field |
| `POST /code` | public | Normalize a typed code → redirect to `/try/:token`. Rate limited |

The existing `onRequest` hook in `src/server.ts` grows one branch: no valid admin
cookie → look for a valid invite cookie → attach the invite to the request.
Everything downstream reads scope from there. `/try/:token` and `/` join
`PUBLIC_PATHS`.

**Rejections need a real page, not a redirect to `/login`.** Expired, spent, or
unknown token → *"This invite has been used. Ask Thilina for another."* A friend
bounced to a password prompt will think it's broken.

### Two doors, one code

A link is the convenient path and a bad single point of failure — they get
truncated in Slack previews, mangled by WhatsApp, screenshotted, read aloud off
someone's screen. So the same value works typed:

```
4K2P-9WXM        →  https://nishan.fly.dev/try/4K2P9WXM
```

`/` carries a *"Have an invite code?"* field that strips the separator,
uppercases, and redirects into `/try/:token`. Grouping is display-only — never
stored, never required on input.

**Guessing isn't the risk** — 32⁸ is about a trillion combinations against maybe
twenty live codes — but rate-limit `POST /code` anyway at ~10 attempts per IP per
hour. An in-memory counter is right at this scale; it resets on deploy and that
is fine.

What a stranger landing on `/` should see: what it does, *"Invite only — ask
Thilina for a code"*, the code field, and **a sample digest built from a
synthetic meeting**. That last one lets a curious visitor understand the product
without spending an invite, and it's the cheapest marketing on the page.

---

## The form

The reference layout, minus what demo scale doesn't need.

| Field | Notes |
|---|---|
| Email | Where the digest goes. The only required field besides the link |
| Meeting link | Google Meet only for now |
| Meeting name *(optional)* | Wins over the digest's generated title |
| Ghost name | Already a per-request `bot_name` on `POST /bots` — one line. Also the disclosure everyone in the room sees, so keep the default self-describing |
| Objective *(optional)* | Threads into the prompt in `src/digest.ts` |
| ~~Join at~~ | Dropped — dispatch stays immediate |

---

## The five-minute clock starts at admission

Not at dispatch. `decide()` currently computes `ageMs` from `meeting.created_at`,
which is when submit was pressed. If a first-timer spends three minutes hunting
for the Admit button, they get two minutes of demo — and the impression is a bot
that leaves immediately.

Fix: set `admitted_at` when `bot_seen` first flips to 1 in `poller.ts`, and
measure `ageMs` from there, falling back to `created_at` when it's still null.
`poll-decision.ts` stays pure — it just receives a different number. Pass the
invite's `max_duration_ms` as `limits.maxDurationMs` instead of the global
`config.poll.maxDurationMs`.

Two existing behaviours already cover the rest and need no change: the
never-admitted timeout (5 min) handles a bot nobody lets in, and the 2-minute
stale detection handles a call that ends early.

The meeting page needs one addition — a prominent **"Now admit the bot from the
Meet lobby"**. Nobody trying this for the first time knows that's on them.

---

## Email

The Resend free tier is enough: **3,000/month, 100/day, 1 verified domain**. No
paid plan needed at this scale — the only spend is a domain, ~€12/year, because
`nishan.fly.dev` can't carry the SPF/DKIM/DMARC records Resend needs.

Not on the critical path, though. The digest already renders at `/m/<id>`, so the
invite link can carry the whole experience while DNS propagates. Ship without
email, add it when the domain is verified.

---

## Cost

A five-minute demo: ~$0.04 Vexa, ~$0.02 Claude. **About six cents.** Twenty
friends is roughly a euro on top of the €5/month the machine already costs.

That is the entire argument for dropping billing.

---

## Before the first link is minted

Your existing meetings are in this database — Bettermile standups, colleagues'
names, verbatim quotes. They agreed to a notetaker in their meeting, not to
being readable by your friends.

**Query scoping has to land before the first invite exists.** Once it does,
those rows carry `invite_id = NULL`, which means admin-only: friends cannot
reach them by construction.

So deleting them is a choice, not the safety mechanism. The order that keeps it
that way: **land the scoping, verify it with a real invite, then delete if you
still want to** — rather than destroying data to compensate for code that hasn't
been tested yet. Vexa holds the transcripts server-side either way, so a delete
here is not the last copy.

---

## Order

1. **Schema + scoping.** Invites table, the two new columns, every query scoped.
   Nothing else can land first, and it's the one that carries risk.
2. **Admin invite page.** Mint, list, revoke.
3. **`/try/:token`** — cookie, form, dispatch.
4. **Admission-based clock** and the per-invite duration cap.
5. **Landing page** at `/`.
6. **Domain + Resend** — start early, it waits on DNS, but nothing blocks on it.

Roughly two days. Steps 1–4 are the product; 5 is presentation; 6 is paperwork.

---

## Unchanged

- **`poll-decision.ts`** — pure, tested, encodes four things Vexa's docs get
  wrong. It gains a caller-supplied duration and nothing else.
- **The leave command** — per-meeting, no shared state, and the documented way
  for anyone in the room to get the bot out.
- **Transcript rebasing and the digest schema.**
- **The deploy discipline in `CLAUDE.md`** — more important now, not less. A
  deploy restarts the machine and stops the poller mid-call, and that's now a
  friend's one shot at the demo.
