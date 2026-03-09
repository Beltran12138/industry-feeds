const axios = require('axios');
require('dotenv').config();

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;

// 企业微信 Markdown 消息字符限制
const WECOM_MARKDOWN_LIMIT = 4096;

/**
 * 推送单条消息到企业微信
 */
async function sendToWeCom(item) {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[WeCom] No Webhook URL found, skipping push.');
    return;
  }

  // 构建消息模板（Markdown 格式，适配企业微信机器人）
  const content = `
## 🚨 行业情报快报

**【${item.business_category || '快讯'}】** ${item.title}

> **详情:** ${item.detail || '暂无详情'}  
> **来源:** ${item.source}  
> **链接:** [查看原文](${item.url})

---
*由 Alpha-Radar 智能抓取并推送*
  `.trim();

  try {
    await axios.post(WECOM_WEBHOOK_URL, {
      msgtype: 'markdown',
      markdown: { content }
    });
    console.log(`[WeCom] Sent: ${item.title}`);
  } catch (err) {
    console.error('[WeCom Error]:', err.message);
  }
}

/**
 * 发送长文本报告到企业微信（自动分段）
 * 企业微信 Markdown 消息限制 4096 字符，超出则拆分为多条消息
 * @param {string} reportContent - 完整报告内容
 * @param {string} reportType - 报告类型标签（'日报' | '周报'）
 */
async function sendReportToWeCom(reportContent, reportType = '日报') {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[WeCom] No Webhook URL found, skipping report push.');
    return;
  }

  if (!reportContent || reportContent.trim().length === 0) {
    console.warn('[WeCom] Empty report content, skipping.');
    return;
  }

  // 添加报告头部
  const header = reportType === '周报' 
    ? '## 📅 周报汇总' 
    : '## 📋 日报汇总';
  
  const formattedContent = header + '\n\n' + reportContent;

  // 将内容按段落拆分，确保每段不超过限制
  const segments = splitReportContent(formattedContent, WECOM_MARKDOWN_LIMIT - 200);

  console.log(`[WeCom] Sending ${reportType}: ${segments.length} segment(s)...`);

  for (let i = 0; i < segments.length; i++) {
    let content = segments[i];

    // 如果有多段，加上页码标记
    if (segments.length > 1) {
      content += `\n\n---\n*${reportType} (${i + 1}/${segments.length})*`;
    }

    try {
      await axios.post(WECOM_WEBHOOK_URL, {
        msgtype: 'markdown',
        markdown: { content }
      });
      console.log(`[WeCom] ${reportType} segment ${i + 1}/${segments.length} sent.`);

      // 多段之间间隔 1 秒，避免被限流
      if (i < segments.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`[WeCom ${reportType} Error] Segment ${i + 1}:`, err.message);
    }
  }
}

/**
 * 将长文本按段落边界拆分为不超过 maxLen 的片段
 */
function splitReportContent(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const segments = [];
  const paragraphs = text.split('\n\n');
  let current = '';

  for (const para of paragraphs) {
    // 如果当前段落本身就超长，按行拆分
    if (para.length > maxLen) {
      if (current.trim()) {
        segments.push(current.trim());
        current = '';
      }
      const lines = para.split('\n');
      for (const line of lines) {
        if ((current + '\n' + line).length > maxLen) {
          if (current.trim()) segments.push(current.trim());
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
      continue;
    }

    if ((current + '\n\n' + para).length > maxLen) {
      if (current.trim()) segments.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

module.exports = { sendToWeCom, sendReportToWeCom };
