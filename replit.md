# Telegram Bot

A full-featured Telegram bot with shop, card tools, social scraping, group moderation, and owner commands — powered by Express + grammy + PostgreSQL.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `TELEGRAM_BOT_TOKEN` — from @BotFather
- Required secret: `BOT_OWNER_ID` — your Telegram user ID (for /broadcast, /stats)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: grammy (long polling)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/` — bot entry point and all handlers
- `artifacts/api-server/src/bot/handlers/` — one file per feature area
- `lib/db/src/schema/` — DB tables: users, products, orders, group_settings, warnings, blacklist

## Architecture decisions

- Bot runs in long-polling mode alongside Express in the same process
- grammy is externalized from the esbuild bundle (uses native `platform.node` module)
- Owner check uses `BOT_OWNER_ID` env var — set it to your Telegram numeric user ID
- Anti-spam middleware runs on every group message before command handlers

## Product

- `/buy`, `/order`, `/cancelorder`, `/orders` — product shop with persistent orders
- `/chk`, `/rzp`, `/bin`, `/gen` — card tools (Luhn check, BIN lookup, card generation)
- `/fb`, `/insta`, `/snap`, `/pin` — social URL scraper (DM only)
- `/warn`, `/ban`, `/mute`, `/bl`, `/links`, `/captcha` and more — full group admin suite
- `/broadcast`, `/stats` — owner-only commands
- Auto welcome messages, blacklist enforcement, link/forward filtering

## Gotchas

- After adding new DB tables, run `pnpm --filter @workspace/db run push` then `pnpm run typecheck:libs` before typechecking api-server
- grammy must stay in `build.mjs` externals — it uses a native binary that can't be bundled
- `/pin` command conflicts between group admin (pin message) and Pinterest social scraper — Pinterest scraper only fires in private chats

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
