import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config (not used directly by slack.ts, but imported by logger)
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    messageHandlers: Handler[] = [];

    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: {
            real_name: 'Alice Smith',
            profile: { display_name: 'Alice' },
            name: 'alice',
          },
        }),
      },
    };

    constructor(_opts: any) {
      appRef.current = this;
    }

    message(handler: Handler) {
      this.messageHandlers.push(handler);
    }

    async start() {}

    async stop() {}
  },
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:U100200300': {
        name: 'Skip DM',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createDmEvent(overrides: {
  userId?: string;
  text?: string;
  ts?: string;
  channelId?: string;
  channelType?: string;
  subtype?: string;
}) {
  return {
    message: {
      user: overrides.userId ?? 'U100200300',
      text: overrides.text ?? 'Hello',
      ts: overrides.ts ?? '1704067200.000100',
      channel: overrides.channelId ?? 'D999888777',
      channel_type: overrides.channelType ?? 'im',
      subtype: overrides.subtype,
    },
    say: vi.fn(),
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessage(event: ReturnType<typeof createDmEvent>) {
  const handlers = currentApp().messageHandlers;
  for (const h of handlers) await h(event);
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();

      expect(currentApp().messageHandlers.length).toBeGreaterThan(0);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- DM message handling ---

  describe('DM message handling', () => {
    it('delivers message for registered DM', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({ text: 'Hello there' });
      await triggerMessage(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.any(String),
        'Alice', // from users.info mock display_name
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({
          id: '1704067200.000100',
          chat_jid: 'slack:U100200300',
          sender: 'U100200300',
          sender_name: 'Alice',
          content: 'Hello there',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered DMs', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({ userId: 'U999999999', text: 'Unknown user' });
      await triggerMessage(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:U999999999',
        expect.any(String),
        'Alice', // still resolves from users.info
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-DM messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({ channelType: 'channel' });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores messages with subtype (edits, bot messages, etc)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({ subtype: 'bot_message' });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores message_changed subtypes', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({ subtype: 'message_changed' });
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages without user field', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({});
      (event.message as any).user = undefined;
      await triggerMessage(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // 1704067200 = 2024-01-01T00:00:00.000Z
      const event = createDmEvent({ ts: '1704067200.000000' });
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('handles empty text gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({});
      (event.message as any).text = undefined;
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({ content: '' }),
      );
    });
  });

  // --- User name resolution ---

  describe('user name resolution', () => {
    it('resolves display_name from users.info', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const event = createDmEvent({});
      await triggerMessage(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U100200300',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({ sender_name: 'Alice' }),
      );
    });

    it('falls back to real_name when display_name is empty', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.users.info.mockResolvedValueOnce({
        user: {
          real_name: 'Alice Smith',
          profile: { display_name: '' },
          name: 'alice',
        },
      });

      const event = createDmEvent({});
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({ sender_name: 'Alice Smith' }),
      );
    });

    it('falls back to username when names are empty', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.users.info.mockResolvedValueOnce({
        user: {
          real_name: '',
          profile: { display_name: '' },
          name: 'alice_user',
        },
      });

      const event = createDmEvent({});
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when users.info fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createDmEvent({});
      await triggerMessage(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:U100200300',
        expect.objectContaining({ sender_name: 'U100200300' }),
      );
    });

    it('caches user names across messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // First message — cache miss, calls API
      const event1 = createDmEvent({ ts: '1704067200.000100' });
      await triggerMessage(event1);

      // Second message — cache hit, should NOT call API again
      const event2 = createDmEvent({ ts: '1704067201.000200' });
      await triggerMessage(event2);

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via chat.postMessage', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await channel.sendMessage('slack:U100200300', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'U100200300',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      await channel.sendMessage('slack:U999888777', 'Test');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'U999888777',
        text: 'Test',
      });
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('slack:U100200300', longText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(
        1,
        { channel: 'U100200300', text: 'x'.repeat(4000) },
      );
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(
        2,
        { channel: 'U100200300', text: 'x'.repeat(1000) },
      );
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4000);
      await channel.sendMessage('slack:U100200300', exactText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:U100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);

      // Don't connect — app is null
      await channel.sendMessage('slack:U100200300', 'No app');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('slack:U100200300')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('is a no-op (Slack has no persistent typing API)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-token', 'xapp-token', opts);
      await channel.connect();

      // Should not throw
      await expect(
        channel.setTyping('slack:U100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel('xoxb-token', 'xapp-token', createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });
});
