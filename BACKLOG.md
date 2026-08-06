# Backlog

Things worth doing, not yet done.

## Revisit chat commands and bot avatar when Vexa ships them

**Status: blocked on Vexa, verified 2026-08-06.** Both were asked for; neither
is buildable today. Recording the evidence so it isn't re-derived.

| Want | Route | Live cloud says |
|---|---|---|
| Type "Nishan leave" in Meet chat | `GET /bots/google_meet/{id}/chat` | `200 {"messages":[]}` — always |
| Bot posts an introduction to chat | `POST …/chat` | `405 allow: GET` |
| Bot profile picture | `PUT …/avatar` | `404` — route not registered |

The read side is empty because Vexa's bot has a chat-capture module for Jitsi
(`jitsi-chat.ts`), Teams and Zoom, and **none for Google Meet** — the messages
never leave the call, so no endpoint can return them. The write side is declared
in Vexa's sealed `api.v1` contract but listed in their own `KNOWN_GAPS.json`:
"no bot-command (send-to-meeting) backend in the 0.12 core… Registering a 200
that does nothing would fake the capability." `avatar`, `screen` and `speak` are
waived the same way.

Two more things worth knowing when this is revisited:

- `POST /bots` accepts `voice_agent_enabled` and `default_avatar_url` with a
  `201` and **silently drops both** — confirmed with `dry_run: true`, neither
  appears in the stored `data`. An accepted-but-ignored field is worse than a
  422, so don't trust acceptance as evidence.
- Vexa's "avatar" is the bot's *camera-feed* image, not a Google profile
  picture. The bot joins as an unauthenticated guest, so Meet will always render
  a letter avatar from `bot_name`. A real profile picture is not achievable at
  any point.

**Trigger to revisit:** [Vexa issue #591](https://github.com/Vexa-ai/vexa/issues/591)
(the voice/media-agent carve). The contract is already sealed, so this is a
handler landing rather than an API redesign.

## Auto-deploy to Fly on push to `main` (GitHub Action)

**Why.** `fly deploy` ships the local working directory, not the repo. Right now
GitHub and production are independent: uncommitted work can be deployed, and a
push deploys nothing. A deploy-on-push Action makes `main` the single source of
truth for what is running.

**Sketch.**

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
  deploy:
    needs: test          # never deploy a red build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only --ha=false
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Setup.** Create a deploy token scoped to this app — `fly tokens create deploy
--app nishan` — and add it as the `FLY_API_TOKEN` repository secret under
Settings → Secrets and variables → Actions. An app-scoped deploy token is
preferable to a personal access token: it can only touch this app.

**Decide before building it.** This removes the manual approval gate that
`CLAUDE.md` currently requires, so a merge to `main` would restart the machine
with no human in the loop — including mid-meeting. Options:

- Accept it (deploys are ~15s and the poller resumes from SQLite), or
- Gate the deploy job on a GitHub Environment with required reviewers, keeping
  the approval step but moving it into GitHub, or
- Trigger on tags rather than every push to `main`.

Worth resolving that question first; the workflow itself is ten minutes' work.

**Also worth folding in.** `npm test` and `npm run typecheck` on pull requests
regardless of whether auto-deploy happens — CI value without the deploy risk.
