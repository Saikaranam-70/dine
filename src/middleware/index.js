'use strict';

const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const slowDown   = require('express-slow-down');
const mongoSanitize = require('express-mongo-sanitize');
const helmet     = require('helmet');
const compression = require('compression');
const morgan     = require('morgan');
const { v4: uuidv4 } = require('uuid');

const { ApiResponse, AppError } = require('../utils/apiHelpers');
const { getCacheService, getRedisClient, CACHE_KEYS } = require('../config/redis');
const logger     = require('../utils/logger');

// ─── Security middleware stack ──────────────────────────────────────────────
const securityMiddleware = () => [
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc : ["'self'"],
        scriptSrc  : ["'self'", "'unsafe-inline'"],
        styleSrc   : ["'self'", "'unsafe-inline'"],
        imgSrc     : ["'self'", 'data:', 'https:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
  mongoSanitize({ replaceWith: '_' }),
  require('xss-clean')(),
  require('hpp')(),
];

// ─── Rate limiters ──────────────────────────────────────────────────────────
const createRateLimiter = (options = {}) => {
  const base = {
    windowMs        : options.windowMs || 15 * 60 * 1000,
    max             : options.max      || 100,
    standardHeaders : true,
    legacyHeaders   : false,
    skip            : () => process.env.NODE_ENV === 'test',
    handler(req, res) {
      logger.warn(`Rate limit hit: ${req.ip} → ${req.path}`);
      return res.status(429).json({
        success    : false,
        message    : options.message || 'Too many requests – please try again later.',
        retryAfter : Math.ceil((options.windowMs || 900000) / 1000),
      });
    },
  };

  const redisClient = getRedisClient();
  if (redisClient && redisClient.status === 'ready') {
    try {
      const { RedisStore } = require('rate-limit-redis');
      base.store = new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
      });
    } catch (_) { /* fall back to in-memory */ }
  }

  return rateLimit({ ...base, ...options });
};

const rateLimiters = {
  global  : createRateLimiter({ windowMs: 15 * 60 * 1000, max: 200 }),
  auth    : createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10,  message: 'Too many login attempts.' }),
  order   : createRateLimiter({ windowMs:  1 * 60 * 1000, max: 30  }),
  review  : createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5   }),
  menu    : createRateLimiter({ windowMs:  1 * 60 * 1000, max: 100 }),
  payment : createRateLimiter({ windowMs:  5 * 60 * 1000, max: 10  }),
};

const speedLimiter = slowDown({
  windowMs   : 15 * 60 * 1000,
  delayAfter : 50,
  delayMs    : (hits) => hits * 100,
  maxDelayMs : 5000,
});

// ─── Admin JWT auth ─────────────────────────────────────────────────────────
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return ApiResponse.unauthorized(res, 'No token provided');
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return ApiResponse.unauthorized(res, 'Token expired');
      return ApiResponse.unauthorized(res, 'Invalid token');
    }

    // Cache-aside for admin record
    const cache = getCacheService();
    const cacheKey = `admin:${decoded.id}`;
    let admin = await cache.get(cacheKey);

    if (!admin) {
      const { Admin } = require('../models/index');
      admin = await Admin.findById(decoded.id).select('-password -refreshToken').lean();
      if (!admin) return ApiResponse.unauthorized(res, 'Admin not found');
      await cache.set(cacheKey, admin, 300);
    }

    if (!admin.isActive) return ApiResponse.forbidden(res, 'Account deactivated');

    // Check account lock
    if (admin.lockUntil && new Date(admin.lockUntil) > new Date()) {
      return ApiResponse.forbidden(res, 'Account is temporarily locked');
    }

    req.admin       = admin;
    req.restaurantId = admin.restaurantId;
    next();
  } catch (err) {
    logger.error(`Auth middleware error: ${err.message}`);
    return ApiResponse.unauthorized(res, 'Authentication failed');
  }
};

// ─── Permission guard ────────────────────────────────────────────────────────
const requirePermission = (...permissions) => (req, res, next) => {
  if (!req.admin) return ApiResponse.unauthorized(res);

  if (['super_admin', 'restaurant_owner'].includes(req.admin.role)) return next();

  const hasAny = permissions.some(p => req.admin.permissions?.includes(p));
  if (!hasAny) return ApiResponse.forbidden(res, 'Insufficient permissions');
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.admin) return ApiResponse.unauthorized(res);
  if (!roles.includes(req.admin.role)) return ApiResponse.forbidden(res, 'Role not authorized');
  next();
};

// ─── Customer session auth ───────────────────────────────────────────────────
const authenticateSession = async (req, res, next) => {
  try {
    const sessionToken =
      req.headers['x-session-token'] ||
      req.query.sessionToken;

    if (!sessionToken) return ApiResponse.unauthorized(res, 'Session token required');

    const cache = getCacheService();
    const cacheKey = CACHE_KEYS.activeSession(sessionToken);
    let session = await cache.get(cacheKey);

    if (!session) {
      const { TableSession } = require('../models/index');
      session = await TableSession.findOne({ sessionToken, status: 'active' }).lean();
      if (!session) return ApiResponse.unauthorized(res, 'Invalid or expired session');
      await cache.set(cacheKey, session, 3600);
    }

    req.session      = session;
    req.restaurantId = session.restaurantId;
    req.tableId      = session.tableId;
    next();
  } catch (err) {
    logger.error(`Session middleware error: ${err.message}`);
    return ApiResponse.unauthorized(res, 'Session validation failed');
  }
};

// ─── Request context ─────────────────────────────────────────────────────────
const requestContext = (req, res, next) => {
  req.requestId = uuidv4();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.requestId);
  next();
};

// ─── Slow-request logger ──────────────────────────────────────────────────────
const responseTime = (req, res, next) => {
  res.on('finish', () => {
    const ms = Date.now() - (req.startTime || Date.now());
    if (ms > 1000) {
      logger.warn(`Slow: ${req.method} ${req.path} ${ms}ms [${res.statusCode}]`);
    }
  });
  next();
};

// ─── Global error handler ─────────────────────────────────────────────────────
const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message} | ${req.method} ${req.path} | ${req.ip}`, {
    stack     : err.stack,
    requestId : req.requestId,
  });

  // Mongoose cast error
  if (err.name === 'CastError') {
    return ApiResponse.notFound(res, `Invalid ${err.path}: ${err.value}`);
  }
  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return ApiResponse.error(res, `${field} already exists`, 400);
  }
  // Mongoose validation
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
    return ApiResponse.validationError(res, errors);
  }
  // JWT
  if (err.name === 'JsonWebTokenError')  return ApiResponse.unauthorized(res, 'Invalid token');
  if (err.name === 'TokenExpiredError')  return ApiResponse.unauthorized(res, 'Token expired');
  // Multer
  if (err.code === 'LIMIT_FILE_SIZE')    return ApiResponse.error(res, 'File too large', 400);
  // Operational
  if (err.isOperational) {
    return ApiResponse.error(res, err.message, err.statusCode, err.errors);
  }

  return ApiResponse.error(
    res,
    process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
  );
};

// ─── 404 handler ─────────────────────────────────────────────────────────────
const notFoundHandler = (req, res) =>
  ApiResponse.notFound(res, `Route ${req.method} ${req.originalUrl} not found`);

// ─── CORS options ─────────────────────────────────────────────────────────────
const corsOptions = {
  origin(origin, callback) {
    const allowed = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',');
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods        : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders : [
    'Content-Type', 'Authorization',
    'X-Session-Token', 'X-Restaurant-ID', 'X-Request-ID',
  ],
  exposedHeaders : ['X-Request-ID', 'X-Rate-Limit-Remaining'],
  credentials    : true,
  maxAge         : 86400,
};

module.exports = {
  securityMiddleware,
  rateLimiters,
  speedLimiter,
  authenticateAdmin,
  authenticateSession,
  requirePermission,
  requireRole,
  requestContext,
  responseTime,
  errorHandler,
  notFoundHandler,
  corsOptions,
};
