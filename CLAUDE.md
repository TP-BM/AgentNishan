# Working on Sendlegate

## Deployment

**Never run `fly deploy` without explicit approval from Thilina, every time.**

Not implied by "fix this bug", "add this feature", or having just made a change
that needs deploying. Finish the work, push it, then ask. A deploy restarts the
machine — if a meeting is live, the poller stops for ~15 seconds mid-call.

### The sequence

```bash
npm run typecheck && npm test     # both must pass
git add -A && git commit && git push origin main
# ── ask, and wait for a clear yes ──
fly deploy --app nishan --ha=false
fly logs --app nishan --no-tail | grep -E "\[web\]|\[vexa\]"
```

Commit and push **before** deploying, never after. `fly deploy` ships the local
working directory, not GitHub — deploying first means production can contain
code that exists nowhere else.

### After every deploy, verify — don't trust the success message

```
[web] Sendlegate listening on https://sendlegate.online
[vexa] both keys OK (bot + transcription)
```

`both keys OK` is the one that matters: it catches a broken or mis-scoped Vexa
credential before a real meeting does.

### Rules that have already cost us

- **The Fly app is still named `nishan`.** That name is internal — it appears
  in `fly deploy --app nishan` and nowhere a user can see. Renaming a Fly app
  means recreating it and losing the volume, so it stays. The product is
  Sendlegate; the deployment target is `nishan`.
- **Never `fly launch`.** It regenerates `fly.toml` and overwrites
  `auto_stop_machines = false`. A sleeping machine stops polling and loses the
  meeting.
- **Always `--ha=false`.** Two machines means two pollers racing on one Vexa
  account, competing on `DELETE /bots`.
- **Non-secret config belongs in `fly.toml` `[env]`**, so it stays
  version-controlled and reviewable. Only credentials go to `fly secrets set`
  (which restarts the machine on its own — no deploy needed).
- **Never print a secret value.** Read them from `.env` into shell variables;
  echo the length or the name, never the value.

## Verifying against Vexa

Vexa's real behaviour has contradicted its docs repeatedly — the API hostname,
one-scope-per-key, bots that never leave when a call ends, four undocumented
lobby statuses, absolute-epoch timestamps. Every one surfaced by calling the
live API, none from reading.

So: check payloads directly with `curl` before designing around an assumption,
and prefer allowlists over denylists for anything Vexa returns as a string, so
an unknown value fails safe rather than silently disabling a timeout.

## Tests

`src/poll-decision.ts` and `src/leave-command.ts` are pure and carry the logic
most likely to be wrong and hardest to debug live. Keep new decision logic in
that shape — pure functions with the I/O in the caller — and add a test for any
real-world payload that surprises us.
