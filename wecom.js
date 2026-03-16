const axios = require('axios');
require('dotenv').config();

const WECOM_WEBHOOK_URL = (process.env.WECOM_WEBHOOK_URL || '').trim();

// 企业微信 Markdown 消息字符限制
const WECOM_MARKDOWN_LIMIT = 4096;

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';

/**
 * 推送单条消息到企业微信
 * @param {Object} item - 新闻条目
 * @param {Object} options - 推送选项
 * @param {boolean} options.urgent - 是否为紧急消息（alpha_score >= CRITICAL_SCORE_THRESHOLD）
 */
async function sendToWeCom(item, options = {}) {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[WeCom] No Webhook URL found, skipping push.');
    return;
  }

  // 视觉增强：根据评分和影响类型选择 Emoji
  const scoreEmoji = item.alpha_score >= 90 ? '🔥' : (item.alpha_score >= 70 ? '⭐️' : '📡');
  const urgentPrefix = options.urgent ? '🚨 [紧急] ' : '';
  let impactColor = 3; // 默认灰色
  let impactText = item.impact || '待评估';
  if (item.impact === '利好') impactColor = 1; // 红色（股票红涨）或蓝色，看语境，这里企微模板里 1 是红色/重要，2 是绿色/打分，3 灰色
  else if (item.impact === '利空') impactColor = 2; // 绿色（绿跌）

  try {
    const payload = {
      msgtype: "template_card",
      template_card: {
        card_type: "text_notice",
        source: {
          icon_url: "https://files.catbox.moe/ksw38s.png", // 一个雷达小图标示例
          desc: "Alpha-Radar 战略预警",
          desc_color: 1
        },
        main_title: {
          title: urgentPrefix + item.title,
          desc: `${scoreEmoji} ${item.business_category || '快讯'} | 价值分: ${item.alpha_score || (item.is_important ? 85 : 50)}`
        },
        sub_title_text: (item.detail || '（暂无摘要）') + (item.bitv_action ? `\n💡 建议: ${item.bitv_action}` : ''),
        horizontal_content_list: [
          {
            keyname: "情报维度",
            value: item.competitor_category || '常规市场'
          },
          {
            keyname: "业务影响",
            value: impactText,
            type: impactColor
          },
          {
            keyname: "来源渠道",
            value: item.source || '未知'
          },
          {
            keyname: "趋势关联",
            value: item.trend_reference || '暂无'
          }
        ],
        jump_list: [
          {
            type: 1,
            url: item.url || DASHBOARD_URL,
            title: "阅读原文"
          },
          {
            type: 1,
            url: `${DASHBOARD_URL}/?q=${encodeURIComponent(item.title)}&deep_ask=true`,
            title: "深度追问"
          },
          {
            type: 1,
            url: DASHBOARD_URL,
            title: item.bitv_action ? `建议: ${item.bitv_action}` : "查看情报看板"
          }
        ],
        card_action: {
          type: 1,
          url: `${DASHBOARD_URL}/?q=${encodeURIComponent(item.title)}&deep_ask=true`,
          appid: "",
          pagepath: ""
        }
      }
    };

    await axios.post(WECOM_WEBHOOK_URL, payload);
    console.log(`[WeCom] Sent (Card): ${item.title}`);
  } catch (err) {
    console.error('[WeCom Error]:', err.response?.data || err.message);
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
