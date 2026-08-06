# Backlog

Things worth doing, not yet done.

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
