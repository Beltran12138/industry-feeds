'use strict';

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

function applySecurity(app) {
  // 1. 安全头
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));

  // 2. CORS
  const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  
  app.use(cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
  }));

  // 3. 全局限流 (100req/15min)
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later' }
  });
  app.use(globalLimiter);

  // 4. 写操作限流 (10req/min) - 保护刷新/报告接口
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many write requests, please slow down' }
  });
  app.use('/api/refresh', writeLimiter);
  app.use('/api/daily-report', writeLimiter);
  app.use('/api/weekly-report', writeLimiter);
  app.use('/api/cleanup', writeLimiter);

  return app;
}

module.exports = { applySecurity };
