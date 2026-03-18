const jwt = require('jsonwebtoken');
const { getSubscriber, getPublisher } = require('../config/redis');
const logger = require('../utils/logger');

let io = null;

// Track connected rooms
const connectedAdmins = new Map(); // socketId -> { adminId, restaurantId, role }
const connectedCustomers = new Map(); // socketId -> { sessionToken, restaurantId, tableNumber }

const initSocket = (httpServer) => {
  const { Server } = require('socket.io');

  io = new Server(httpServer, {
    cors: {
      origin: (process.env.FRONTEND_URL || 'http://localhost:3000').split(','),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB
  });

  // ============================================
  // ADMIN NAMESPACE
  // ============================================
  const adminNs = io.of('/admin');

  adminNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET);
      socket.adminId = decoded.id;
      socket.restaurantId = decoded.restaurantId;
      socket.role = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  adminNs.on('connection', (socket) => {
    const { adminId, restaurantId, role } = socket;
    logger.info(`Admin connected: ${adminId} | Restaurant: ${restaurantId} | Socket: ${socket.id}`);

    connectedAdmins.set(socket.id, { adminId, restaurantId, role });

    // Join restaurant room
    socket.join(`restaurant:${restaurantId}`);
    socket.join(`restaurant:${restaurantId}:admins`);

    // Kitchen staff join kitchen room
    if (role === 'kitchen_staff') {
      socket.join(`restaurant:${restaurantId}:kitchen`);
    }

    // Send connection ack
    socket.emit('connected', { message: 'Connected to admin dashboard', restaurantId });

    // ---- Admin events ----

    // Admin joins a specific table channel to monitor
    socket.on('watch:table', (tableId) => {
      socket.join(`restaurant:${restaurantId}:table:${tableId}`);
    });

    // Admin marks order as seen
    socket.on('order:seen', async (orderId) => {
      try {
        const { Notification } = require('../models');
        await Notification.updateMany(
          { restaurantId, 'data.orderId': orderId },
          { isRead: true }
        );
      } catch (err) {
        logger.error(`Socket order:seen error: ${err.message}`);
      }
    });

    // KDS: Update item status from kitchen
    socket.on('kds:item:update', async ({ ticketId, itemIndex, status }) => {
      try {
        const { KDSTicket } = require('../models');
        await KDSTicket.updateOne(
          { _id: ticketId, restaurantId },
          { $set: { [`items.${itemIndex}.status`]: status } }
        );
        adminNs.to(`restaurant:${restaurantId}:kitchen`).emit('kds:item:updated', {
          ticketId, itemIndex, status
        });
      } catch (err) {
        logger.error(`KDS update error: ${err.message}`);
      }
    });

    // Ping/pong keep-alive
    socket.on('ping', () => socket.emit('pong', { timestamp: Date.now() }));

    socket.on('disconnect', (reason) => {
      connectedAdmins.delete(socket.id);
      logger.info(`Admin disconnected: ${adminId} | Reason: ${reason}`);
    });

    socket.on('error', (err) => {
      logger.error(`Admin socket error: ${err.message}`);
    });
  });

  // ============================================
  // CUSTOMER NAMESPACE
  // ============================================
  const customerNs = io.of('/customer');

  customerNs.use(async (socket, next) => {
    try {
      const sessionToken = socket.handshake.auth?.sessionToken || socket.handshake.query?.sessionToken;
      if (!sessionToken) return next(new Error('Session token required'));

      const { TableSession } = require('../models');
      const session = await TableSession.findOne({ sessionToken, status: 'active' });
      if (!session) return next(new Error('Invalid session'));

      socket.sessionToken = sessionToken;
      socket.sessionId = session._id;
      socket.restaurantId = session.restaurantId;
      socket.tableNumber = session.tableNumber;
      socket.tableId = session.tableId;
      next();
    } catch (err) {
      next(new Error('Session validation failed'));
    }
  });

  customerNs.on('connection', (socket) => {
    logger.info(`Customer connected: Table ${socket.tableNumber} | Restaurant: ${socket.restaurantId}`);
    connectedCustomers.set(socket.id, {
      sessionToken: socket.sessionToken,
      restaurantId: socket.restaurantId.toString(),
      tableNumber: socket.tableNumber,
    });

    socket.join(`session:${socket.sessionId}`);
    socket.join(`restaurant:${socket.restaurantId}:table:${socket.tableId}`);

    socket.emit('connected', {
      message: 'Connected! You can now receive live order updates.',
      tableNumber: socket.tableNumber,
    });

    socket.on('ping', () => socket.emit('pong', { timestamp: Date.now() }));

    socket.on('disconnect', () => {
      connectedCustomers.delete(socket.id);
    });
  });

  // ============================================
  // REDIS PUB/SUB → SOCKET.IO BRIDGE
  // ============================================
  setupRedisBridge(adminNs, customerNs);

  logger.info('Socket.IO initialized with /admin and /customer namespaces');
  return io;
};

const setupRedisBridge = (adminNs, customerNs) => {
  const subscriber = getSubscriber();
  if (!subscriber) {
    logger.warn('Redis subscriber not available — real-time pub/sub disabled');
    return;
  }

  // Subscribe to all restaurant channels
  subscriber.psubscribe('restaurant:*', (err) => {
    if (err) logger.error(`Redis subscribe error: ${err.message}`);
    else logger.info('Redis: Subscribed to restaurant:* channels');
  });

  subscriber.on('pmessage', (pattern, channel, message) => {
    try {
      const data = JSON.parse(message);
      const parts = channel.split(':');
      const restaurantId = parts[1];
      const channelType = parts[2]; // orders, kitchen, tables, payments, notifications

      switch (channelType) {
        case 'orders':
          // Notify admin dashboard
          adminNs.to(`restaurant:${restaurantId}`).emit(`orders:${data.type}`, data);

          // Notify specific customer session
          if (data.sessionId) {
            customerNs.to(`session:${data.sessionId}`).emit('order:update', data);
          }
          break;

        case 'kitchen':
          adminNs.to(`restaurant:${restaurantId}:kitchen`).emit(`kitchen:${data.type}`, data);
          adminNs.to(`restaurant:${restaurantId}`).emit(`kitchen:${data.type}`, data);
          break;

        case 'tables':
          adminNs.to(`restaurant:${restaurantId}`).emit(`table:${data.type}`, data);
          break;

        case 'payments':
          adminNs.to(`restaurant:${restaurantId}`).emit(`payment:${data.type}`, data);
          if (data.tableId) {
            customerNs.to(`restaurant:${restaurantId}:table:${data.tableId}`).emit('payment:update', data);
          }
          break;

        case 'notifications':
          adminNs.to(`restaurant:${restaurantId}`).emit('notification', data);
          // Waiter call — broadcast to table channel for customer feedback too
          if (data.type === 'WAITER_CALLED') {
            customerNs.to(`restaurant:${restaurantId}:table:${data.tableId}`).emit('waiter:acknowledged', {
              message: 'Staff has been notified!',
            });
          }
          break;
      }
    } catch (err) {
      logger.error(`Redis message parse error: ${err.message}`);
    }
  });
};

// ============================================
// EMIT HELPERS (call from controllers)
// ============================================
const emitToRestaurant = (restaurantId, event, data) => {
  if (!io) return;
  io.of('/admin').to(`restaurant:${restaurantId}`).emit(event, data);
};

const emitToSession = (sessionId, event, data) => {
  if (!io) return;
  io.of('/customer').to(`session:${sessionId}`).emit(event, data);
};

const emitToKitchen = (restaurantId, event, data) => {
  if (!io) return;
  io.of('/admin').to(`restaurant:${restaurantId}:kitchen`).emit(event, data);
};

const getConnectedStats = () => ({
  admins: connectedAdmins.size,
  customers: connectedCustomers.size,
  total: connectedAdmins.size + connectedCustomers.size,
});

module.exports = {
  initSocket,
  emitToRestaurant,
  emitToSession,
  emitToKitchen,
  getConnectedStats,
  getIO: () => io,
};
