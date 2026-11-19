# Arkham: Revived Redux - Discord Bot

The companion service for **Arkham: Revived Redux**. It receives events from the
[ArkhamRevivedWorker](../ArkhamRevivedWorker) Cloudflare Worker, announces player activity in Discord,
detects finished matches from profile writes, and keeps the server statistics up to date.

Check out the Arkham: Revived page on [my website](https://kiwifruitdev.com/arkhamrevived/) or join the [Discord](https://discord.gg/7BneAcgvZh)

> [!NOTE]
> Significant portions of this codebase were developed with AI assistance using
> [DeepSeek](https://www.deepseek.com/) and [GitHub Copilot](https://github.com/features/copilot).

## What it does

| Feature | Description |
| --- | --- |
| Player activity | The worker calls the bot's HTTP webhook on `/auth/token` and on every profile write. Logins are plain text messages; profile changes are compact `before -> after` embeds, while a stats-only `profile_write` event refreshes KV usage. Player messages use the Discord webhook from `.env`, with the PSN username and avatar. |
| Publishing | Every activity message and every match result is crossposted, because the activity channel is an announcement channel. Discord only allows 10 crossposts per hour per channel, so publishes go through a persistent FIFO queue that waits for the window to reset instead of failing. |
| Match results | When two or more players report an XP/level increase within 10 seconds, a match is assumed to have ended. The accumulated deltas **and** the resulting totals of each player are posted as a bot embed, together with an automatically sized grid of PSN avatars. |
| Voice channel statistics | The `Total PS3 Users`, `Matches (24h)` and `Logins (24h)` voice channels are renamed with live numbers. The two "24h" counters roll over individually: every match and every first authentication leaves the window exactly 24 hours after it was added, and the channel is edited as soon as it drops out. |
| KV usage and availability | The configured KV usage channel shows account-wide daily KV writes. Workers Free accounts use Cloudflare's 1,000-write daily allowance; Workers Paid accounts have no daily cap, though their included writes are metered monthly and overages may be billed. At 50% the bot warns in the player activity channel and goes idle, and at 100% it posts an outage notice and goes Do Not Disturb. If usage had reached 100%, the next Cloudflare UTC-day reset posts a recovery notice and restores the normal online status. |
| Bot status | The bot's own status line shows live player/match numbers while available, or the KV usage warning when the allowance is at least half used. |

### Message flow

```
PS3 client ──► Cloudflare Worker ──► POST /webhook ──► Discord bot
                  (/auth/token)          (player_login)      │
                  (profile write)        (profile_write)     ├─► Discord webhook message  ──► publish (crosspost)
                                          (profile_update)    ├─► Cloudflare KV daily usage refresh
                                                              │
                                                              ├─► MatchTracker (10s window)
                                                              │      └─► match embed + avatar grid (sent by the bot)
                                                              └─► Voice channel names + bot status
```

## Requirements

- Node.js 24 or newer (the bot runs `index.ts` directly through Node's built-in TypeScript support)
- A Discord bot application with the `Guilds` intent and `Manage Channels`, `Send Messages`,
  `Manage Messages` and `Manage Webhooks` permissions in the server
- A PSN `NPSSO` cookie (used to look up PSN avatars)
- A Discord webhook in the player activity channel
- Optional: a Cloudflare API token with Workers KV read, Account Analytics read and Account Billing read permissions

## Setup

```bash
npm install
cp example.env .env     # fill in the values
npm start
```

`config.json` (local) is merged over `default-config.json` (committed). Only put environment specific
values in `config.json`, everything secret belongs in `.env`.
The `language` setting selects a JSON file in `lang/` for all user-facing Discord text; the default is `en-US`.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token used to publish messages, post match embeds and rename channels. |
| `PSN_NPSSO` | yes | NPSSO cookie used to resolve PSN usernames to profile pictures. |
| `DISCORD_WEBHOOK_URL` | yes | Webhook of the player activity channel. |
| `WEBHOOK_SECRET` | yes | Shared secret the worker sends as `x-webhook-secret` (or as a bearer token). |
| `CLOUDFLARE_API_TOKEN` | no | Account read, Workers KV read, Account Analytics read and Account Billing read permissions. Enables the player counter and KV usage/plan lookup. |
| `CLOUDFLARE_ACCOUNT_ID` | no | Overrides the auto-discovered Cloudflare account id. |
| `CLOUDFLARE_PROFILES_NAMESPACE_ID` | no | Overrides `cloudflare_profiles_namespace_id` from the config file. |
| `WEBHOOK_PORT` | no | Overrides `webhook_port` from the config file. |
| `PUBLIC_BASE_URL` | no | Public base URL of this bot. When set, webhook avatars are served from `/avatars/<file>` instead of the PSN CDN. |

## Configuration (`config.json`)

| Key | Default | Description |
| --- | --- | --- |
| `language` | `en-US` | Locale file under `lang/` that supplies Discord-facing text. |
| `webhook_port` | `4322` | Port the worker webhook server listens on. |
| `webhook_path` | `/webhook` | Path the worker posts to (must match `WEBHOOK_URL` in the worker). |
| `publish_player_activity` | `true` | Crosspost activity messages and match results. |
| `player_activity_channel_id` | | Announcement channel id for activity and match messages. |
| `total_ps3_users_channel_id` | | Voice channel renamed to the PS3 player count. |
| `matches_played_today_channel_id` | | Voice channel renamed to the rolling 24 hour match count. |
| `unique_users_today_channel_id` | | Voice channel renamed to the rolling 24 hour unique authentication count. |
| `kv_usage_channel_id` | `1573087152261304460` | Voice channel renamed to account-wide daily KV write usage. |
| `stats_window_ms` | `86400000` | Rolling window used by both "today" counters (24 hours). |
| `channel_stats_update_interval_ms` | `600000` | How often the statistics channels (and the bot status) are refreshed. |
| `channel_name_update_cooldown_ms` | `610000` | Minimum time between two renames of the same channel (Discord allows 2 per 10 minutes). |
| `discord_server_id` | | Target guild id (informational). |
| `psn_npsso_owner_name` | | PSN account that owns the NPSSO cookie (informational). |
| `match_detection_window_ms` | `10000` | Window in which players must report a stat increase. |
| `match_detection_quiet_ms` | `3000` | Grace period after the last write before a match is posted. |
| `match_min_players` | `2` | Distinct players required before a match is detected (minimum 2). |
| `avatar_grid_cell_size` | `160` | Size of one avatar cell in the generated match grid. |
| `avatar_cache_ttl_ms` | `604800000` | How long PSN avatar lookups are cached. |
| `bot_status_type` | `watching` | Status activity type: `playing`, `watching`, `listening` or `competing`. |
| `publish_max_per_hour` | `10` | Maximum crossposts per channel per window (Discord's announcement channel limit). |
| `publish_window_ms` | `3600000` | Sliding window used for the crosspost limit. |
| `publish_queue_max_age_ms` | `7200000` | Queued messages older than this are dropped instead of published late. |
| `cloudflare_account_id` | `""` | Cloudflare account id; discovered automatically when empty. |
| `cloudflare_profiles_namespace_id` | PROFILES KV id | KV namespace that stores player profiles. |
| `state_directory` | `data` | Where `state.json` (matches played today, rename cooldowns) and `publish-queue.json` are stored. |
| `cache_directory` | `cache` | Where PSN tokens and cached avatars are stored. |
| `log_level` | `info` | `debug`, `info`, `warn`, `error` or `silent`. |

## Webhook API

All requests must carry the shared secret:

```
POST /webhook
Content-Type: application/json
x-webhook-secret: <WEBHOOK_SECRET>
```

### `player_login`

Sent by the worker after a successful `/auth/token` call.

```json
{
  "type": "player_login",
  "platform": "ps3",
  "username": "Another_Hermit",
  "uuid": "ps3_Another_Hermit_e929e446-b66e-4255-8ca4-c3f0bd3711aa",
  "timestamp": "2026-10-30T08:00:00.000Z"
}
```

Result: `**Another_Hermit** (PS3) has logged in to Arkham: Revived Redux.`

### `profile_write`

Sent after every successful PS3 profile KV write, including first writes and writes with no changed fields. The bot uses it to refresh Cloudflare's account-wide usage analytics; it is not shown as a player activity message.

```json
{
  "type": "profile_write",
  "platform": "ps3",
  "username": "Another_Hermit",
  "uuid": "ps3_Another_Hermit_e929e446-b66e-4255-8ca4-c3f0bd3711aa",
  "timestamp": "2026-10-30T08:05:00.000Z"
}
```

### `profile_update`

Sent by the worker after a profile write, containing only the fields that changed.

```json
{
  "type": "profile_update",
  "platform": "ps3",
  "username": "Another_Hermit",
  "uuid": "ps3_Another_Hermit_e929e446-b66e-4255-8ca4-c3f0bd3711aa",
  "timestamp": "2026-10-30T08:05:00.000Z",
  "changes": [
    { "path": "AccountXP", "before": 1250, "after": 1480 },
    { "path": "AccountXPLevel", "before": 28, "after": 29 },
    { "path": "HeroKillsOnElites", "before": 12, "after": 15 }
  ]
}
```

Result: an embed listing each change as `**Account XP**: 1,250 -> 1,480`, posted as the webhook identity.
XP, level and kill changes also feed the match detector.

### Other routes

| Route | Description |
| --- | --- |
| `GET /health` | Liveness check, returns `{"status":"ok","uptime":<seconds>}`. |
| `GET /avatars/<file>` | Cached PSN avatar bytes, used when `PUBLIC_BASE_URL` is set. |

## Publishing limits

Discord allows **10 crossposts per hour per announcement channel**, so every publish goes through
`PublishQueue` (`src/publish-queue.ts`) instead of calling `crosspost()` directly:

- Successful publishes are recorded per channel in a sliding window (`publish_max_per_hour` / `publish_window_ms`).
- Messages beyond the limit stay queued **in order** and a timer publishes them as soon as a slot frees up;
  nothing is dropped just because the window is full.
- A `429` from Discord requeues the message and backs off using the `retry_after` value.
- Messages already crossposted (or deleted) are dropped, and a message that fails 10 times is dropped.
- Messages older than `publish_queue_max_age_ms` (2 hours by default) are dropped rather than published
  an hour late.
- The queue and the window are persisted to `<state_directory>/publish-queue.json`, so a restart keeps
  both the waiting messages and the remaining allowance.

## Statistics channels

| Channel | Value | Rollover |
| --- | --- | --- |
| `Total PS3 Users: {count}` | Every `ps3_*` key in the PROFILES KV namespace. | n/a |
| `Matches (24h): {count}` | Matches detected in the last 24 hours. | Each match expires 24 h after it was detected. |
| `Logins (24h): {count}` | Distinct players that authenticated in the last 24 hours. | Each player expires 24 h after their first authentication. |

The KV usage channel uses Cloudflare's account-wide `kvOperationsAdaptiveGroups` analytics and Workers subscription. Its daily count follows Cloudflare's UTC date and analytics availability, so it can lag behind a just-completed KV operation. Workers Free has a 1,000 writes/day allowance; when no paid Workers subscription is present, the default Free plan applies. Workers Paid has no daily write cap, but includes 1 million writes per month and additional usage may be billed. If the subscription endpoint cannot be read, the channel shows the write count with `limit unknown` and the bot does not guess a limit. All Discord-facing text, including channel names, embeds, activity notices and presence text, is stored in `lang/en-US.json`.

Grant the Cloudflare API token Account: Read, Workers KV Storage: Read, Account Analytics: Read, and Account Billing: Read. Discord rate-limits channel renames, so the usage channel name updates as often as Discord allows even though a refresh is requested on every successful PS3 profile write.

The two "today" channels use a rolling window (`stats_window_ms`, 24 h) instead of a calendar day: every
entry is timestamped when it is added and removed exactly 24 hours later. The service schedules a wake-up
for the oldest entry's expiry, so the channel is renamed **as soon as the entry is removed**, not on the
next 10 minute poll. Repeat logins by the same player do not raise the unique user count until their
entry expires, and the publish/rename cooldown still prevents Discord rate limits when several entries
expire at once.

## Match detection

1. Every `profile_update` with a positive XP, level, kill or prestige change is buffered per player.
2. If at least `match_min_players` distinct players reported a change inside `match_detection_window_ms` (10s),
   and no further write arrived for `match_detection_quiet_ms` (3s), a match is emitted.
3. Each player's writes are merged into one row per stat field, keeping the delta and the new total.
4. The bot posts a `Match Result` embed (as itself, not through the webhook) with the PSN avatars combined
   into one image, then publishes it and increments the rolling match counter.

## PSN avatars

Avatars are resolved with [`psn-api`](https://github.com/achievementarcade/psn-api) from the PSN account
that owns the `PSN_NPSSO` cookie. Lookups are cached in `cache/avatars/index.json`, the image bytes are
cached in `cache/avatars/*.img`, and the PSN access/refresh tokens are cached in
`cache/avatars/psn-tokens.json`. Failed lookups are cached briefly so a bad username cannot hammer the API.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Run the bot (`node index.ts`). |
| `npm run dev` | Run the bot with file watching. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run the Vitest suite in watch mode. |
| `npm run typecheck` | Type check the project with `tsc --noEmit`. |

## Tests

`npm test` runs entirely locally and does not touch Discord or PSN:

- `test/worker-flow.spec.ts` replays real worker payloads into a real HTTP webhook server and asserts the
  announced messages, the published ids, the match detection, the generated avatar grid and the match counter.
- `test/webhook-server.spec.ts` covers authentication, routing, payload validation, health checks and
  avatar serving.
- `test/profile-diff.spec.ts`, `test/match-tracker.spec.ts`, `test/avatar-grid.spec.ts`,
  `test/state.spec.ts`, `test/channel-stats.spec.ts` and `test/publish-queue.spec.ts` cover the individual
  pieces (diffing, the 10 second window, grid layout, the rolling 24 hour counters, channel renames,
  bot status, and the 10-per-hour publish queue).

## Discord permissions

The bot needs `Manage Channels` to rename the statistics voice channels. One caveat: Discord hides voice
channels the bot is not allowed to join, so a stats channel that denies `Connect` for `@everyone` is
invisible to the bot and returns `Missing Access`. Grant the bot role `View Channel`, `Connect` and
`Manage Channels` on those two channels (or remove the `@everyone` connect deny) and the rename works.

The bot also needs `Send Messages` and `Manage Messages` in the player activity channel to post (as itself)
and publish match results.

## Licence

Licensed under the [MIT License](/LICENSE).