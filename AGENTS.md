
# Trade Matangi Project

## Branch rules (read first; applies to every coding agent)

- `main` and `preprod` are for REAL TRADING. `dev` is for new features (KLine chart, webapp), tested with simulated / replay / stepwise sessions only.
- Always work on a new branch and raise a PR. **Real-trading bug fixes target `preprod`; new features target `dev`.** Never push straight to `main`; the user merges `preprod` into `main` manually.
- After any change lands on `preprod`, sync it into `dev` right away: branch off `origin/dev`, `git merge origin/preprod`, PR into `dev`.
- Merge PRs between `dev`, `preprod` and `main` with **"Create a merge commit". Never squash or rebase them**, or the same fixes conflict next time.
- Do not merge `dev` wholesale into `preprod`/`main` until the user says `dev` is trusted for real trading; port specific commits with `git cherry-pick -x`.
- Run `bash scripts/check-preprod-synced.sh` after any merge into `preprod` and before any `dev` -> `preprod` merge.
- Full details: the "Branch Strategy" section in `CLAUDE.md`.

@CLAUDE.md

## Keep simple changes simple

- Prefer existing state and direct checks for small requirements.
- Do not add broad historical scans, new infrastructure, or extra restrictions unless the requirement needs them.
- Keep scope to the requested change. Use focused verification first; defer full-suite testing when the user asks to test the change immediately.
