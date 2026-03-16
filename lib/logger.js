'use strict';

/**
 * 结构化日志模块
 * 基于 pino 的 JSON 格式日志，支持日志分级和结构化字段
 *
 * 使用方式:
 * const logger = require('./lib/logger');
 * logger.info({ source: 'Binance', count: 15 }, 'Scrape completed');
 * logger.error({ err }, 'Failed to process item');
 */

// 如果没有安装 pino，使用兼容的 fallback 实现
let logger;

try {
  const pino = require('pino');

  const isDev = process.env.NODE_ENV !== 'production';

  logger = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      pid: process.pid,
      env: process.env.NODE_ENV || 'development',
    },
    // 自定义序列化器
    serializers: {
      err: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });
} catch (e) {
  // Fallback: 使用 console 实现兼容接口
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[process.env.LOG_LEVEL] ?? 1;

  const formatLog = (level, obj, msg) => {
    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padStart(5);
    // Support both logger.info('msg') and logger.info({obj}, 'msg') calling conventions
    if (msg === undefined && typeof obj === 'string') {
      return `[${timestamp}] ${levelStr}: ${obj}`;
    }
    const meta = typeof obj === 'object' ? JSON.stringify(obj) : '';
    return `[${timestamp}] ${levelStr}: ${msg || ''} ${meta}`;
  };

  logger = {
    debug: (obj, msg) => {
      if (currentLevel <= 0) console.debug(formatLog('debug', obj, msg));
    },
    info: (obj, msg) => {
      if (currentLevel <= 1) console.info(formatLog('info', obj, msg));
    },
    warn: (obj, msg) => {
      if (currentLevel <= 2) console.warn(formatLog('warn', obj, msg));
    },
    error: (obj, msg) => {
      if (currentLevel <= 3) console.error(formatLog('error', obj, msg));
    },
    child: () => logger, // 简单实现，返回自身
  };
}

// 创建带上下文的子 logger
function createLogger(context = {}) {
  return logger.child(context);
}

module.exports = logger;
module.exports.createLogger = createLogger;
