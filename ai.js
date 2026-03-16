'use strict';
/**
 * ai.js — 向后兼容的薄封装层
 *
 * 所有 AI 处理逻辑已迁移至 ai-enhanced.js（多提供商降级版本）。
 * 本文件仅保留 aiCostTracker（成本追踪，ai-enhanced 未包含）并
 * 重新导出 ai-enhanced.js 的全部接口，确保现有 require('./ai') 的调用方无需改动。
 */

const { AI_COST } = require('./config');

// ── AI 成本追踪（仅此文件独有）────────────────────────────────────────────────
const aiCostTracker = {
  dailyTokens: 0,
  dailyCostUSD: 0,
  lastResetDate: new Date().toDateString(),
  totalCalls: 0,
  alertSent: false,

  reset() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyTokens = 0;
      this.dailyCostUSD = 0;
      this.lastResetDate = today;
      this.alertSent = false;
    }
  },

  track(tokens) {
    this.reset();
    this.dailyTokens += tokens;
    this.dailyCostUSD = (this.dailyTokens / 1000) * (AI_COST?.COST_PER_1K_TOKENS || 0.001);
    this.totalCalls++;

    // Alert if approaching budget
    const budget = AI_COST?.DAILY_BUDGET_USD || 10;
    const threshold = AI_COST?.ALERT_THRESHOLD || 0.8;
    if (!this.alertSent && this.dailyCostUSD >= budget * threshold) {
      console.warn(`[AI COST] WARNING: Daily cost $${this.dailyCostUSD.toFixed(4)} approaching budget $${budget} (${(this.dailyCostUSD / budget * 100).toFixed(1)}%)`);
      this.alertSent = true;
    }
  },

  isOverBudget() {
    this.reset();
    const budget = AI_COST?.DAILY_BUDGET_USD || 10;
    return this.dailyCostUSD >= budget;
  },

  getStatus() {
    this.reset();
    const budget = AI_COST?.DAILY_BUDGET_USD || 10;
    return {
      dailyTokens: this.dailyTokens,
      dailyCostUSD: this.dailyCostUSD.toFixed(4),
      budgetUSD: budget,
      budgetUsedPercent: (this.dailyCostUSD / budget * 100).toFixed(1),
      totalCalls: this.totalCalls,
      isOverBudget: this.dailyCostUSD >= budget,
    };
  },
};

// ── 从 ai-enhanced.js 重新导出所有接口 ───────────────────────────────────────
const enhanced = require('./ai-enhanced');

module.exports = {
  // ai-enhanced.js 的全部导出
  processWithAI:        enhanced.processWithAI,
  batchClassify:        enhanced.batchClassify,
  generateDailySummary: enhanced.generateDailySummary,
  generateWeeklySummary: enhanced.generateWeeklySummary,
  getAIStatus:          enhanced.getAIStatus,
  ruleEngine:           enhanced.ruleEngine,
  callAI:               enhanced.callAI,

  // 本文件独有
  aiCostTracker,
};
