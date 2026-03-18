const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { Order, Restaurant } = require('../models');
const { ApiResponse, asyncHandler, AppError } = require('../utils/apiHelpers');
const logger = require('../utils/logger');

const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

// ============================================
// INITIATE ONLINE PAYMENT
// ============================================
exports.initiatePayment = asyncHandler(async (req, res) => {
  const { orderId, gateway = 'razorpay' } = req.body;

  const order = await Order.findOne({
    _id: orderId,
    sessionId: req.session._id,
    'payment.status': { $nin: ['paid'] },
  });

  if (!order) return ApiResponse.notFound(res, 'Order not found or already paid');

  const restaurant = await Restaurant.findById(req.restaurantId).lean();
  const amount = Math.round(order.pricing.grandTotal * 100); // in paise/cents

  if (gateway === 'razorpay') {
    const razorpay = getRazorpay();
    if (!razorpay) return ApiResponse.error(res, 'Razorpay not configured', 500);

    const rzpOrder = await razorpay.orders.create({
      amount,
      currency: restaurant.settings.currency || 'INR',
      receipt: order.orderNumber,
      notes: {
        orderId: order._id.toString(),
        restaurantId: req.restaurantId.toString(),
        tableNumber: order.tableNumber,
      },
    });

    await Order.findByIdAndUpdate(orderId, {
      'payment.gatewayOrderId': rzpOrder.id,
      'payment.method': 'online',
    });

    return ApiResponse.success(res, {
      gateway: 'razorpay',
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: rzpOrder.id,
      amount,
      currency: rzpOrder.currency,
      orderNumber: order.orderNumber,
    });
  }

  if (gateway === 'stripe') {
    if (!stripe) return ApiResponse.error(res, 'Stripe not configured', 500);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: order.items.map(item => ({
        price_data: {
          currency: (restaurant.settings.currency || 'INR').toLowerCase(),
          product_data: { name: item.productName },
          unit_amount: Math.round(item.unitPrice * 100),
        },
        quantity: item.quantity,
      })),
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
      metadata: {
        orderId: order._id.toString(),
        restaurantId: req.restaurantId.toString(),
      },
    });

    await Order.findByIdAndUpdate(orderId, {
      'payment.gatewayOrderId': session.id,
      'payment.method': 'card',
    });

    return ApiResponse.success(res, {
      gateway: 'stripe',
      sessionUrl: session.url,
      sessionId: session.id,
    });
  }

  return ApiResponse.error(res, 'Unsupported payment gateway', 400);
});

// ============================================
// VERIFY RAZORPAY PAYMENT
// ============================================
exports.verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, orderId } = req.body;

  // Verify signature
  const body = razorpayOrderId + '|' + razorpayPaymentId;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn(`Invalid Razorpay signature for order: ${orderId}`);
    return ApiResponse.error(res, 'Payment verification failed', 400);
  }

  const order = await Order.findByIdAndUpdate(orderId, {
    'payment.status': 'paid',
    'payment.transactionId': razorpayPaymentId,
    'payment.gatewayPaymentId': razorpayPaymentId,
    'payment.paidAt': new Date(),
  }, { new: true });

  if (!order) return ApiResponse.notFound(res, 'Order not found');

  logger.info(`Payment verified: ${razorpayPaymentId} for order ${orderId}`);
  return ApiResponse.success(res, { order }, 'Payment successful!');
});

// ============================================
// STRIPE WEBHOOK
// ============================================
exports.stripeWebhook = asyncHandler(async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error(`Stripe webhook error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { orderId } = session.metadata;

    await Order.findByIdAndUpdate(orderId, {
      'payment.status': 'paid',
      'payment.transactionId': session.payment_intent,
      'payment.gatewayPaymentId': session.payment_intent,
      'payment.paidAt': new Date(),
    });

    logger.info(`Stripe payment completed for order: ${orderId}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    logger.warn(`Stripe payment failed: ${intent.id}`);
  }

  res.json({ received: true });
});

// ============================================
// APPLY COUPON
// ============================================
exports.applyCoupon = asyncHandler(async (req, res) => {
  const { code, orderAmount } = req.body;
  const { Coupon } = require('../models');

  const coupon = await Coupon.findOne({
    restaurantId: req.restaurantId,
    code: code.toUpperCase(),
    isActive: true,
    $or: [
      { validTo: { $gte: new Date() } },
      { validTo: null },
    ],
  });

  if (!coupon) return ApiResponse.error(res, 'Invalid or expired coupon', 400);
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return ApiResponse.error(res, 'Coupon usage limit reached', 400);
  }
  if (coupon.minOrderAmount > orderAmount) {
    return ApiResponse.error(res, `Minimum order amount for this coupon is ₹${coupon.minOrderAmount}`, 400);
  }

  let discount = 0;
  if (coupon.type === 'percentage') {
    discount = (orderAmount * coupon.value) / 100;
    if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  } else if (coupon.type === 'fixed') {
    discount = Math.min(coupon.value, orderAmount);
  }

  return ApiResponse.success(res, {
    coupon: { code: coupon.code, type: coupon.type, value: coupon.value },
    discount: Math.round(discount),
    finalAmount: orderAmount - discount,
  }, 'Coupon applied successfully');
});

// ============================================
// REFUND
// ============================================
exports.initiateRefund = asyncHandler(async (req, res) => {
  const { orderId, amount, reason } = req.body;

  const order = await Order.findOne({
    _id: orderId,
    restaurantId: req.restaurantId,
    'payment.status': 'paid',
  });

  if (!order) return ApiResponse.notFound(res, 'Order not found or not paid');

  const refundAmount = amount || order.pricing.grandTotal;

  // Process Razorpay refund
  if (order.payment.gatewayPaymentId && getRazorpay()) {
    const razorpay = getRazorpay();
    try {
      await razorpay.payments.refund(order.payment.gatewayPaymentId, {
        amount: Math.round(refundAmount * 100),
        notes: { reason: reason || 'Customer refund', orderId: orderId },
      });
    } catch (err) {
      logger.error(`Razorpay refund error: ${err.message}`);
      return ApiResponse.error(res, `Refund failed: ${err.message}`, 400);
    }
  }

  await Order.findByIdAndUpdate(orderId, {
    'payment.status': 'refunded',
    status: 'refunded',
    $push: {
      timeline: { status: 'refunded', note: reason || 'Refund processed', timestamp: new Date() }
    }
  });

  return ApiResponse.success(res, { refundAmount }, 'Refund initiated successfully');
});
