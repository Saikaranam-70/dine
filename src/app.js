'use strict';

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');

const logger = require('./utils/logger');
const {
  securityMiddleware,
  rateLimiters,
  speedLimiter,
  requestContext,
  responseTime,
  errorHandler,
  notFoundHandler,
  corsOptions,
} = require('./middleware/index');

const {
  authRoutes,
  publicMenuRoutes,
  adminMenuRoutes,
  tablePublicRoutes,
  adminTableRoutes,
  orderCustomerRoutes,
  adminOrderRoutes,
  reviewCustomerRoutes,
  adminReviewRoutes,
  paymentRoutes,
  adminPaymentRoutes,
  adminAnalyticsRoutes,
  adminRestaurantRoutes,
  restaurantPublicRoutes,
  adminStaffRoutes,
  adminCouponRoutes,
  adminNotificationRoutes,
  billRoutes,
} = require('./routes/index');
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

const app = express();

app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1'));

securityMiddleware().forEach(m => app.use(m));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(compression({ level: 6, threshold: 1024 }));
app.use('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: logger.stream }));
}

app.use(requestContext);
app.use(responseTime);
app.use('/api/', rateLimiters.global);
app.use('/api/', speedLimiter);

app.get('/health', (req, res) => {
  const { getConnectedStats } = require('./services/socketService');
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    pid: process.pid,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    },
    sockets: getConnectedStats(),
    environment: process.env.NODE_ENV,
  });
});

app.get('/health/ready', async (req, res) => {
  const { getRedisClient } = require('./config/redis');
  const mongoose = require('mongoose');
  const checks = {
    mongodb: mongoose.connection.readyState === 1,
    redis: getRedisClient()?.status === 'ready',
  };
  const healthy = Object.values(checks).every(Boolean);
  res.status(healthy ? 200 : 503).json({ checks, healthy });
});

const A = '/api';

// Public
app.use(`${A}/admin/auth`,          authRoutes);
app.use(`${A}/tables`,              tablePublicRoutes);
app.use(`${A}/menu/:restaurantId`,  publicMenuRoutes);
app.use(`${A}/reviews`,             reviewCustomerRoutes);
app.use(`${A}/payments`,            paymentRoutes);
app.use(`${A}/bills`,               billRoutes);
app.use(`${A}/restaurants`,         restaurantPublicRoutes);

// Customer (session token)
app.use(`${A}/orders`,              orderCustomerRoutes);

// Admin (JWT)
app.use(`${A}/admin/menu`,          adminMenuRoutes);
app.use(`${A}/admin/tables`,        adminTableRoutes);
app.use(`${A}/admin/orders`,        adminOrderRoutes);
app.use(`${A}/admin/reviews`,       adminReviewRoutes);
app.use(`${A}/admin/analytics`,     adminAnalyticsRoutes);
app.use(`${A}/admin/restaurant`,    adminRestaurantRoutes);
app.use(`${A}/admin/staff`,         adminStaffRoutes);
app.use(`${A}/admin/coupons`,       adminCouponRoutes);
app.use(`${A}/admin/notifications`, adminNotificationRoutes);
app.use(`${A}/admin/payments`,      adminPaymentRoutes);

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/', (req, res) => {
  res.json({
    service: "Restaurant SaaS API",
    version: "1.0",
    api: "/api",
    docs: "/api/docs",
    health: "/health"
  });
});

app.use(notFoundHandler);
app.use(errorHandler);



module.exports = app;
