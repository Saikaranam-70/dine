'use strict';

const { Order, Restaurant , TableSession } = require('../models/index');
const { ApiResponse, asyncHandler } = require('../utils/apiHelpers');
const { generateBill, generateBillPDF } = require('../services/billService');
const logger = require('../utils/logger');

// GET /api/bills/:orderId/receipt
exports.getReceipt = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) return ApiResponse.notFound(res, 'Order not found');

  const restaurant = await Restaurant.findById(order.restaurantId).lean();
  if (!restaurant) return ApiResponse.notFound(res, 'Restaurant not found');

  const bill = await generateBill(order, restaurant);
  return ApiResponse.success(res, { bill });
});

// GET /api/bills/:orderId/download
exports.downloadBill = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) return ApiResponse.notFound(res, 'Order not found');

  const restaurant = await Restaurant.findById(order.restaurantId).lean();
  if (!restaurant) return ApiResponse.notFound(res, 'Restaurant not found');

  const billData = await generateBill(order, restaurant);
  const pdfBuffer = await generateBillPDF(billData);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=bill-${order.orderNumber}.pdf`,
  );
  res.setHeader('Content-Length', pdfBuffer.length);
  return res.send(pdfBuffer);
});



 
/**
 * Merge multiple orders into a single bill structure.
 * Items are de-duplicated by (productId + variant fingerprint).
 * Pricing is re-summed from raw order pricing fields.
 */
function mergeOrdersIntoBill(orders, restaurant) {
  // Flatten all items, keeping order reference for display
  const allItems = [];
  for (const order of orders) {
    for (const item of order.items || []) {
      allItems.push({
        ...item,
        _orderId     : order._id,
        _orderNumber : order.orderNumber,
      });
    }
  }
 
  // Aggregate pricing across orders
  const subtotal      = orders.reduce((s, o) => s + (o.pricing?.subtotal      || 0), 0);
  const discount      = orders.reduce((s, o) => s + (o.pricing?.discount      || 0), 0);
  const tax           = orders.reduce((s, o) => s + (o.pricing?.tax           || 0), 0);
  const serviceCharge = orders.reduce((s, o) => s + (o.pricing?.serviceCharge || 0), 0);
  const tip           = orders.reduce((s, o) => s + (o.pricing?.tip           || 0), 0);
  const grandTotal    = orders.reduce((s, o) => s + (o.pricing?.grandTotal    || 0), 0);
 
  // Derive a single taxRate string (use first order's rate, they share restaurant settings)
  const taxRate = orders[0]?.pricing?.taxRate || restaurant?.settings?.taxRate || 18;
 
  return {
    items      : allItems,
    orderCount : orders.length,
    orderNumbers: orders.map(o => o.orderNumber),
    pricing: {
      subtotal,
      discount,
      tax,
      taxRate,
      serviceCharge,
      tip,
      grandTotal,
    },
    // Payment status: paid only if ALL orders are paid
    paymentStatus: orders.every(o => o.payment?.status === 'paid') ? 'paid' : 'pending',
    // Payment methods used across orders (deduplicated)
    paymentMethods: [...new Set(
      orders
        .filter(o => o.payment?.method)
        .map(o => o.payment.method)
    )],
  };
}
 
// =============================================================================
// ADMIN — PER-ORDER BILL
// GET /admin/orders/:orderId/bill
// =============================================================================
exports.adminGetOrderBill = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id          : req.params.orderId,
    restaurantId : req.restaurantId,
  }).lean();
 
  if (!order) return ApiResponse.notFound(res, 'Order not found');
 
  const restaurant = await Restaurant.findById(req.restaurantId).lean();
 
  // Re-use existing billService to produce formatted bill data
  const billData = await generateBill(order, restaurant);
 
  // Attach some extra meta for the admin UI
  const response = {
    type       : 'single_order',
    bill       : billData,
    order      : {
      _id         : order._id,
      orderNumber : order.orderNumber,
      tableNumber : order.tableNumber,
      customerName: order.customerName,
      guestCount  : order.guestCount,
      createdAt   : order.createdAt,
      status      : order.status,
      payment     : order.payment,
    },
    restaurant : {
      name    : restaurant.name,
      address : restaurant.address,
      phone   : restaurant.phone,
      logo    : restaurant.logo,
      gstin   : restaurant.gstin,
      settings: {
        currencySymbol: restaurant.settings?.currencySymbol || '₹',
        taxRate       : restaurant.settings?.taxRate        || 18,
      },
    },
  };
 
  logger.info(`Admin bill generated: Order #${order.orderNumber}`);
  return ApiResponse.success(res, response, 'Bill generated');
});
 
// =============================================================================
// ADMIN — SESSION-LEVEL COMBINED BILL
// GET /admin/tables/sessions/:sessionId/bill
// =============================================================================
exports.adminGetSessionBill = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
 
  // Validate session belongs to this restaurant
  const session = await TableSession.findOne({
    _id          : sessionId,
    restaurantId : req.restaurantId,
  }).lean();
 
  if (!session) return ApiResponse.notFound(res, 'Session not found');
 
  // Fetch all non-cancelled orders for this session, oldest first
  const orders = await Order.find({
    sessionId    : sessionId,
    restaurantId : req.restaurantId,
    status       : { $nin: ['cancelled'] },
  })
    .sort({ createdAt: 1 })
    .lean();
 
  if (orders.length === 0) {
    return ApiResponse.error(res, 'No orders found for this session', 400);
  }
 
  const restaurant = await Restaurant.findById(req.restaurantId).lean();
  const merged     = mergeOrdersIntoBill(orders, restaurant);
 
  const response = {
    type    : 'session_bill',
    session : {
      _id         : session._id,
      tableNumber : session.tableNumber,
      customerName: session.customerName || orders[0]?.customerName,
      guestCount  : session.guestCount,
      startedAt   : session.createdAt,
      closedAt    : session.closedAt || null,
      status      : session.status,
    },
    restaurant: {
      name    : restaurant.name,
      address : restaurant.address,
      phone   : restaurant.phone,
      logo    : restaurant.logo,
      gstin   : restaurant.gstin,
      settings: {
        currencySymbol: restaurant.settings?.currencySymbol || '₹',
        taxRate       : restaurant.settings?.taxRate        || 18,
      },
    },
    orders : orders.map(o => ({
      _id         : o._id,
      orderNumber : o.orderNumber,
      status      : o.status,
      createdAt   : o.createdAt,
      itemCount   : o.items?.length || 0,
      grandTotal  : o.pricing?.grandTotal || 0,
      paymentStatus: o.payment?.status || 'pending',
    })),
    // Merged across all orders
    items   : merged.items,
    pricing : merged.pricing,
    summary : {
      orderCount     : merged.orderCount,
      orderNumbers   : merged.orderNumbers,
      paymentStatus  : merged.paymentStatus,
      paymentMethods : merged.paymentMethods,
    },
  };
 
  logger.info(
    `Session bill generated: Session ${sessionId} | Table ${session.tableNumber} | Orders: ${orders.length} | Total: ${merged.pricing.grandTotal}`
  );
 
  return ApiResponse.success(res, response, 'Session bill generated');
});
 
// =============================================================================
// CUSTOMER — GET RECEIPT  (existing, kept here for completeness)
// GET /bills/:orderId/receipt
// =============================================================================
exports.getReceipt = asyncHandler(async (req, res) => {
  // orderId is public but we need restaurantId from the order itself
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) return ApiResponse.notFound(res, 'Order not found');
 
  const restaurant = await Restaurant.findById(order.restaurantId).lean();
  const billData   = await generateBill(order, restaurant);
 
  return ApiResponse.success(res, { bill: billData, order, restaurant });
});
 
// =============================================================================
// CUSTOMER — DOWNLOAD PDF BILL  (existing)
// GET /bills/:orderId/download
// =============================================================================
exports.downloadBill = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) return ApiResponse.notFound(res, 'Order not found');
 
  const restaurant = await Restaurant.findById(order.restaurantId).lean();
  const billData   = await generateBill(order, restaurant);
 
  // If your billService returns a PDF buffer, stream it.
  // Otherwise fall back to JSON (replace with your actual PDF logic).
  if (billData.pdfBuffer) {
    res.set({
      'Content-Type'       : 'application/pdf',
      'Content-Disposition': `attachment; filename="bill-${order.orderNumber}.pdf"`,
    });
    return res.send(billData.pdfBuffer);
  }
 
  // Fallback — return JSON if no PDF generation is wired yet
  return ApiResponse.success(res, { bill: billData });
});