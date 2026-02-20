---
name: add-gcal-ical
description: Add Google Calendar integration via private iCal URLs. Stores named .ics URLs that the agent can fetch and parse with node-ical. Supports multiple calendars.
---

# Add Google Calendar (iCal)

This skill manages private iCal URL subscriptions. Each calendar gets a name and a private .ics URL. The agent uses `node-ical` to fetch and parse events on demand.

## Phase 1: Pre-flight

### Check if container is ready

Read `.nanoclaw/state.yaml`. If `gcal-ical` is in `applied_skills`, the container already has `node-ical` installed — skip to Phase 3.

### Check existing calendars

Read `data/ical-calendars.json` if it exists. Show the user any calendars already configured:

> You have these calendars configured:
> - **Personal** — `https://calendar.google.com/calendar/ical/...`
> - **Work** — `https://calendar.google.com/calendar/ical/...`

If the file doesn't exist or is empty, that's fine — we'll create it.

## Phase 2: Container Setup (first time only)

Skip this phase if `gcal-ical` is already in `applied_skills`.

### Add node-ical to container

Edit `container/Dockerfile` line 33 to add `node-ical`:

```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code node-ical
```

### Rebuild the container

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

### Verify node-ical is available

```bash
container run -i --rm --entrypoint node nanoclaw-agent:latest -e "const ical = require('node-ical'); console.log('node-ical loaded:', typeof ical.async.fromURL)"
```

Should print `node-ical loaded: function`.

### Record in state

If `.nanoclaw/state.yaml` exists, add `gcal-ical` to the `applied_skills` list.

If `.nanoclaw/` doesn't exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

Then add `gcal-ical` to `applied_skills`.

## Phase 3: Add or Remove Calendar

Ask the user what they want to do.

### Adding a calendar

Ask for:

1. **Name** — a short label (e.g., "Personal", "Work", "Kids Activities")
2. **Private .ics URL** — the full Google Calendar private iCal address

The URL should look like:
```
https://calendar.google.com/calendar/ical/...@group.calendar.google.com/private-.../basic.ics
```

or for a primary calendar:
```
https://calendar.google.com/calendar/ical/user%40gmail.com/private-.../basic.ics
```

#### Validate the URL

Test-fetch the URL to confirm it works:

```bash
curl -sf -o /dev/null -w "%{http_code}" "THE_URL"
```

Should return `200`. If it fails, the URL may be wrong or expired — ask the user to regenerate it from Google Calendar Settings > Integrate calendar > Secret address in iCal format.

#### Save to config

Read `data/ical-calendars.json` (or start with `[]` if it doesn't exist). Append the new entry:

```json
{ "name": "Personal", "url": "https://calendar.google.com/calendar/ical/..." }
```

Write the updated array back to `data/ical-calendars.json`.

Tell the user:

> Added **Personal** calendar. You now have N calendar(s) configured.
>
> You can ask Chooks to fetch events from this calendar anytime, or set up a cron job for daily summaries.

### Removing a calendar

Read `data/ical-calendars.json` and show the list. Ask which to remove by name. Remove it and write back.

Tell the user:

> Removed **Personal** calendar. You now have N calendar(s) remaining.

## Phase 4: Agent Knowledge (first time only)

Skip if `gcal-ical` is already in `applied_skills` (the knowledge section was added previously).

Append the following section to `groups/main/CLAUDE.md`:

````markdown

---

## Google Calendar (iCal)

You can read events from Google Calendar via private iCal URLs. No API keys needed — the URLs themselves provide access.

### Configuration

Calendar subscriptions are stored in `/workspace/project/data/ical-calendars.json`:

```json
[
  { "name": "Personal", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" }
]
```

To list configured calendars, read this file.

### Fetching and Parsing Events

Use `node-ical` (globally installed) to fetch and parse. Example — get today's events from a calendar:

```bash
node -e "
const ical = require('node-ical');

async function main() {
  const url = process.argv[1];
  const raw = await ical.async.fromURL(url);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const events = [];
  for (const event of Object.values(raw)) {
    if (event.type !== 'VEVENT') continue;

    if (event.rrule) {
      // Expand recurring events into instances within today's window
      const instances = event.rrule.between(startOfDay, endOfDay, true);
      for (const date of instances) {
        // Check for exception dates
        const dateKey = date.toISOString().split('T')[0];
        if (event.exdate && Object.keys(event.exdate).some(d => d.startsWith(dateKey))) continue;
        const duration = event.end ? event.end.getTime() - event.start.getTime() : 3600000;
        events.push({
          summary: event.summary,
          start: date,
          end: new Date(date.getTime() + duration),
          location: event.location || '',
          allDay: event.datetype === 'date'
        });
      }
    } else if (event.start && event.end) {
      if (event.start < endOfDay && event.end > startOfDay) {
        events.push({
          summary: event.summary,
          start: event.start,
          end: event.end,
          location: event.location || '',
          allDay: event.datetype === 'date'
        });
      }
    }
  }

  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  console.log(JSON.stringify(events, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
" "ICAL_URL_HERE"
```

### Fetching All Calendars

To fetch events from all configured calendars:

```bash
node -e "
const ical = require('node-ical');
const fs = require('fs');
const calendars = JSON.parse(fs.readFileSync('/workspace/project/data/ical-calendars.json', 'utf8'));
// ... fetch each calendar and aggregate events
"
```

### Tips

- All-day events have `datetype === 'date'` and `start.dateOnly === true`
- Recurring events need `event.rrule.between(start, end, true)` to expand instances
- The `.ics` URL is the secret — treat it as sensitive
- Events are in the calendar's timezone; `event.start.tz` has the IANA timezone
````

Also append to `groups/global/CLAUDE.md` so all groups know calendars exist (but only main can access the file):

````markdown

---

## Google Calendar (iCal)

Calendar subscriptions are configured. The main channel can read and summarize calendar events using `node-ical`. Ask the main channel if you need calendar information.
````

## Phase 5: Verify

Tell the user:

> Calendar setup complete! You can now:
>
> - Ask Chooks: *"What calendars do I have?"*
> - Ask Chooks: *"Show me today's events from my Personal calendar"*
> - Ask Chooks: *"Set up a daily cron job to summarize my calendar every morning at 7am"*
>
> Run `/add-gcal-ical` again anytime to add or remove calendars.

## Troubleshooting

### URL returns non-200

The private iCal URL may have expired or been regenerated. In Google Calendar:
1. Go to **Settings** > click on the calendar
2. Scroll to **Integrate calendar**
3. Copy the **Secret address in iCal format**
4. Run `/add-gcal-ical` to update it (remove old, add new)

### node-ical not found in container

Rebuild the container:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Verify:

```bash
container run -i --rm --entrypoint node nanoclaw-agent:latest -e "require('node-ical')"
```

### No events showing for today

- Check if events are recurring — the parsing code handles `rrule` expansion
- All-day events span midnight-to-midnight, so they overlap with today's window
- Timezone differences may cause events to appear on adjacent days
