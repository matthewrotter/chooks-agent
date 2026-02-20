# Intent: src/index.ts modifications

## What changed
Added Slack channel support alongside existing channels.

## Key sections

### Imports (top of file)
- Added: `SlackChannel` from `./channels/slack.js`
- Added: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` from `./config.js`

### main() — channel creation
- Added: conditional Slack channel creation after WhatsApp:
  ```typescript
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    const slack = new SlackChannel(SLACK_BOT_TOKEN, SLACK_APP_TOKEN, channelOpts);
    channels.push(slack);
    await slack.connect();
  }
  ```
- Both tokens must be present to enable Slack (Socket Mode requires both bot token and app-level token)

## Invariants
- All existing code is unchanged — Slack additions are purely additive
- WhatsApp channel creation is unaffected
- The multi-channel routing (`findChannel`, `channels[]`) already supports additional channels
- Shared `channelOpts` are reused for the Slack channel
- Shutdown handler already iterates `channels[]` so Slack disconnect is automatic

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- WhatsApp channel creation (always, not conditional)
- All existing imports and module-level state
