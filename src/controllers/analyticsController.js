const mongoose = require('mongoose');
const moment = require('moment');
const { Order, Product, DailyReport, Restaurant, Table, Review } = require('../models');
const { ApiResponse, asyncHandler } = require('../utils/apiHelpers');
const { getCacheService, TTL } = require('../config/redis');
const logger = require('../utils/logger');

// ============================================
// DASHBOARD OVERVIEW
// ============================================
exports.getDashboard = asyncHandler(async (req, res) => {
  const restaurantId = req.restaurantId;
  const cache = getCacheService();
  const cacheKey = `dashboard:${restaurantId}:${moment().format('YYYY-MM-DD-HH')}`;

  const cached = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Dashboard data', 200, { cached: true });

  const now = new Date();
  const todayStart = moment().startOf('day').toDate();
  const todayEnd = moment().endOf('day').toDate();
  const yesterdayStart = moment().subtract(1, 'day').startOf('day').toDate();
  const yesterdayEnd = moment().subtract(1, 'day').endOf('day').toDate();
  const weekStart = moment().startOf('week').toDate();
  const monthStart = moment().startOf('month').toDate();

  const [
    todayOrders, yesterdayOrders,
    weekOrders, monthOrders,
    liveOrders, pendingPayments,
    activeTables, totalReviews,
  ] = await Promise.all([
    // Today stats
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: todayStart, $lte: todayEnd },
          status: { $nin: ['cancelled'] },
        }
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: '$pricing.grandTotal' },
          avgOrderValue: { $avg: '$pricing.grandTotal' },
          totalGuests: { $sum: '$guestCount' },
          cashRevenue: {
            $sum: {
              $cond: [{ $eq: ['$payment.method', 'cash'] }, '$pricing.grandTotal', 0]
            }
          },
          onlineRevenue: {
            $sum: {
              $cond: [{ $in: ['$payment.method', ['card', 'upi', 'online']] }, '$pricing.grandTotal', 0]
            }
          },
        }
      }
    ]),
    // Yesterday
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
          status: { $nin: ['cancelled'] },
        }
      },
      { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenue: { $sum: '$pricing.grandTotal' } } }
    ]),
    // This week
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: weekStart },
          status: { $nin: ['cancelled'] },
        }
      },
      { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenue: { $sum: '$pricing.grandTotal' } } }
    ]),
    // This month
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: monthStart },
          status: { $nin: ['cancelled'] },
        }
      },
      { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenue: { $sum: '$pricing.grandTotal' } } }
    ]),
    // Live orders
    Order.countDocuments({
      restaurantId,
      status: { $in: ['placed', 'confirmed', 'preparing', 'ready'] },
    }),
    // Pending payments
    Order.countDocuments({
      restaurantId,
      'payment.status': 'pending',
      status: { $in: ['served', 'ready'] },
    }),
    // Active tables
    Table.countDocuments({ restaurantId, status: 'occupied', isActive: true }),
    // Reviews today
    Review.countDocuments({
      restaurantId,
      createdAt: { $gte: todayStart },
    }),
  ]);

  const today = todayOrders[0] || { totalOrders: 0, totalRevenue: 0, avgOrderValue: 0, cashRevenue: 0, onlineRevenue: 0 };
  const yesterday = yesterdayOrders[0] || { totalOrders: 0, totalRevenue: 0 };

  const revenueGrowth = yesterday.totalRevenue > 0
    ? ((today.totalRevenue - yesterday.totalRevenue) / yesterday.totalRevenue * 100).toFixed(1)
    : 0;
  const ordersGrowth = yesterday.totalOrders > 0
    ? ((today.totalOrders - yesterday.totalOrders) / yesterday.totalOrders * 100).toFixed(1)
    : 0;

  const dashboard = {
    today: {
      orders: today.totalOrders,
      revenue: today.totalRevenue,
      avgOrderValue: today.avgOrderValue?.toFixed(2) || 0,
      guests: today.totalGuests || 0,
      cashRevenue: today.cashRevenue || 0,
      onlineRevenue: today.onlineRevenue || 0,
    },
    growth: {
      revenue: parseFloat(revenueGrowth),
      orders: parseFloat(ordersGrowth),
    },
    week: { orders: weekOrders[0]?.totalOrders || 0, revenue: weekOrders[0]?.totalRevenue || 0 },
    month: { orders: monthOrders[0]?.totalOrders || 0, revenue: monthOrders[0]?.totalRevenue || 0 },
    live: { orders: liveOrders, pendingPayments, activeTables, newReviews: totalReviews },
  };

  await cache.set(cacheKey, dashboard, TTL.STATS);
  return ApiResponse.success(res, dashboard);
});

// ============================================
// SALES SUMMARY (flexible date range)
// ============================================
exports.getSalesSummary = asyncHandler(async (req, res) => {
  const { period = 'week', dateFrom, dateTo, groupBy = 'day' } = req.query;
  const restaurantId = req.restaurantId;

  let startDate, endDate;

  if (dateFrom && dateTo) {
    startDate = moment(dateFrom).startOf('day').toDate();
    endDate = moment(dateTo).endOf('day').toDate();
  } else {
    endDate = moment().endOf('day').toDate();
    switch (period) {
      case 'today': startDate = moment().startOf('day').toDate(); break;
      case 'week': startDate = moment().subtract(7, 'days').startOf('day').toDate(); break;
      case 'month': startDate = moment().subtract(30, 'days').startOf('day').toDate(); break;
      case '3months': startDate = moment().subtract(90, 'days').startOf('day').toDate(); break;
      case 'year': startDate = moment().subtract(365, 'days').startOf('day').toDate(); break;
      default: startDate = moment().subtract(7, 'days').startOf('day').toDate();
    }
  }

  const cache = getCacheService();
  const cacheKey = `sales:${restaurantId}:${startDate.toISOString()}:${endDate.toISOString()}:${groupBy}`;
  const cached = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Sales summary', 200, { cached: true });

  // Date group format
  const dateGroupFormat = groupBy === 'hour' ? { $dateToString: { format: '%Y-%m-%d %H:00', date: '$createdAt' } }
    : groupBy === 'week' ? { $isoWeek: '$createdAt' }
    : groupBy === 'month' ? { $dateToString: { format: '%Y-%m', date: '$createdAt' } }
    : { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

  const [salesData, topProducts, paymentBreakdown, categoryBreakdown, hourlyBreakdown] = await Promise.all([
    // Daily/hourly sales
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $nin: ['cancelled'] },
        }
      },
      {
        $group: {
          _id: dateGroupFormat,
          orders: { $sum: 1 },
          revenue: { $sum: '$pricing.grandTotal' },
          subtotal: { $sum: '$pricing.subtotal' },
          tax: { $sum: '$pricing.tax' },
          discounts: { $sum: '$pricing.discount' },
          tips: { $sum: '$pricing.tip' },
          avgOrderValue: { $avg: '$pricing.grandTotal' },
          completedOrders: { $sum: { $cond: [{ $eq: ['$status', 'served'] }, 1, 0] } },
          cancelledCount: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        }
      },
      { $sort: { _id: 1 } }
    ]),

    // Top products
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $nin: ['cancelled'] },
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $first: '$items.productName' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.total' },
          orders: { $sum: 1 },
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 }
    ]),

    // Payment breakdown
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          'payment.status': 'paid',
        }
      },
      {
        $group: {
          _id: '$payment.method',
          count: { $sum: 1 },
          total: { $sum: '$pricing.grandTotal' },
        }
      },
      { $sort: { total: -1 } }
    ]),

    // Category breakdown
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $nin: ['cancelled'] },
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.categoryName',
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.total' },
        }
      },
      { $sort: { revenue: -1 } }
    ]),

    // Hourly breakdown (peak hours)
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $nin: ['cancelled'] },
        }
      },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          orders: { $sum: 1 },
          revenue: { $sum: '$pricing.grandTotal' },
        }
      },
      { $sort: { _id: 1 } }
    ]),
  ]);

  // Totals
  const totals = salesData.reduce((acc, d) => ({
    orders: acc.orders + d.orders,
    revenue: acc.revenue + d.revenue,
    tax: acc.tax + d.tax,
    discounts: acc.discounts + d.discounts,
    tips: acc.tips + d.tips,
  }), { orders: 0, revenue: 0, tax: 0, discounts: 0, tips: 0 });

  const result = {
    period: { from: startDate, to: endDate },
    totals: {
      ...totals,
      netRevenue: totals.revenue - totals.tax,
      avgOrderValue: totals.orders > 0 ? (totals.revenue / totals.orders).toFixed(2) : 0,
    },
    timeline: salesData,
    topProducts,
    paymentBreakdown,
    categoryBreakdown,
    peakHours: hourlyBreakdown,
  };

  await cache.set(cacheKey, result, TTL.STATS);
  return ApiResponse.success(res, result);
});

// ============================================
// PRODUCT ANALYTICS
// ============================================
exports.getProductAnalytics = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, limit = 20 } = req.query;
  const restaurantId = req.restaurantId;

  const startDate = dateFrom ? new Date(dateFrom) : moment().subtract(30, 'days').toDate();
  const endDate = dateTo ? new Date(dateTo) : new Date();

  const analytics = await Order.aggregate([
    {
      $match: {
        restaurantId: new mongoose.Types.ObjectId(restaurantId),
        createdAt: { $gte: startDate, $lte: endDate },
        status: { $nin: ['cancelled'] },
      }
    },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        name: { $first: '$items.productName' },
        totalQuantity: { $sum: '$items.quantity' },
        totalRevenue: { $sum: '$items.total' },
        orderCount: { $sum: 1 },
        avgQuantityPerOrder: { $avg: '$items.quantity' },
      }
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id',
        foreignField: '_id',
        as: 'product',
      }
    },
    { $unwind: { path: '$product', preserveNullAndEmpty: true } },
    {
      $project: {
        name: 1,
        totalQuantity: 1,
        totalRevenue: 1,
        orderCount: 1,
        avgQuantityPerOrder: { $round: ['$avgQuantityPerOrder', 2] },
        costPrice: '$product.costPrice',
        price: '$product.price',
        profitMargin: {
          $cond: [
            { $and: ['$product.costPrice', { $gt: ['$product.price', 0] }] },
            {
              $multiply: [
                { $divide: [{ $subtract: ['$product.price', '$product.costPrice'] }, '$product.price'] },
                100
              ]
            },
            null
          ]
        }
      }
    },
    { $sort: { totalRevenue: -1 } },
    { $limit: parseInt(limit) },
  ]);

  return ApiResponse.success(res, { analytics, period: { from: startDate, to: endDate } });
});

// ============================================
// GENERATE DETAILED SALES REPORT
// ============================================
exports.generateReport = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo, format = 'json' } = req.query;
  const restaurantId = req.restaurantId;

  const startDate = dateFrom ? moment(dateFrom).startOf('day').toDate() : moment().startOf('month').toDate();
  const endDate = dateTo ? moment(dateTo).endOf('day').toDate() : moment().endOf('day').toDate();

  const restaurant = await Restaurant.findById(restaurantId).lean();

  const [orders, topItems] = await Promise.all([
    Order.find({
      restaurantId,
      createdAt: { $gte: startDate, $lte: endDate },
    }).sort({ createdAt: 1 }).lean(),

    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: { $nin: ['cancelled'] },
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $first: '$items.productName' },
          qty: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.total' },
        }
      },
      { $sort: { qty: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const completedOrders = orders.filter(o => !['cancelled'].includes(o.status));
  const cancelledOrders = orders.filter(o => o.status === 'cancelled');

  const report = {
    restaurant: { name: restaurant.name, address: restaurant.address },
    period: {
      from: startDate.toISOString().split('T')[0],
      to: endDate.toISOString().split('T')[0],
    },
    summary: {
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
      cancelledOrders: cancelledOrders.length,
      cancellationRate: orders.length ? ((cancelledOrders.length / orders.length) * 100).toFixed(1) : 0,
      grossRevenue: completedOrders.reduce((s, o) => s + (o.pricing?.grandTotal || 0), 0),
      netRevenue: completedOrders.reduce((s, o) => s + (o.pricing?.subtotal || 0), 0),
      totalTax: completedOrders.reduce((s, o) => s + (o.pricing?.tax || 0), 0),
      totalDiscounts: completedOrders.reduce((s, o) => s + (o.pricing?.discount || 0), 0),
      totalTips: completedOrders.reduce((s, o) => s + (o.pricing?.tip || 0), 0),
      cashRevenue: completedOrders.filter(o => o.payment?.method === 'cash').reduce((s, o) => s + (o.pricing?.grandTotal || 0), 0),
      onlineRevenue: completedOrders.filter(o => ['card', 'upi', 'online'].includes(o.payment?.method)).reduce((s, o) => s + (o.pricing?.grandTotal || 0), 0),
      avgOrderValue: completedOrders.length ? (completedOrders.reduce((s, o) => s + (o.pricing?.grandTotal || 0), 0) / completedOrders.length).toFixed(2) : 0,
    },
    topItems,
    orders: orders.map(o => ({
      orderNumber: o.orderNumber,
      date: moment(o.createdAt).format('YYYY-MM-DD HH:mm'),
      table: o.tableNumber,
      items: o.items?.length,
      total: o.pricing?.grandTotal,
      payment: o.payment?.method,
      paymentStatus: o.payment?.status,
      status: o.status,
    })),
    generatedAt: new Date().toISOString(),
  };

  if (format === 'pdf') {
    // Generate PDF report
    const { generateReportPDF } = require('../services/billService');
    const pdfBuffer = await generateReportPDF(report, restaurant);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=sales-report-${startDate.toISOString().split('T')[0]}.pdf`);
    return res.send(pdfBuffer);
  }

  return ApiResponse.success(res, { report });
});
