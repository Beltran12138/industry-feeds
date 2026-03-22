'use strict';

/**
 * monitoring/source-health.js — 数据源健康监控器
 *
 * 职责：
 *   1. 跟踪每个数据源的最后抓取时间、今日条数
 *   2. 检测数据源是否"断了"（超过 N 小时无新数据）
 *   3. 在前端 Dashboard 展示健康状态表格
 *   4. 当连续 N 个 cron 周期无新数据时，推送告警到 WeCom/Telegram
 */

const fs = require('fs');
const path = require('path');
const { newsDAO } = require('../dao');
const { pushManager } = require('../push-channel');
const { SOURCE_CONFIGS, HIGH_FREQ_SOURCES, LOW_FREQ_SOURCES } = require('../config');

// ── 配置 ─────────────────────────────────────────────────────────────────────
const HEALTH_CONFIG = {
  // 数据源健康状态文件路径
  STATE_FILE: path.join(__dirname, 'source-health-state.json'),

  // 告警阈值（小时）
  ALERT_THRESHOLD_HIGH_FREQ: 2,    // 高频源：2 小时无数据告警
  ALERT_THRESHOLD_LOW_FREQ: 8,     // 低频源：8 小时无数据告警

  // 连续无数据周期数告警
  CONSECUTIVE_EMPTY_CYCLES: 3,     // 连续 3 个周期无数据则告警

  // 数据保留天数
  HISTORY_RETENTION_DAYS: 7,
};

// ── 健康状态类 ───────────────────────────────────────────────────────────────
class SourceHealthMonitor {
  constructor() {
    this.stateFile = HEALTH_CONFIG.STATE_FILE;
    this.state = this.loadState();
    this.alertHistory = new Map(); // source -> lastAlertTime
  }

  /**
   * 加载历史状态
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        // 清理旧数据
        const cutoff = Date.now() - HEALTH_CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        for (const source of Object.keys(data)) {
          if (data[source].history) {
            data[source].history = data[source].history.filter(h => h.timestamp > cutoff);
          }
        }
        return data;
      }
    } catch (err) {
      console.error('[SourceHealth] Failed to load state:', err.message);
    }
    return {};
  }

  /**
   * 保存状态到文件
   */
  saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.error('[SourceHealth] Failed to save state:', err.message);
    }
  }

  /**
   * 记录抓取结果
   * @param {string} source - 数据源名称
   * @param {number} itemCount - 本次抓取的条目数
   * @param {boolean} hasError - 是否发生错误
   */
  recordFetch(source, itemCount, hasError = false) {
    const now = Date.now();

    if (!this.state[source]) {
      this.state[source] = {
        lastFetchTime: now,
        lastItemCount: itemCount,
        todayCount: itemCount,
        todayDate: new Date().toDateString(),
        consecutiveEmptyCycles: itemCount === 0 ? 1 : 0,
        totalFetches: 1,
        totalErrors: hasError ? 1 : 0,
        status: hasError ? 'error' : (itemCount > 0 ? 'healthy' : 'empty'),
        history: [],
      };
    } else {
      const s = this.state[source];

      // 检查是否是新的一天
      const today = new Date().toDateString();
      if (s.todayDate !== today) {
        // 归档前一天数据到历史
        s.history.push({
          date: s.todayDate,
          totalCount: s.todayCount,
          fetchCount: s.totalFetches,
          errorCount: s.totalErrors,
          timestamp: now,
        });
        // 重置今日计数
        s.todayCount = itemCount;
        s.todayDate = today;
        s.totalFetches = 1;
        s.totalErrors = hasError ? 1 : 0;
      } else {
        s.todayCount += itemCount;
        s.totalFetches++;
        if (hasError) s.totalErrors++;
      }

      s.lastFetchTime = now;
      s.lastItemCount = itemCount;
      s.consecutiveEmptyCycles = itemCount === 0 ? s.consecutiveEmptyCycles + 1 : 0;
      s.status = hasError ? 'error' : (itemCount > 0 ? 'healthy' : 'empty');
    }

    this.saveState();
    console.log(`[SourceHealth] ${source}: ${itemCount} items, status=${this.state[source].status}`);
  }

  /**
   * 获取数据源的告警阈值（小时）
   */
  getAlertThreshold(source) {
    if (HIGH_FREQ_SOURCES.includes(source)) {
      return HEALTH_CONFIG.ALERT_THRESHOLD_HIGH_FREQ;
    }
    if (LOW_FREQ_SOURCES.includes(source)) {
      return HEALTH_CONFIG.ALERT_THRESHOLD_LOW_FREQ;
    }
    // 默认 4 小时
    return 4;
  }

  /**
   * 检查所有数据源的健康状态并触发告警
   */
  async checkHealthAndAlert() {
    console.log('[SourceHealth] Checking health and alerting...');

    const now = Date.now();
    const alerts = [];

    for (const [source, data] of Object.entries(this.state)) {
      const hoursSinceFetch = (now - data.lastFetchTime) / (1000 * 60 * 60);
      const threshold = this.getAlertThreshold(source);

      // 检查 1: 超过阈值时间无抓取
      if (hoursSinceFetch > threshold && data.status !== 'error') {
        const alertKey = `${source}:timeout`;
        if (this.shouldAlert(alertKey)) {
          alerts.push({
            type: 'timeout',
            source,
            message: `超过${threshold}小时无新数据`,
            details: `最后抓取：${this.formatTime(data.lastFetchTime)} (${Math.floor(hoursSinceFetch)}小时前)`,
          });
        }
      }

      // 检查 2: 连续空周期
      if (data.consecutiveEmptyCycles >= HEALTH_CONFIG.CONSECUTIVE_EMPTY_CYCLES) {
        const alertKey = `${source}:empty`;
        if (this.shouldAlert(alertKey)) {
          alerts.push({
            type: 'empty',
            source,
            message: `连续${data.consecutiveEmptyCycles}次抓取无新数据`,
            details: `今日已抓取${data.totalFetches}次，共${data.todayCount}条`,
          });
        }
      }

      // 检查 3: 抓取错误
      if (data.status === 'error' && data.totalErrors >= 3) {
        const alertKey = `${source}:error`;
        if (this.shouldAlert(alertKey)) {
          alerts.push({
            type: 'error',
            source,
            message: `连续抓取失败${data.totalErrors}次`,
            details: `最近一次：${this.formatTime(data.lastFetchTime)}`,
          });
        }
      }
    }

    // 发送告警
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }

    return alerts;
  }

  /**
   * 判断是否应该发送告警（避免重复）
   */
  shouldAlert(alertKey) {
    const lastAlert = this.alertHistory.get(alertKey) || 0;
    const cooldownMs = 4 * 60 * 60 * 1000; // 4 小时冷却
    return Date.now() - lastAlert > cooldownMs;
  }

  /**
   * 发送告警消息
   */
  async sendAlert(alert) {
    // 数据源告警推送已禁用，仅记录日志
    console.log(`[SourceHealth] Alert (push disabled): ${alert.source} — ${alert.message}`);
    this.alertHistory.set(`${alert.source}:${alert.type}`, Date.now());
  }

  /**
   * 获取所有数据源的健康状态（供前端 API 使用）
   */
  getHealthStatus() {
    const now = Date.now();
    const status = [];

    // 获取所有已知数据源
    const allSources = new Set([
      ...Object.keys(this.state),
      ...Object.keys(SOURCE_CONFIGS),
    ]);

    for (const source of allSources) {
      const data = this.state[source] || {};
      const hoursSinceFetch = data.lastFetchTime ? (now - data.lastFetchTime) / (1000 * 60 * 60) : null;
      const threshold = this.getAlertThreshold(source);

      let healthStatus = 'unknown';
      if (!data.lastFetchTime) {
        healthStatus = 'never';
      } else if (hoursSinceFetch > threshold) {
        healthStatus = 'critical';
      } else if (data.consecutiveEmptyCycles >= HEALTH_CONFIG.CONSECUTIVE_EMPTY_CYCLES) {
        healthStatus = 'warning';
      } else if (data.status === 'error') {
        healthStatus = 'error';
      } else if (data.status === 'empty') {
        healthStatus = 'empty';
      } else {
        healthStatus = 'healthy';
      }

      status.push({
        source,
        lastFetchTime: data.lastFetchTime ? this.formatTime(data.lastFetchTime) : '从未',
        hoursSinceFetch: hoursSinceFetch !== null ? Math.floor(hoursSinceFetch * 10) / 10 : null,
        todayCount: data.todayCount || 0,
        totalFetches: data.totalFetches || 0,
        totalErrors: data.totalErrors || 0,
        consecutiveEmptyCycles: data.consecutiveEmptyCycles || 0,
        status: healthStatus,
        statusText: this.getStatusText(healthStatus),
      });
    }

    // 按状态排序：critical > error > warning > empty > healthy > unknown
    const statusOrder = { critical: 0, error: 1, warning: 2, empty: 3, healthy: 4, unknown: 5, never: 6 };
    status.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return status;
  }

  /**
   * 获取单个数据源的详细统计
   */
  getSourceDetail(source) {
    const data = this.state[source];
    if (!data) return null;

    return {
      source,
      lastFetchTime: this.formatTime(data.lastFetchTime),
      lastItemCount: data.lastItemCount,
      todayCount: data.todayCount,
      totalFetches: data.totalFetches,
      totalErrors: data.totalErrors,
      errorRate: data.totalFetches > 0 ? ((data.totalErrors / data.totalFetches) * 100).toFixed(1) + '%' : '0%',
      consecutiveEmptyCycles: data.consecutiveEmptyCycles,
      history: data.history.slice(-7), // 最近 7 天
    };
  }

  /**
   * 格式化时间
   */
  formatTime(timestamp) {
    if (!timestamp) return '从未';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * 获取状态文本
   */
  getStatusText(status) {
    const texts = {
      healthy: '✅ 正常',
      warning: '⚠️ 警告',
      critical: '🔴 严重',
      error: '❌ 错误',
      empty: '🟡 无数据',
      unknown: '❓ 未知',
      never: '⚪ 未抓取',
    };
    return texts[status] || status;
  }

  /**
   * 重置指定数据源的状态
   */
  resetSource(source) {
    if (this.state[source]) {
      delete this.state[source];
      this.saveState();
      console.log(`[SourceHealth] Reset state for ${source}`);
    }
  }

  /**
   * 导出统计数据（用于报告）
   */
  exportStats(days = 7) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stats = {};

    for (const [source, data] of Object.entries(this.state)) {
      const history = data.history?.filter(h => h.timestamp > cutoff) || [];
      stats[source] = {
        totalItems: history.reduce((sum, h) => sum + h.totalCount, 0) + data.todayCount,
        totalFetches: history.reduce((sum, h) => sum + h.fetchCount, 0) + data.totalFetches,
        totalErrors: history.reduce((sum, h) => sum + h.errorCount, 0) + data.totalErrors,
        avgItemsPerFetch: history.length > 0
          ? (history.reduce((sum, h) => sum + h.totalCount, 0) / history.length).toFixed(1)
          : (data.todayCount / data.totalFetches).toFixed(1),
      };
    }

    return stats;
  }
}

// ── 导出单例 ─────────────────────────────────────────────────────────────────
const sourceHealthMonitor = new SourceHealthMonitor();

module.exports = {
  sourceHealthMonitor,
  SourceHealthMonitor,
  HEALTH_CONFIG,
};
