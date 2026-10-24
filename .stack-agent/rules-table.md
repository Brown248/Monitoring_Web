# Rule table

Every rule we keep correcting agents for, and what enforces it. Highest level first:
architecture > types > guard/lint/CI > test > docs. A rule whose "Enforced by" is only docs is a candidate for `/stack-agent:correct`.

| Rule | Why | Enforced by | Proof it catches a real mistake |
| --- | --- | --- | --- |
| A `"use client"` component never imports server code (`apps/web/src/lib/**`, `@app/db`, `@app/core/server`, `pg`, `argon2`) | it leaks database access and secrets into the browser bundle, or breaks the build | `import "server-only"` in lib files (build) + guard rule `client-not-import-server` | 2026-10-24: a probe file `apps/web/src/components/client/zz-guard-probe.tsx` importing `@/lib/db` and `@app/db` failed the guard on both lines (file deleted after) |
| Server code reaches monitored URLs only through the SSRF guard (`fetchBytesGuarded`, `runCheck`) | a monitored site, or a redirect it returns, could otherwise reach hosts inside the LAN | guard rule `outgoing-requests-through-ssrf-guard` + `packages/core/src/ssrf/ssrf.test.ts` + verify check `admin-adds-website` (internal IP → 400) | 2026-10-24: a probe `apps/worker/src/zz-guard-probe.ts` calling `fetch(u)` failed the guard (file deleted after) |
| One Incident open per website, one email per (incident, type, recipient) | duplicate alerts to recipients | row lock on `website_state` in `recordOutcome` + unique index `incidents_one_open_per_website` and constraint `notification_events_dedupe` + test "the database itself refuses a second open incident and a duplicate email job" in `apps/worker/src/pipeline.test.ts` (verify runs it against a real PostgreSQL) | 2026-10-24: with the index dropped, and separately with the constraint dropped, that test failed while the other 43 passed. The older race test alone passed without them, because the row lock already serializes `recordOutcome` |
| No private keys, merge markers, or leftover `[DEBUG-…]` lines in the repo | leaked credentials, broken builds | guard rules `no-private-keys`, `no-merge-conflict-markers`, `no-debug-tags` | shipped and tested by Stack Agent |
| Formatting, lint, and types pass | CI blocks the image build otherwise, so the VM never updates | `.github/workflows/ci.yml` (`format:check`, `lint`, `typecheck`, `test`) | CI history in GitHub Actions |
