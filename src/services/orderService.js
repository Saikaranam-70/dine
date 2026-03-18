const { KDSTicket, Coupon } = require('../models');
const { getPublisher } = require('../config/redis');
const logger = require('../utils/logger');

// ============================================
// GENERATE ORDER NUMBER
// ============================================
exports.generateOrderNumber = async (restaurantId) => {
  const { getCacheService } = require('../config/redis');
  const cache = getCacheService();
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const key = `order_counter:${restaurantId}:${today}`;

  let counter;
  try {
    counter = await cache.incr(key, 86400); // expire after 24h
  } catch {
    // Fallback to timestamp-based
    counter = Date.now() % 10000;
  }

  const prefix = today.slice(-4); // MMDD
  return `ORD-${prefix}-${String(counter).padStart(4, '0')}`;
};

// ============================================
// CALCULATE PRICING
// ============================================
exports.calculatePricing = async (items, restaurant, couponCode = null) => {
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const taxRate = restaurant.settings.taxRate || 18;
  const tax = (subtotal * taxRate) / 100;
  const serviceCharge = restaurant.settings.serviceCharge
    ? (subtotal * restaurant.settings.serviceCharge) / 100
    : 0;

  let discount = 0;
  let couponDiscount = 0;
  let appliedCoupon = null;

  if (couponCode) {
    const coupon = await Coupon.findOne({
      restaurantId: restaurant._id,
      code: couponCode.toUpperCase(),
      isActive: true,
      $or: [{ validTo: { $gte: new Date() } }, { validTo: null }],
    });

    if (coupon && coupon.minOrderAmount <= subtotal) {
      if (coupon.type === 'percentage') {
        couponDiscount = (subtotal * coupon.value) / 100;
        if (coupon.maxDiscount) couponDiscount = Math.min(couponDiscount, coupon.maxDiscount);
      } else if (coupon.type === 'fixed') {
        couponDiscount = Math.min(coupon.value, subtotal);
      }

      // Increment usage
      await Coupon.findByIdAndUpdate(coupon._id, { $inc: { usedCount: 1 } });
      appliedCoupon = coupon.code;
      discount = couponDiscount;
    }
  }

  const total = subtotal + tax + serviceCharge - discount;
  const grandTotal = Math.max(0, total);

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    taxRate,
    serviceCharge: Math.round(serviceCharge * 100) / 100,
    discount: Math.round(discount * 100) / 100,
    couponCode: appliedCoupon,
    couponDiscount: Math.round(couponDiscount * 100) / 100,
    total: Math.round(total * 100) / 100,
    tip: 0,
    grandTotal: Math.round(grandTotal * 100) / 100,
  };
};

// ============================================
// NOTIFY KITCHEN (KDS)
// ============================================
exports.notifyKitchen = async (order, restaurantId) => {
  try {
    const ticket = await KDSTicket.create({
      restaurantId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      tableNumber: order.tableNumber,
      items: order.items.map(item => ({
        productId: item.productId,
        name: item.productName,
        quantity: item.quantity,
        variants: item.selectedVariants?.map(v => `${v.name}: ${v.selected}`) || [],
        addOns: item.selectedAddOns?.flatMap(a => a.selected) || [],
        specialInstructions: item.specialInstructions,
        status: 'pending',
      })),
      estimatedTime: order.estimatedTime,
      priority: 'normal',
    });

    // Publish to kitchen channel
    const publisher = getPublisher();
    if (publisher) {
      await publisher.publish(`restaurant:${restaurantId}:kitchen`, JSON.stringify({
        type: 'NEW_TICKET',
        ticketId: ticket._id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        itemCount: order.items.length,
        estimatedTime: order.estimatedTime,
      }));
    }

    return ticket;
  } catch (err) {
    logger.error(`Failed to create KDS ticket: ${err.message}`);
  }
};
