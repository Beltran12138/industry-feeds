'use strict';
/**
 * push-channel.js — 推送渠道抽象层
 *
 * 支持多渠道推送：企业微信、钉钉、Slack、Telegram、Email
 * 统一接口，便于扩展
 */

const axios = require('axios');
require('dotenv').config();

// ── 渠道配置 ─────────────────────────────────────────────────────────────────
const CHANNEL_CONFIG = {
  wecom: {
    name: '企业微信',
    enabled: !!process.env.WECOM_WEBHOOK_URL,
    webhook: process.env.WECOM_WEBHOOK_URL,
    supportsMarkdown: true,
    rateLimit: 20, // 每分钟最多20条
  },
  dingtalk: {
    name: '钉钉',
    enabled: !!process.env.DINGTALK_WEBHOOK_URL && !!process.env.DINGTALK_SECRET,
    webhook: process.env.DINGTALK_WEBHOOK_URL,
    secret: process.env.DINGTALK_SECRET,
    supportsMarkdown: true,
    rateLimit: 20,
  },
  slack: {
    name: 'Slack',
    enabled: !!process.env.SLACK_WEBHOOK_URL,
    webhook: process.env.SLACK_WEBHOOK_URL,
    supportsMarkdown: true,
    rateLimit: 50,
  },
  telegram: {
    name: 'Telegram',
    enabled: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    supportsMarkdown: true,
    rateLimit: 30,
  },
  email: {
    name: 'Email',
    enabled: !!process.env.SMTP_HOST && !!process.env.SMTP_USER,
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    to: process.env.EMAIL_TO,
    supportsMarkdown: false,
    rateLimit: 10,
  },
};

// ── 基础推送类 ───────────────────────────────────────────────────────────────
class PushChannel {
  constructor(config) {
    this.config = config;
    this.lastPushTime = 0;
    this.pushCount = 0;
    this.resetInterval = setInterval(() => {
      this.pushCount = 0;
    }, 60000); // 每分钟重置计数
  }

  // 清理资源，防止测试挂起
  cleanup() {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
      this.resetInterval = null;
    }
  }

  async send(message) {
    throw new Error('Subclasses must implement send()');
  }

  checkRateLimit() {
    if (this.pushCount >= this.config.rateLimit) {
      throw new Error(`Rate limit exceeded for ${this.config.name}`);
    }
    this.pushCount++;
  }

  formatMessage(content, options = {}) {
    return content;
  }
}

// ── 企业微信渠道 ─────────────────────────────────────────────────────────────
class WeComChannel extends PushChannel {
  constructor() {
    super(CHANNEL_CONFIG.wecom);
  }

  async send(message) {
    if (!this.config.enabled) {
      console.warn('[Push] WeCom not configured');
      return false;
    }

    this.checkRateLimit();

    const VERCEL_URL = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const deepAskUrl = `${VERCEL_URL}/?deep_ask=true&q=${encodeURIComponent(message.title || '')}`;
    const dashboardUrl = `${VERCEL_URL}`;

    const interactiveFooter = `\n\n---\n[🔍 深度追问](${deepAskUrl}) | [📊 行业看板](${dashboardUrl})`;

    const payload = {
      msgtype: message.type || 'markdown',
      markdown: {
        content: message.content + (message.type === 'markdown' ? interactiveFooter : ''),
      },
    };

    if (message.type === 'text') {
      payload.msgtype = 'text';
      payload.text = { content: message.content };
      delete payload.markdown;
    }

    try {
      const res = await axios.post(this.config.webhook, payload, {
        timeout: 10000,
      });

      if (res.data?.errcode !== 0) {
        console.error('[Push] WeCom error:', res.data);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Push] WeCom send error:', err.message);
      return false;
    }
  }

  // 分段发送长消息
  async sendLong(content, options = {}) {
    const MAX_LENGTH = 4096;
    const segments = [];

    // 按段落分割
    const paragraphs = content.split('\n\n');
    let currentSegment = '';

    for (const para of paragraphs) {
      if ((currentSegment + para).length > MAX_LENGTH) {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = para;
      } else {
        currentSegment += (currentSegment ? '\n\n' : '') + para;
      }
    }
    if (currentSegment) segments.push(currentSegment);

    // 逐段发送
    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const header = segments.length > 1 ? `【${i + 1}/${segments.length}】\n\n` : '';
      const result = await this.send({
        content: header + segment,
        type: 'markdown',
      });
      results.push(result);

      if (i < segments.length - 1) {
        await new Promise(r => setTimeout(r, 1000)); // 间隔1秒
      }
    }

    return results.every(r => r);
  }
}

// ── 钉钉渠道 ─────────────────────────────────────────────────────────────────
class DingTalkChannel extends PushChannel {
  constructor() {
    super(CHANNEL_CONFIG.dingtalk);
  }

  // 生成钉钉签名
  generateSign(timestamp) {
    const crypto = require('crypto');
    const stringToSign = `${timestamp}\n${this.config.secret}`;
    const sign = crypto.createHmac('sha256', this.config.secret)
      .update(stringToSign)
      .digest('base64');
    return encodeURIComponent(sign);
  }

  async send(message) {
    if (!this.config.enabled) {
      console.warn('[Push] DingTalk not configured');
      return false;
    }

    this.checkRateLimit();

    const timestamp = Date.now();
    const sign = this.generateSign(timestamp);
    const url = `${this.config.webhook}&timestamp=${timestamp}&sign=${sign}`;

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: message.title || 'Alpha Radar 通知',
        text: message.content,
      },
    };

    try {
      const res = await axios.post(url, payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.data?.errcode !== 0) {
        console.error('[Push] DingTalk error:', res.data);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Push] DingTalk send error:', err.message);
      return false;
    }
  }
}

// ── Slack 渠道 ───────────────────────────────────────────────────────────────
class SlackChannel extends PushChannel {
  constructor() {
    super(CHANNEL_CONFIG.slack);
  }

  async send(message) {
    if (!this.config.enabled) {
      console.warn('[Push] Slack not configured');
      return false;
    }

    this.checkRateLimit();

    const payload = {
      text: message.content,
      mrkdwn: true,
    };

    if (message.title) {
      payload.blocks = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: message.title,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: message.content,
          },
        },
      ];
    }

    try {
      const res = await axios.post(this.config.webhook, payload, {
        timeout: 10000,
      });

      if (res.data !== 'ok') {
        console.error('[Push] Slack error:', res.data);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Push] Slack send error:', err.message);
      return false;
    }
  }
}

// ── Telegram 渠道 ────────────────────────────────────────────────────────────
class TelegramChannel extends PushChannel {
  constructor() {
    super(CHANNEL_CONFIG.telegram);
  }

  async send(message) {
    if (!this.config.enabled) {
      console.warn('[Push] Telegram not configured');
      return false;
    }

    this.checkRateLimit();

    const url = `https://api.telegram.org/bot${this.config.token}/sendMessage`;

    const payload = {
      chat_id: this.config.chatId,
      text: message.content,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    };

    try {
      const res = await axios.post(url, payload, {
        timeout: 10000,
      });

      if (!res.data?.ok) {
        console.error('[Push] Telegram error:', res.data);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Push] Telegram send error:', err.message);
      return false;
    }
  }

  // 分段发送
  async sendLong(content, options = {}) {
    const MAX_LENGTH = 4096;
    const segments = [];

    // 按段落分割
    const paragraphs = content.split('\n\n');
    let currentSegment = '';

    for (const para of paragraphs) {
      if ((currentSegment + para).length > MAX_LENGTH) {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = para;
      } else {
        currentSegment += (currentSegment ? '\n\n' : '') + para;
      }
    }
    if (currentSegment) segments.push(currentSegment);

    const results = [];
    for (let i = 0; i < segments.length; i++) {
      const result = await this.send({
        content: segments[i],
      });
      results.push(result);

      if (i < segments.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return results.every(r => r);
  }
}

// ── Email 渠道 ────────────────────────────────────────────────────────────────
class EmailChannel extends PushChannel {
  constructor() {
    super(CHANNEL_CONFIG.email);
    this.nodemailer = null;
  }

  async init() {
    if (!this.nodemailer) {
      this.nodemailer = require('nodemailer');
    }
  }

  async send(message) {
    if (!this.config.enabled) {
      console.warn('[Push] Email not configured');
      return false;
    }

    await this.init();
    this.checkRateLimit();

    const transporter = this.nodemailer.createTransporter({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.port === 465,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
    });

    try {
      await transporter.sendMail({
        from: `"Alpha Radar" <${this.config.user}>`,
        to: this.config.to,
        subject: message.title || 'Alpha Radar 通知',
        text: message.content,
        html: message.html || `<pre>${message.content}</pre>`,
      });

      return true;
    } catch (err) {
      console.error('[Push] Email send error:', err.message);
      return false;
    }
  }
}

// ── 推送管理器 ───────────────────────────────────────────────────────────────
class PushManager {
  constructor() {
    this.channels = new Map();
    this.init();
  }

  init() {
    // 初始化所有启用的渠道
    if (CHANNEL_CONFIG.wecom.enabled) {
      this.channels.set('wecom', new WeComChannel());
    }
    if (CHANNEL_CONFIG.dingtalk.enabled) {
      this.channels.set('dingtalk', new DingTalkChannel());
    }
    if (CHANNEL_CONFIG.slack.enabled) {
      this.channels.set('slack', new SlackChannel());
    }
    if (CHANNEL_CONFIG.telegram.enabled) {
      this.channels.set('telegram', new TelegramChannel());
    }
    if (CHANNEL_CONFIG.email.enabled) {
      this.channels.set('email', new EmailChannel());
    }

    console.log(`[PushManager] Initialized with ${this.channels.size} channels:`,
      Array.from(this.channels.keys()).join(', '));
  }

  // 清理所有渠道的资源
  cleanup() {
    for (const channel of this.channels.values()) {
      if (channel.cleanup) channel.cleanup();
    }
    console.log('[PushManager] Resources cleaned up');
  }

  // 获取所有启用的渠道
  getEnabledChannels() {
    return Array.from(this.channels.entries()).map(([key, channel]) => ({
      key,
      name: channel.config.name,
      supportsMarkdown: channel.config.supportsMarkdown,
    }));
  }

  // 推送到指定渠道
  async pushTo(channelKey, message) {
    const channel = this.channels.get(channelKey);
    if (!channel) {
      console.warn(`[PushManager] Channel ${channelKey} not found`);
      return false;
    }

    return await channel.send(message);
  }

  // 推送到所有渠道
  async pushToAll(message, options = {}) {
    const results = {};
    const channels = options.channels || Array.from(this.channels.keys());

    for (const key of channels) {
      const channel = this.channels.get(key);
      if (channel) {
        try {
          results[key] = await channel.send(message);
        } catch (err) {
          console.error(`[PushManager] Failed to push to ${key}:`, err);
          results[key] = false;
        }
      }
    }

    return results;
  }

  // 发送长消息（自动分段）
  async pushLong(channelKey, content, options = {}) {
    const channel = this.channels.get(channelKey);
    if (!channel) {
      console.warn(`[PushManager] Channel ${channelKey} not found`);
      return false;
    }

    if (channel.sendLong) {
      return await channel.sendLong(content, options);
    }

    // 不支持分段的渠道，直接发送
    return await channel.send({ content, ...options });
  }

  // 发送报告（推送到所有启用的渠道）
  async sendReport(title, content, options = {}) {
    const message = {
      title,
      content,
      type: 'markdown',
    };

    const results = await this.pushToAll(message, options);
    const successCount = Object.values(results).filter(r => r).length;

    console.log(`[PushManager] Report sent to ${successCount}/${Object.keys(results).length} channels`);
    return results;
  }

  // 发送重要通知
  async sendImportant(title, content, options = {}) {
    const message = {
      title: `【重要】${title}`,
      content: `**${title}**\n\n${content}`,
      type: 'markdown',
    };

    // 重要通知推送到所有渠道
    return await this.pushToAll(message, options);
  }

  // 获取状态
  getStatus() {
    return {
      total: this.channels.size,
      channels: Array.from(this.channels.entries()).map(([key, channel]) => ({
        key,
        name: channel.config.name,
        enabled: channel.config.enabled,
        rateLimit: channel.config.rateLimit,
        pushCount: channel.pushCount,
      })),
    };
  }
}

// ── 导出单例 ─────────────────────────────────────────────────────────────────
const pushManager = new PushManager();

module.exports = {
  pushManager,
  PushManager,
  WeComChannel,
  DingTalkChannel,
  SlackChannel,
  TelegramChannel,
  EmailChannel,
  CHANNEL_CONFIG,
};
