# Team rules (soft constraints)

These are preferences an agent should follow but nothing fails when it skips them.
A rule that must never break does not belong here. Move it to `guard.config.json` (see `rules-table.md`).

## How we write code

- Write comments, log messages, and user-facing text in Thai, like the rest of the code. Identifiers stay in English.
- Pin dependencies to exact versions (no `^`) in workspace `package.json` files. The one range today is `@types/node: ^24` at the root. TypeScript stays at 6.0.3 and ESLint at 9.39.5 until typescript-eslint and the Next plugin support newer ones (README).
- Modules in `apps/web/src/lib/` start with `import "server-only"` (17 of 18 do; `params.ts` is a pure URL helper), so a client import fails the build too.
- Route handlers are wrapped in `route()` from `apps/web/src/lib/api.ts` (32 of 34; `health` and `auth/session` answer directly), check access with `requireApi(req, role)` unless the route is part of login itself, and report errors by throwing `HttpError`, so internal error details never reach the client.
- Validate request bodies with the zod schemas in `packages/core/src/schemas/` and share them with the forms, not hand-written checks.
- Read web configuration through `getEnv()` in `apps/web/src/lib/env.ts`, so a bad `.env` fails with one clear message. (`WEB_PEER_IN_XFF` in `lib/api.ts` is read directly: it is set by `peer-ip.mjs`, not by `.env`.)

## How we work

- Prove a change with `node .stack-agent/bin/verify.mjs` before calling it done. Report the evidence file path. It starts its own temporary PostgreSQL (`scripts/verify-env.mjs`), so it never touches the dev database.
- CI also runs `pnpm format:check` and `pnpm lint`, which verify does not (verify does run `pnpm typecheck`). Run them before you report a change.
- Code in `packages/` does not hot-reload: restart `pnpm dev:web` and the worker after changing it.
- If the project has `.stack-agent/api-map.json`, keep `.stack-agent/api-map.md` in sync with the routes. `node .stack-agent/bin/api-map.mjs` fails when it drifts.
- Do not commit, push, or merge unless a human asks for it.
