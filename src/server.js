'use strict';

require('dotenv').config();

const http = require('http');
const app  = require('./app');

const connectDB    = require('./config/database');
const { connectRedis } = require('./config/redis');
const { initSocket }   = require('./services/socketService');
const { initQueues }   = require('./workers/queueWorker');
const logger           = require('./utils/logger');

const PORT = parseInt(process.env.PORT || '5000', 10);

// ─── Unhandled errors ────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason });
  process.exit(1);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
const gracefulShutdown = (server) => async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);

  server.close(async () => {
    try {
      const mongoose = require('mongoose');
      await mongoose.connection.close();
      logger.info('MongoDB closed');

      const { getRedisClient, getPublisher, getSubscriber } = require('./config/redis');
      const clients = [getRedisClient(), getPublisher(), getSubscriber()].filter(Boolean);
      await Promise.all(clients.map(c => c.quit().catch(() => {})));
      logger.info('Redis closed');
    } catch (e) {
      logger.error(`Shutdown error: ${e.message}`);
    }

    logger.info('Shutdown complete');
    process.exit(0);
  });

  // Force after 30s
  setTimeout(() => { logger.error('Forced exit'); process.exit(1); }, 30_000);
};

// ─── Bootstrap ───────────────────────────────────────────────────────────────
const bootstrap = async () => {
  logger.info(`Starting server [PID: ${process.pid}] [ENV: ${process.env.NODE_ENV || 'development'}]`);

  await connectDB();
  await connectRedis();

  const server = http.createServer(app);
  initSocket(server);
  initQueues();

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`✅  Server listening on port ${PORT}`);
    logger.info(`📋  API  → http://localhost:${PORT}/api`);
    logger.info(`💚  Health → http://localhost:${PORT}/health`);
    if (process.env.NODE_ENV !== 'production') {
      logger.info(`📖  Docs → http://localhost:${PORT}/api/docs`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} already in use`);
    } else {
      logger.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  ['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach(sig =>
    process.on(sig, gracefulShutdown(server))
  );
};

bootstrap();
