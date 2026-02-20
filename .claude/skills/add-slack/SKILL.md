---
name: add-slack
description: Add Slack as a DM channel using Socket Mode. Runs alongside WhatsApp and any other configured channels.
---

# Add Slack Channel

This skill adds Slack DM support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `slack` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Do they already have a Slack App with Socket Mode?** If yes, collect the Bot Token (`xoxb-...`) and App-Level Token (`xapp-...`) now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

This deterministically:
- Adds `src/channels/slack.ts` (SlackChannel class implementing Channel interface)
- Adds `src/channels/slack.test.ts` (unit tests)
- Three-way merges Slack support into `src/index.ts` (conditional SlackChannel creation)
- Three-way merges Slack config into `src/config.ts` (SLACK_BOT_TOKEN, SLACK_APP_TOKEN exports)
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack App, tell them:

> I need you to create a Slack App with Socket Mode:
>
> 1. Go to **https://api.slack.com/apps** and click **Create New App** > **From scratch**
> 2. Name it something friendly (e.g., "Andy Assistant") and pick your workspace
> 3. In the left sidebar, go to **Socket Mode** and toggle it **on**
>    - Give the App-Level Token a name (e.g., "socket") and click **Generate**
>    - Copy the token (starts with `xapp-...`) — this is your **App-Level Token**
> 4. In the left sidebar, go to **OAuth & Permissions**
>    - Under **Bot Token Scopes**, add: `chat:write`, `im:history`, `im:read`, `im:write`
> 5. In the left sidebar, go to **Event Subscriptions** and toggle **on**
>    - Under **Subscribe to bot events**, add: `message.im`
> 6. Go back to **Install App** in the sidebar and click **Install to Workspace**
>    - Authorize the app
>    - Copy the **Bot User OAuth Token** (starts with `xoxb-...`) — this is your **Bot Token**

Wait for the user to provide both tokens.

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Slack User ID

Tell the user:

> I need your Slack user ID to register the DM channel:
>
> 1. In Slack, click on your **profile picture** (top right)
> 2. Click **Profile**
> 3. Click the **three dots** (More) menu
> 4. Click **Copy member ID**
>
> It looks like `U12AB34CD5`.

Wait for the user to provide their Slack user ID.

### Register the DM

Use the IPC register flow or register directly. The user ID, name, and folder are needed.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("slack:<user-id>", {
  name: "<user-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For an additional DM (trigger-only):

```typescript
registerGroup("slack:<user-id>", {
  name: "<user-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a DM to the bot in Slack:
> - For main chat: Any message works
> - For non-main: Start with `@Andy` (or your assistant's trigger name)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

Look for:
- `Slack bot connected` — app started successfully
- `Slack message stored` — message received and stored
- `Slack message sent` — reply delivered

## Troubleshooting

### Bot not responding

1. Check both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Check DM is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. For non-main chats: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw`

### "not_allowed_token_type" error

The App-Level Token (`xapp-...`) is required for Socket Mode. Make sure you're not using the Bot Token for both.

### Bot not receiving messages

1. Verify **Event Subscriptions** is enabled in the Slack App settings
2. Verify `message.im` is in the bot events list
3. Check that Socket Mode is enabled
4. Try reinstalling the app to the workspace (OAuth & Permissions > Reinstall)

### Getting user ID

If the profile menu doesn't show "Copy member ID":
- In Slack Desktop: View > Developer > Copy member ID (from profile)
- Alternatively, look at the URL when viewing a profile: the user ID is in the URL

## After Setup

The Slack DM channel is now active alongside your other channels. Messages sent to the bot via Slack DM will be processed the same way as WhatsApp or Telegram messages.
