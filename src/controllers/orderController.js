const { v4: uuidv4 } = require('uuid');
const { Order, Product, Restaurant, Table, TableSession, KDSTicket, Notification } = require('../models');
const { ApiResponse, asyncHandler, getPagination, buildSortQuery, AppError } = require('../utils/apiHelpers');
const { getCacheService, CACHE_KEYS, TTL } = require('../config/redis');
const { getPublisher } = require('../config/redis');
const { generateOrderNumber, calculatePricing, notifyKitchen } = require('../services/orderService');
const { generateBill } = require('../services/billService');
const logger = require('../utils/logger');

// ============================================
// CUSTOMER - PLACE ORDER
// ============================================
exports.placeOrder = asyncHandler(async (req, res) => {
  const { items, specialInstructions, customerName, customerPhone, guestCount, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return ApiResponse.error(res, 'Order must have at least one item', 400);
  }

  // Get restaurant settings
  const restaurant = await Restaurant.findById(req.restaurantId).lean();
  if (!restaurant || !restaurant.isActive) {
    return ApiResponse.error(res, 'Restaurant not found or inactive', 400);
  }

  // Validate and enrich items
  const productIds = items.map(i => i.productId);
  const products = await Product.find({
    _id: { $in: productIds },
    restaurantId: req.restaurantId,
    isActive: true,
  }).lean();

  const productMap = {};
  products.forEach(p => { productMap[p._id.toString()] = p; });

  const enrichedItems = [];
  for (const item of items) {
    const product = productMap[item.productId];
    if (!product) return ApiResponse.error(res, `Product ${item.productId} not found`, 400);
    if (!product.isAvailable) return ApiResponse.error(res, `${product.name} is not available`, 400);
    if (product.stockManagement?.enabled && product.stockManagement.outOfStock) {
      return ApiResponse.error(res, `${product.name} is out of stock`, 400);
    }

    const unitPrice = product.discountedPrice || product.price;
    let addOnTotal = 0;
    let variantTotal = 0;

    // Calculate add-on prices
    const selectedAddOns = [];
    if (item.selectedAddOns?.length > 0) {
      for (const addOnSel of item.selectedAddOns) {
        const addOnDef = product.addOns?.find(a => a.name === addOnSel.name);
        if (addOnDef) {
          let addOnPrice = 0;
          const selectedOptions = [];
          for (const optLabel of addOnSel.selected) {
            const opt = addOnDef.options.find(o => o.label === optLabel);
            if (opt) { addOnPrice += opt.price; selectedOptions.push(optLabel); }
          }
          addOnTotal += addOnPrice;
          selectedAddOns.push({ name: addOnSel.name, selected: selectedOptions, price: addOnPrice });
        }
      }
    }

    // Calculate variant prices
    const selectedVariants = [];
    if (item.selectedVariants?.length > 0) {
      for (const varSel of item.selectedVariants) {
        const varDef = product.variants?.find(v => v.name === varSel.name);
        if (varDef) {
          const opt = varDef.options.find(o => o.label === varSel.selected);
          if (opt) {
            variantTotal += (opt.priceAddOn || 0);
            selectedVariants.push({ name: varSel.name, selected: varSel.selected, priceAddOn: opt.priceAddOn || 0 });
          }
        }
      }
    }

    const itemTotal = (unitPrice + addOnTotal + variantTotal) * item.quantity;

    enrichedItems.push({
      productId: product._id,
      productName: product.name,
      productImage: product.images?.[0],
      categoryName: item.categoryName,
      quantity: item.quantity,
      unitPrice: unitPrice + addOnTotal + variantTotal,
      discountedPrice: product.discountedPrice ? unitPrice : undefined,
      selectedVariants,
      selectedAddOns,
      specialInstructions: item.specialInstructions,
      status: 'pending',
      total: itemTotal,
    });
  }

  // Calculate pricing
  const pricing = await calculatePricing(enrichedItems, restaurant, couponCode);

  // Minimum order check
  if (restaurant.settings.minOrderAmount > 0 && pricing.subtotal < restaurant.settings.minOrderAmount) {
    return ApiResponse.error(
      res,
      `Minimum order amount is ${restaurant.settings.currencySymbol}${restaurant.settings.minOrderAmount}`,
      400
    );
  }

  const orderNumber = await generateOrderNumber(req.restaurantId);
  const estimatedTime = Math.max(...enrichedItems.map(i => {
    const product = productMap[i.productId.toString()];
    return product?.preparationTime || restaurant.settings.preparationTimeDefault;
  }));

  const order = await Order.create({
    restaurantId: req.restaurantId,
    tableId: req.tableId,
    sessionId: req.session._id,
    orderNumber,
    tableNumber: req.session.tableNumber,
    customerName: customerName || req.session.customerName,
    customerPhone: customerPhone || req.session.customerPhone,
    guestCount: guestCount || req.session.guestCount,
    items: enrichedItems,
    pricing,
    estimatedTime,
    specialInstructions,
    status: restaurant.settings.autoAcceptOrders ? 'confirmed' : 'placed',
    timeline: [{
      status: restaurant.settings.autoAcceptOrders ? 'confirmed' : 'placed',
      note: 'Order received',
      timestamp: new Date(),
    }],
  });

  // Update session total
  await TableSession.findByIdAndUpdate(req.session._id, {
    $inc: { totalAmount: pricing.grandTotal },
  });

  // Update table status
  await Table.findByIdAndUpdate(req.tableId, { status: 'occupied' });

  // Update product stats (fire & forget)
  enrichedItems.forEach(item => {
    Product.findByIdAndUpdate(item.productId, {
      $inc: { totalOrders: item.quantity, totalRevenue: item.total },
    }).catch(() => {});
  });

  // Update restaurant stats (fire & forget)
  Restaurant.findByIdAndUpdate(req.restaurantId, {
    $inc: { totalOrders: 1, totalRevenue: pricing.grandTotal },
  }).catch(() => {});

  // Create KDS ticket
  await notifyKitchen(order, req.restaurantId);

  // Invalidate order caches
  const cache = getCacheService();
  await cache.delPattern(`orders:restaurant:${req.restaurantId}*`);

  // Real-time notification via Redis pub/sub
  const publisher = getPublisher();
  if (publisher) {
    publisher.publish(`restaurant:${req.restaurantId}:orders`, JSON.stringify({
      type: 'NEW_ORDER',
      orderId: order._id,
      orderNumber: order.orderNumber,
      tableNumber: order.tableNumber,
      itemCount: enrichedItems.length,
      total: pricing.grandTotal,
      timestamp: new Date(),
    })).catch(() => {});
  }

  // Create notification
  await Notification.create({
    restaurantId: req.restaurantId,
    type: 'new_order',
    title: `New Order #${orderNumber}`,
    message: `Table ${order.tableNumber} placed an order for ${restaurant.settings.currencySymbol}${pricing.grandTotal}`,
    data: { orderId: order._id, orderNumber },
    targetRole: ['restaurant_owner', 'manager', 'cashier'],
  });

  logger.info(`Order placed: #${orderNumber} | Table: ${order.tableNumber} | Total: ${pricing.grandTotal}`);

  return ApiResponse.created(res, {
    order: {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      estimatedTime: order.estimatedTime,
      pricing: order.pricing,
      items: order.items,
    },
  }, 'Order placed successfully');
});

// ============================================
// CUSTOMER - GET ORDER STATUS
// ============================================
exports.getOrderStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    sessionId: req.session._id,
  }).select('orderNumber status estimatedTime items.status items.productName timeline payment.status pricing').lean();

  if (!order) return ApiResponse.notFound(res, 'Order not found');
  return ApiResponse.success(res, { order });
});

// ============================================
// CUSTOMER - GET SESSION ORDERS
// ============================================
exports.getSessionOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    sessionId: req.session._id,
    status: { $nin: ['cancelled'] },
  }).sort({ createdAt: 1 }).lean();

  const summary = {
    totalOrders: orders.length,
    totalAmount: orders.reduce((sum, o) => sum + (o.pricing?.grandTotal || 0), 0),
    isPaid: orders.every(o => o.payment?.status === 'paid'),
  };

  return ApiResponse.success(res, { orders, summary });
});

// ============================================
// ADMIN - GET ALL ORDERS
// ============================================
exports.adminGetOrders = asyncHandler(async (req, res) => {
  const {
    status, tableId, tableNumber, paymentStatus, orderType,
    dateFrom, dateTo, search, sortBy
  } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const query = { restaurantId: req.restaurantId };
  if (status) query.status = { $in: status.split(',') };
  if (tableId) query.tableId = tableId;
  if (tableNumber) query.tableNumber = tableNumber;
  if (paymentStatus) query['payment.status'] = paymentStatus;
  if (orderType) query.orderType = orderType;
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }
  if (search) {
    query.$or = [
      { orderNumber: { $regex: search, $options: 'i' } },
      { customerName: { $regex: search, $options: 'i' } },
      { tableNumber: { $regex: search, $options: 'i' } },
    ];
  }

  const sort = buildSortQuery(sortBy, ['createdAt', 'pricing.grandTotal', 'status']);

  const [orders, total] = await Promise.all([
    Order.find(query).sort(sort).skip(skip).limit(limit).lean(),
    Order.countDocuments(query),
  ]);

  return ApiResponse.paginated(res, { orders }, { page, limit, total });
});

// ============================================
// ADMIN - GET ORDER DETAIL
// ============================================
exports.adminGetOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurantId,
  }).populate('tableId', 'tableNumber section').lean();

  if (!order) return ApiResponse.notFound(res, 'Order not found');
  return ApiResponse.success(res, { order });
});

// ============================================
// ADMIN - UPDATE ORDER STATUS
// ============================================
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note, estimatedTime } = req.body;

  const validTransitions = {
    placed: ['confirmed', 'cancelled'],
    confirmed: ['preparing', 'cancelled'],
    preparing: ['ready', 'cancelled'],
    ready: ['served'],
    served: [],
    cancelled: [],
  };

  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurantId,
  });

  if (!order) return ApiResponse.notFound(res, 'Order not found');

  const allowed = validTransitions[order.status] || [];
  if (!allowed.includes(status)) {
    return ApiResponse.error(
      res,
      `Cannot transition from '${order.status}' to '${status}'`,
      400
    );
  }

  order.status = status;
  if (estimatedTime) order.estimatedTime = estimatedTime;
  if (status === 'served') order.actualServedTime = new Date();
  order.timeline.push({
    status,
    note: note || '',
    timestamp: new Date(),
    updatedBy: req.admin?.name || 'system',
  });

  await order.save();

  // Update KDS
  if (['confirmed', 'preparing', 'ready', 'cancelled'].includes(status)) {
    const kdsStatus = status === 'confirmed' ? 'in_progress'
      : status === 'preparing' ? 'in_progress'
      : status === 'ready' ? 'done'
      : 'cancelled';

    await KDSTicket.findOneAndUpdate(
      { orderId: order._id },
      { status: kdsStatus, ...(kdsStatus === 'done' && { completedAt: new Date() }) }
    );
  }

  // Pub/sub notification
  const publisher = getPublisher();
  if (publisher) {
    publisher.publish(`restaurant:${req.restaurantId}:orders`, JSON.stringify({
      type: 'ORDER_STATUS_UPDATED',
      orderId: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      tableNumber: order.tableNumber,
    })).catch(() => {});
  }

  // Invalidate cache
  const cache = getCacheService();
  await cache.del(CACHE_KEYS.order(order._id.toString()));

  return ApiResponse.success(res, { order }, `Order status updated to ${status}`);
});

// ============================================
// ADMIN - CANCEL ORDER
// ============================================
exports.cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurantId,
    status: { $nin: ['served', 'cancelled', 'refunded'] },
  });

  if (!order) return ApiResponse.notFound(res, 'Order not found or cannot be cancelled');

  order.status = 'cancelled';
  order.cancelReason = reason || 'Cancelled by admin';
  order.cancelledBy = req.admin?.name || 'admin';
  order.timeline.push({ status: 'cancelled', note: reason, timestamp: new Date() });
  await order.save();

  return ApiResponse.success(res, { order }, 'Order cancelled');
});

// ============================================
// ADMIN - GENERATE BILL
// ============================================
exports.generateBill = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurantId,
  }).populate('restaurantId');

  if (!order) return ApiResponse.notFound(res, 'Order not found');

  const restaurant = await Restaurant.findById(req.restaurantId).lean();
  const billData = await generateBill(order, restaurant);

  return ApiResponse.success(res, { bill: billData }, 'Bill generated');
});

// ============================================
// ADMIN - MARK PAYMENT
// ============================================
exports.markPayment = asyncHandler(async (req, res) => {
  const { method, transactionId, tip, splitPayments } = req.body;

  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurantId,
  });

  if (!order) return ApiResponse.notFound(res, 'Order not found');
  if (order.payment.status === 'paid') {
    return ApiResponse.error(res, 'Order already paid', 400);
  }

  const tip_ = tip || 0;
  order.payment = {
    method,
    status: 'paid',
    transactionId: transactionId || `CASH-${Date.now()}`,
    paidAt: new Date(),
    splitPayments: splitPayments || [],
  };
  order.pricing.tip = tip_;
  order.pricing.grandTotal = order.pricing.total + tip_;

  if (order.status === 'served') {
    // No status change needed
  }

  order.timeline.push({
    status: 'paid',
    note: `Payment received via ${method}`,
    timestamp: new Date(),
    updatedBy: req.admin?.name,
  });

  await order.save();

  // Publish payment event
  const publisher = getPublisher();
  if (publisher) {
    publisher.publish(`restaurant:${req.restaurantId}:payments`, JSON.stringify({
      type: 'PAYMENT_RECEIVED',
      orderId: order._id,
      method,
      amount: order.pricing.grandTotal,
    })).catch(() => {});
  }

  return ApiResponse.success(res, { order }, 'Payment recorded');
});

// ============================================
// ADMIN - LIVE ORDERS (KDS)
// ============================================
exports.getLiveOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    restaurantId: req.restaurantId,
    status: { $in: ['placed', 'confirmed', 'preparing', 'ready'] },
  }).sort({ createdAt: 1 }).lean();

  const kdsTickets = await KDSTicket.find({
    restaurantId: req.restaurantId,
    status: { $in: ['new', 'in_progress'] },
  }).sort({ createdAt: 1 }).lean();

  return ApiResponse.success(res, { orders, kdsTickets });
});

// ============================================
// ADMIN - ORDER ITEM STATUS (for kitchen)
// ============================================
exports.updateItemStatus = asyncHandler(async (req, res) => {
  const { itemId, status } = req.body;

  const order = await Order.findOneAndUpdate(
    { _id: req.params.orderId, restaurantId: req.restaurantId, 'items._id': itemId },
    { $set: { 'items.$.status': status } },
    { new: true }
  );

  if (!order) return ApiResponse.notFound(res, 'Order or item not found');

  return ApiResponse.success(res, { order }, 'Item status updated');
});
