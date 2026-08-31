# Discord Voice Bot

An always-on Discord bot that turns `/speak` messages into speech in the user's current voice channel.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Discord bot and health server
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `DISCORD_TOKEN`, `CLIENT_ID`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord-bot.ts` — Discord client, slash-command registration, TTS generation, and voice playback
- `artifacts/api-server/src/index.ts` — HTTP health server and Discord bot startup

## Architecture decisions

- Discord credentials are read only from Replit Secrets.
- The bot uses only the Guilds and Guild Voice States intents; message content access is not needed for slash commands.
- Global slash-command registration keeps the bot invite flow simple and works across all servers where the bot is installed.

## Product

- Users run `/speak message:<text>` while connected to a voice channel.
- Google Text-to-Speech audio is converted through FFmpeg and played through Discord voice.
- Playback connections are cleaned up after speech finishes.

## Gotchas

- The bot needs Send Messages, Connect, and Speak permissions in each server.
- Global slash-command updates can take a little time to propagate in Discord.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
