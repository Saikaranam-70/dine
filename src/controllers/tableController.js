const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { Table, TableSession, Order } = require('../models');
const { ApiResponse, asyncHandler, getPagination } = require('../utils/apiHelpers');
const { getCacheService, CACHE_KEYS, TTL } = require('../config/redis');
const logger = require('../utils/logger');

// ============================================
// QR SCAN + SESSION CREATE (Customer entry)
// ============================================
exports.scanQR = asyncHandler(async (req, res) => {
  const { token } = req.params; // QR token embedded in QR code URL

  const table = await Table.findOne({
    'qrCode.token': token,
    isActive: true,
  }).populate('restaurantId', 'name logo settings isActive');

  if (!table) return ApiResponse.notFound(res, 'Invalid QR code');
  if (!table.restaurantId?.isActive) return ApiResponse.error(res, 'Restaurant is not active', 400);

  // Check if table has active session
  if (table.currentSessionId) {
    const existingSession = await TableSession.findOne({
      _id: table.currentSessionId,
      status: 'active',
    });
    if (existingSession) {
      return ApiResponse.success(res, {
        sessionToken: existingSession.sessionToken,
        table: {
          id: table._id,
          tableNumber: table.tableNumber,
          displayName: table.displayName,
          capacity: table.capacity,
          section: table.section,
        },
        restaurant: table.restaurantId,
        isExistingSession: true,
      }, 'Joined existing session');
    }
  }

  // Create new session
  const sessionToken = uuidv4();
  const session = await TableSession.create({
    restaurantId: table.restaurantId._id,
    tableId: table._id,
    tableNumber: table.tableNumber,
    sessionToken,
  });

  await Table.findByIdAndUpdate(table._id, {
    status: 'occupied',
    currentSessionId: session._id,
  });

  return ApiResponse.success(res, {
    sessionToken,
    table: {
      id: table._id,
      tableNumber: table.tableNumber,
      displayName: table.displayName,
      capacity: table.capacity,
      section: table.section,
    },
    restaurant: table.restaurantId,
    isExistingSession: false,
  }, 'Session started');
});

// ============================================
// UPDATE SESSION DETAILS (customer name, guests)
// ============================================
exports.updateSession = asyncHandler(async (req, res) => {
  const { customerName, customerPhone, guestCount } = req.body;

  const session = await TableSession.findByIdAndUpdate(
    req.session._id,
    { $set: { customerName, customerPhone, guestCount } },
    { new: true }
  );

  // Invalidate session cache
  const cache = getCacheService();
  await cache.del(CACHE_KEYS.activeSession(req.session.sessionToken));

  return ApiResponse.success(res, { session }, 'Session updated');
});

// ============================================
// GET SESSION SUMMARY (for checkout)
// ============================================
exports.getSessionSummary = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    sessionId: req.session._id,
    status: { $nin: ['cancelled'] },
  }).lean();

  const totalAmount = orders.reduce((sum, o) => sum + (o.pricing?.grandTotal || 0), 0);
  const paidAmount = orders
    .filter(o => o.payment?.status === 'paid')
    .reduce((sum, o) => sum + (o.pricing?.grandTotal || 0), 0);

  return ApiResponse.success(res, {
    session: req.session,
    orders,
    summary: {
      totalOrders: orders.length,
      totalAmount,
      paidAmount,
      dueAmount: totalAmount - paidAmount,
      isPaid: paidAmount >= totalAmount,
    },
  });
});

// ============================================
// REQUEST BILL (customer action)
// ============================================
exports.requestBill = asyncHandler(async (req, res) => {
  const { paymentPreference } = req.body;

  await TableSession.findByIdAndUpdate(req.session._id, {
    status: 'waiting_payment',
    notes: paymentPreference ? `Payment preference: ${paymentPreference}` : undefined,
  });

  // Notify admin
  const { getPublisher } = require('../config/redis');
  const publisher = getPublisher();
  if (publisher) {
    publisher.publish(`restaurant:${req.restaurantId}:tables`, JSON.stringify({
      type: 'BILL_REQUESTED',
      tableNumber: req.session.tableNumber,
      sessionId: req.session._id,
      paymentPreference,
    })).catch(() => {});
  }

  return ApiResponse.success(res, {}, 'Bill requested. Staff will be with you shortly.');
});

// ============================================
// CALL WAITER (customer action)
// ============================================
exports.callWaiter = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const publisher = getPublisher();
  if (publisher) {
    publisher.publish(`restaurant:${req.restaurantId}:notifications`, JSON.stringify({
      type: 'WAITER_CALLED',
      tableNumber: req.session.tableNumber,
      tableId: req.tableId,
      reason: reason || 'General assistance',
      timestamp: new Date(),
    })).catch(() => {});
  }

  return ApiResponse.success(res, {}, 'Waiter notified!');
});

// ============================================
// ADMIN - GET ALL TABLES
// ============================================
exports.adminGetTables = asyncHandler(async (req, res) => {
  const cache = getCacheService();
  const cacheKey = CACHE_KEYS.restaurantTables(req.restaurantId);

  const tables = await cache.getOrSet(cacheKey, async () => {
    return Table.find({ restaurantId: req.restaurantId, isActive: true })
      .sort({ tableNumber: 1 })
      .lean();
  }, 300);

  // Attach active session counts
  const activeSessions = await TableSession.find({
    restaurantId: req.restaurantId,
    status: 'active',
    tableId: { $in: tables.map(t => t._id) },
  }).lean();

  const sessionMap = {};
  activeSessions.forEach(s => { sessionMap[s.tableId.toString()] = s; });

  const tablesWithStatus = tables.map(t => ({
    ...t,
    activeSession: sessionMap[t._id.toString()] || null,
  }));

  return ApiResponse.success(res, { tables: tablesWithStatus });
});

// ============================================
// ADMIN - CREATE TABLE
// ============================================
exports.createTable = asyncHandler(async (req, res) => {
  const { tableNumber, displayName, capacity, section } = req.body;

  const existing = await Table.findOne({ restaurantId: req.restaurantId, tableNumber });
  if (existing) return ApiResponse.error(res, 'Table number already exists', 400);

  const qrToken = uuidv4();
  const qrBaseUrl = process.env.QR_BASE_URL || 'https://dine-1l6m.onrender.com';
  const qrUrl = `${qrBaseUrl}/scan/${qrToken}`;
  console.log("QR_BASE_URL:", process.env.QR_BASE_URL);
  const qrImage = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: 'H',
    type: 'image/png',
    quality: 0.92,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
    width: 400,
  });

  const table = await Table.create({
    restaurantId: req.restaurantId,
    tableNumber, displayName, capacity, section,
    qrCode: { url: qrUrl, image: qrImage, generatedAt: new Date(), token: qrToken },
  });

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.restaurantTables(req.restaurantId));

  return ApiResponse.created(res, { table }, 'Table created with QR code');
});

// ============================================
// ADMIN - REGENERATE QR
// ============================================
exports.regenerateQR = asyncHandler(async (req, res) => {
  const table = await Table.findOne({ _id: req.params.tableId, restaurantId: req.restaurantId });
  if (!table) return ApiResponse.notFound(res, 'Table not found');

  const qrToken = uuidv4();
  const qrBaseUrl = process.env.QR_BASE_URL || 'https://dine-1l6m.onrender.com';
  const qrUrl = `${qrBaseUrl}/scan/${qrToken}`;
  const qrImage = await QRCode.toDataURL(qrUrl, { width: 400, margin: 2 });

  // Invalidate old token cache
  const cache = getCacheService();
  await cache.del(CACHE_KEYS.qrCode(table._id.toString()));

  table.qrCode = { url: qrUrl, image: qrImage, generatedAt: new Date(), token: qrToken };
  await table.save();

  return ApiResponse.success(res, { table }, 'QR code regenerated');
});

// ============================================
// ADMIN - UPDATE TABLE
// ============================================
exports.updateTable = asyncHandler(async (req, res) => {
  const table = await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurantId },
    { $set: req.body },
    { new: true }
  );
  if (!table) return ApiResponse.notFound(res, 'Table not found');

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.restaurantTables(req.restaurantId));

  return ApiResponse.success(res, { table }, 'Table updated');
});

// ============================================
// ADMIN - DELETE TABLE
// ============================================
exports.deleteTable = asyncHandler(async (req, res) => {
  const activeOrders = await Order.countDocuments({
    tableId: req.params.tableId,
    status: { $in: ['placed', 'confirmed', 'preparing', 'ready'] },
  });
  if (activeOrders > 0) {
    return ApiResponse.error(res, 'Cannot delete table with active orders', 400);
  }

  await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurantId },
    { isActive: false }
  );

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.restaurantTables(req.restaurantId));

  return ApiResponse.success(res, {}, 'Table deleted');
});

// ============================================
// ADMIN - CLOSE SESSION
// ============================================
exports.closeSession = asyncHandler(async (req, res) => {
  const session = await TableSession.findOne({
    _id: req.params.sessionId,
    restaurantId: req.restaurantId,
  });

  if (!session) return ApiResponse.notFound(res, 'Session not found');

  session.status = 'closed';
  session.closedAt = new Date();
  await session.save();

  await Table.findByIdAndUpdate(session.tableId, {
    status: 'available',
    currentSessionId: null,
    $inc: { totalOrdersServed: 1, totalRevenue: session.totalAmount },
  });

  // Invalidate table cache
  const cache = getCacheService();
  await cache.del(CACHE_KEYS.restaurantTables(req.restaurantId));
  await cache.del(CACHE_KEYS.activeSession(session.sessionToken));

  return ApiResponse.success(res, {}, 'Table session closed');
});

// ============================================
// ADMIN - GET ALL SESSIONS
// ============================================
exports.getSessions = asyncHandler(async (req, res) => {
  const { status, dateFrom, dateTo } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const query = { restaurantId: req.restaurantId };
  if (status) query.status = status;
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  const [sessions, total] = await Promise.all([
    TableSession.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    TableSession.countDocuments(query),
  ]);

  return ApiResponse.paginated(res, { sessions }, { page, limit, total });
});
