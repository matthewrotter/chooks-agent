import { App } from '@slack/bolt';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private userNameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    // Listen for all messages, filter to DMs only
    this.app.message(async ({ message }) => {
      const msg = message as any;

      // Only handle DMs (im = direct messages)
      if (msg.channel_type !== 'im') return;

      // Skip bot messages, edits, and other subtypes
      if (msg.subtype) return;

      const userId = msg.user;
      if (!userId) return;

      const chatJid = `slack:${userId}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const content = msg.text || '';
      const msgId = msg.ts;

      // Resolve display name (cached)
      const senderName = await this.resolveUserName(userId);

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, senderName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, senderName },
          'Message from unregistered Slack DM',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Slack message stored');
    });

    await this.app.start();
    logger.info('Slack bot connected');
    console.log('\n  Slack bot connected (Socket Mode)');
    console.log('  DM the bot in Slack to interact\n');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channel = jid.replace(/^slack:/, '');

      // Slack has a ~4000 character limit per message — split if needed
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({ channel, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            channel,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.app !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      logger.info('Slack bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't support persistent typing indicators via Bot API
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app!.client.users.info({ user: userId });
      const user = result.user as any;
      const name =
        user?.profile?.display_name ||
        user?.real_name ||
        user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to fetch Slack user info');
      return userId;
    }
  }
}
