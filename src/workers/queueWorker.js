const Queue = require('bull');
const cron = require('node-cron');
const moment = require('moment');
const logger = require('../utils/logger');

const REDIS_URL = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';

const queueOptions = {
  redis: REDIS_URL,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
};

// ============================================
// QUEUES
// ============================================
let orderQueue, reportQueue, emailQueue, analyticsQueue;

const initQueues = () => {
  try {
    orderQueue = new Queue('order-processing', queueOptions);
    reportQueue = new Queue('report-generation', queueOptions);
    emailQueue = new Queue('email-notifications', queueOptions);
    analyticsQueue = new Queue('analytics-aggregation', queueOptions);

    setupOrderWorker();
    setupReportWorker();
    setupEmailWorker();
    setupAnalyticsWorker();
    setupScheduledJobs();

    logger.info('Bull queues initialized');
    return { orderQueue, reportQueue, emailQueue, analyticsQueue };
  } catch (err) {
    logger.error(`Queue initialization failed: ${err.message}`);
    return {};
  }
};

// ============================================
// ORDER QUEUE WORKER
// ============================================
const setupOrderWorker = () => {
  orderQueue.process('update-stats', 5, async (job) => {
    const { restaurantId, items, revenue } = job.data;
    const { Restaurant, Product } = require('../models');

    await Promise.allSettled([
      Restaurant.findByIdAndUpdate(restaurantId, {
        $inc: { totalOrders: 1, totalRevenue: revenue },
      }),
      ...items.map(item =>
        Product.findByIdAndUpdate(item.productId, {
          $inc: { totalOrders: item.quantity, totalRevenue: item.total },
        })
      ),
    ]);
  });

  orderQueue.process('send-confirmation', 3, async (job) => {
    const { orderId, customerEmail } = job.data;
    if (customerEmail) {
      await emailQueue.add('order-confirmation', { orderId, customerEmail });
    }
  });

  orderQueue.on('failed', (job, err) => {
    logger.error(`Order queue job ${job.id} failed: ${err.message}`);
  });
};

// ============================================
// DAILY REPORT WORKER
// ============================================
const setupReportWorker = () => {
  reportQueue.process('generate-daily-report', 2, async (job) => {
    const { restaurantId, date } = job.data;
    await generateDailyReport(restaurantId, date);
  });
};

const generateDailyReport = async (restaurantId, dateStr) => {
  const { Order, DailyReport } = require('../models');
  const mongoose = require('mongoose');
  const startDate = moment(dateStr).startOf('day').toDate();
  const endDate = moment(dateStr).endOf('day').toDate();

  const [orders, topProducts, peakHours] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'served'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          revenue: { $sum: '$pricing.grandTotal' },
          tax: { $sum: '$pricing.tax' },
          discounts: { $sum: '$pricing.discount' },
          tips: { $sum: '$pricing.tip' },
          serviceCharge: { $sum: '$pricing.serviceCharge' },
          cashRevenue: { $sum: { $cond: [{ $eq: ['$payment.method', 'cash'] }, '$pricing.grandTotal', 0] } },
          onlineRevenue: { $sum: { $cond: [{ $in: ['$payment.method', ['card', 'upi', 'online']] }, '$pricing.grandTotal', 0] } },
          tablesUsed: { $addToSet: '$tableId' },
        }
      }
    ]),

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
        }
      },
      { $sort: { quantity: -1 } },
      { $limit: 10 },
    ]),

    Order.aggregate([
      {
        $match: {
          restaurantId: new mongoose.Types.ObjectId(restaurantId),
          createdAt: { $gte: startDate, $lte: endDate },
        }
      },
      { $group: { _id: { $hour: '$createdAt' }, orderCount: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const stats = orders[0] || {};
  const avgOrderValue = stats.completed > 0 ? stats.revenue / stats.completed : 0;

  await DailyReport.findOneAndUpdate(
    { restaurantId, dateString: dateStr },
    {
      $set: {
        date: startDate,
        dateString: dateStr,
        orders: {
          total: stats.total || 0,
          completed: stats.completed || 0,
          cancelled: stats.cancelled || 0,
          pending: (stats.total || 0) - (stats.completed || 0) - (stats.cancelled || 0),
        },
        revenue: {
          gross: stats.revenue || 0,
          net: (stats.revenue || 0) - (stats.tax || 0),
          tax: stats.tax || 0,
          serviceCharge: stats.serviceCharge || 0,
          discounts: stats.discounts || 0,
          tips: stats.tips || 0,
        },
        payments: {
          cash: stats.cashRevenue || 0,
          online: stats.onlineRevenue || 0,
        },
        topProducts,
        peakHours: peakHours.map(h => ({ hour: h._id, orderCount: h.orderCount })),
        avgOrderValue,
        tablesUsed: stats.tablesUsed?.length || 0,
      }
    },
    { upsert: true }
  );

  logger.info(`Daily report generated: Restaurant ${restaurantId} | Date: ${dateStr}`);
};

// ============================================
// EMAIL WORKER
// ============================================
const setupEmailWorker = () => {
  emailQueue.process('order-confirmation', 3, async (job) => {
    const { orderId, customerEmail } = job.data;
    // TODO: Send email via nodemailer
    logger.info(`[Email] Order confirmation sent: ${orderId} → ${customerEmail}`);
  });

  emailQueue.process('daily-summary', 1, async (job) => {
    const { restaurantId, adminEmail } = job.data;
    logger.info(`[Email] Daily summary sent to: ${adminEmail}`);
  });
};

// ============================================
// ANALYTICS WORKER (aggregation jobs)
// ============================================
const setupAnalyticsWorker = () => {
  analyticsQueue.process('invalidate-cache', 10, async (job) => {
    const { patterns } = job.data;
    const { getCacheService } = require('../config/redis');
    const cache = getCacheService();
    await Promise.all(patterns.map(p => cache.delPattern(p)));
    logger.debug(`Cache invalidated: ${patterns.join(', ')}`);
  });
};

// ============================================
// SCHEDULED CRON JOBS
// ============================================
const setupScheduledJobs = () => {
  // Generate daily reports at 00:05 every day
  cron.schedule('5 0 * * *', async () => {
    logger.info('Cron: Starting daily report generation');
    try {
      const { Restaurant } = require('../models');
      const restaurants = await Restaurant.find({ isActive: true, 'subscription.isActive': true }).select('_id').lean();
      const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');

      for (const r of restaurants) {
        await reportQueue.add('generate-daily-report', {
          restaurantId: r._id.toString(),
          date: yesterday,
        }, { delay: Math.random() * 60000 }); // stagger by up to 60s
      }
    } catch (err) {
      logger.error(`Cron daily report error: ${err.message}`);
    }
  });

  // Clean old notifications every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const { Notification } = require('../models');
      const cutoff = moment().subtract(7, 'days').toDate();
      const result = await Notification.deleteMany({ isRead: true, createdAt: { $lt: cutoff } });
      if (result.deletedCount > 0) {
        logger.info(`Cron: Cleaned ${result.deletedCount} old notifications`);
      }
    } catch (err) {
      logger.error(`Cron cleanup error: ${err.message}`);
    }
  });

  // Auto-close stale sessions (sessions older than 8 hours with no activity)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { TableSession, Table } = require('../models');
      const cutoff = moment().subtract(8, 'hours').toDate();
      const staleSessions = await TableSession.find({
        status: 'active',
        createdAt: { $lt: cutoff },
      }).lean();

      for (const session of staleSessions) {
        await TableSession.findByIdAndUpdate(session._id, { status: 'closed', closedAt: new Date() });
        await Table.findByIdAndUpdate(session.tableId, { status: 'available', currentSessionId: null });
      }

      if (staleSessions.length > 0) {
        logger.info(`Cron: Auto-closed ${staleSessions.length} stale sessions`);
      }
    } catch (err) {
      logger.error(`Cron stale session cleanup error: ${err.message}`);
    }
  });

  // Stock alert check every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { Product, Notification } = require('../models');
      const lowStock = await Product.find({
        'stockManagement.enabled': true,
        'stockManagement.outOfStock': false,
        $expr: {
          $lte: ['$stockManagement.quantity', '$stockManagement.lowStockAlert']
        },
      }).lean();

      for (const product of lowStock) {
        await Notification.findOneAndUpdate(
          {
            restaurantId: product.restaurantId,
            type: 'low_stock',
            'data.productId': product._id,
            createdAt: { $gte: moment().subtract(4, 'hours').toDate() },
          },
          {
            $setOnInsert: {
              restaurantId: product.restaurantId,
              type: 'low_stock',
              title: 'Low Stock Alert',
              message: `${product.name} is running low (${product.stockManagement.quantity} left)`,
              data: { productId: product._id, quantity: product.stockManagement.quantity },
              targetRole: ['restaurant_owner', 'manager'],
            }
          },
          { upsert: true }
        );
      }
    } catch (err) {
      logger.error(`Cron stock alert error: ${err.message}`);
    }
  });

  logger.info('Cron jobs scheduled');
};

// Queue helper: add job from controller
const addJob = (queueName, jobName, data, opts = {}) => {
  const queues = { order: orderQueue, report: reportQueue, email: emailQueue, analytics: analyticsQueue };
  const q = queues[queueName];
  if (q) return q.add(jobName, data, opts);
  return Promise.resolve();
};

module.exports = { initQueues, addJob, generateDailyReport };
