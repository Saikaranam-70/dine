'use strict';

const express = require('express');

// ─── Controllers ─────────────────────────────────────────────────────────────
const adminAuthController    = require('../controllers/adminAuthController');
const menuController         = require('../controllers/menuController');
const tableController        = require('../controllers/tableController');
const orderController        = require('../controllers/orderController');
const reviewController       = require('../controllers/reviewController');
const paymentController      = require('../controllers/paymentController');
const analyticsController    = require('../controllers/analyticsController');
const restaurantController   = require('../controllers/restaurantController');
const staffController        = require('../controllers/staffController');
const couponController       = require('../controllers/couponController');
const notificationController = require('../controllers/notificationController');
const billController         = require('../controllers/billController');

// ─── Middleware ───────────────────────────────────────────────────────────────
const {
  authenticateAdmin,
  authenticateSession,
  requirePermission,
  rateLimiters,
} = require('../middleware/index');

// ─── Services ────────────────────────────────────────────────────────────────
const { upload } = require('../services/cloudinaryService');

// =============================================================================
// AUTH ROUTES  (/api/admin/auth/...)
// =============================================================================
const authRoutes = express.Router();

/**
 * @swagger
 * /admin/auth/login:
 *   post:
 *     summary: Admin login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *     responses:
 *       200:
 *         description: Login successful
 */
authRoutes.post('/login',                rateLimiters.auth, adminAuthController.login);
authRoutes.post('/refresh',                                 adminAuthController.refreshToken);
authRoutes.post('/logout',               authenticateAdmin, adminAuthController.logout);
authRoutes.post('/forgot-password',      rateLimiters.auth, adminAuthController.forgotPassword);
authRoutes.patch('/reset-password/:token',                  adminAuthController.resetPassword);
authRoutes.patch('/change-password',     authenticateAdmin, adminAuthController.changePassword);
authRoutes.get('/me',                    authenticateAdmin, adminAuthController.getMe);

// =============================================================================
// PUBLIC MENU ROUTES  (/api/menu/:restaurantId/...)
// =============================================================================
const publicMenuRoutes = express.Router({ mergeParams: true });

publicMenuRoutes.get('/categories',         rateLimiters.menu, menuController.getCategories);
publicMenuRoutes.get('/products',           rateLimiters.menu, menuController.getMenuProducts);
publicMenuRoutes.get('/products/featured',  rateLimiters.menu, menuController.getFeaturedProducts);
publicMenuRoutes.get('/products/search',    rateLimiters.menu, menuController.searchProducts);
publicMenuRoutes.get('/products/:productId',rateLimiters.menu, menuController.getProduct);

// =============================================================================
// ADMIN MENU ROUTES  (/api/admin/menu/...)
// =============================================================================
const adminMenuRoutes = express.Router();
adminMenuRoutes.use(authenticateAdmin);

// Categories
adminMenuRoutes.get   ('/categories',    requirePermission('view_menu'),   menuController.getCategories);
adminMenuRoutes.post  ('/categories',    requirePermission('manage_menu'), upload.single('image'), menuController.createCategory);
adminMenuRoutes.put   ('/categories/:id',requirePermission('manage_menu'), upload.single('image'), menuController.updateCategory);
adminMenuRoutes.delete('/categories/:id',requirePermission('manage_menu'), menuController.deleteCategory);

// Products
adminMenuRoutes.get   ('/products',             requirePermission('view_menu'),   menuController.adminGetProducts);
adminMenuRoutes.post  ('/products',             requirePermission('manage_menu'), upload.array('images', 5), menuController.createProduct);
adminMenuRoutes.put   ('/products/:id',          requirePermission('manage_menu'), upload.array('images', 5), menuController.updateProduct);
adminMenuRoutes.delete('/products/:id',          requirePermission('manage_menu'), menuController.deleteProduct);
adminMenuRoutes.patch ('/products/:id/toggle',   requirePermission('manage_menu'), menuController.toggleAvailability);
adminMenuRoutes.patch ('/products/bulk-update',  requirePermission('manage_menu'), menuController.bulkUpdateProducts);

// =============================================================================
// PUBLIC TABLE ROUTES  (/api/tables/...)
// =============================================================================
const tablePublicRoutes = express.Router();

tablePublicRoutes.get  ('/scan/:token',              tableController.scanQR);
tablePublicRoutes.patch('/session',          authenticateSession, tableController.updateSession);
tablePublicRoutes.get  ('/session/summary',  authenticateSession, tableController.getSessionSummary);
tablePublicRoutes.post ('/session/request-bill', authenticateSession, tableController.requestBill);
tablePublicRoutes.post ('/session/call-waiter',  authenticateSession, tableController.callWaiter);

// =============================================================================
// ADMIN TABLE ROUTES  (/api/admin/tables/...)
// =============================================================================
const adminTableRoutes = express.Router();
adminTableRoutes.use(authenticateAdmin);

adminTableRoutes.get  ('/',                       requirePermission('view_tables'),   tableController.adminGetTables);
adminTableRoutes.post ('/',                       requirePermission('manage_tables'), tableController.createTable);
adminTableRoutes.put  ('/:tableId',               requirePermission('manage_tables'), tableController.updateTable);
adminTableRoutes.delete('/:tableId',              requirePermission('manage_tables'), tableController.deleteTable);
adminTableRoutes.post ('/:tableId/regenerate-qr', requirePermission('manage_tables'), tableController.regenerateQR);
adminTableRoutes.get  ('/sessions',               requirePermission('view_tables'),   tableController.getSessions);
adminTableRoutes.post ('/sessions/:sessionId/close', requirePermission('manage_tables'), tableController.closeSession);
adminTableRoutes.get('/sessions/:sessionId/bill', requirePermission('manage_orders'), billController.adminGetSessionBill);

// =============================================================================
// CUSTOMER ORDER ROUTES  (/api/orders/...)
// =============================================================================
const orderCustomerRoutes = express.Router();
orderCustomerRoutes.use(authenticateSession);

orderCustomerRoutes.post('/',              rateLimiters.order, orderController.placeOrder);
orderCustomerRoutes.get ('/',                                  orderController.getSessionOrders);
orderCustomerRoutes.get ('/:orderId/status',                   orderController.getOrderStatus);

// =============================================================================
// ADMIN ORDER ROUTES  (/api/admin/orders/...)
// =============================================================================
const adminOrderRoutes = express.Router();
adminOrderRoutes.use(authenticateAdmin);

adminOrderRoutes.get   ('/',                     requirePermission('view_orders'),    orderController.adminGetOrders);
adminOrderRoutes.get   ('/live',                 requirePermission('view_orders'),    orderController.getLiveOrders);
adminOrderRoutes.get   ('/:orderId',             requirePermission('view_orders'),    orderController.adminGetOrder);
adminOrderRoutes.patch ('/:orderId/status',      requirePermission('manage_orders'),  orderController.updateOrderStatus);
adminOrderRoutes.patch ('/:orderId/cancel',      requirePermission('manage_orders'),  orderController.cancelOrder);
adminOrderRoutes.post  ('/:orderId/bill',        requirePermission('manage_orders'),  orderController.generateBill);
adminOrderRoutes.patch ('/:orderId/payment',     requirePermission('manage_payments'),orderController.markPayment);
adminOrderRoutes.patch ('/:orderId/items',       requirePermission('manage_orders'),  orderController.updateItemStatus);
adminOrderRoutes.get('/:orderId/bill', requirePermission('manage_orders'), billController.adminGetOrderBill);

// =============================================================================
// CUSTOMER REVIEW ROUTES  (/api/reviews/...)
// =============================================================================
const reviewCustomerRoutes = express.Router();

reviewCustomerRoutes.post('/',                      authenticateSession, rateLimiters.review, reviewController.submitReview);
reviewCustomerRoutes.get ('/products/:productId',   reviewController.getProductReviews);

// =============================================================================
// ADMIN REVIEW ROUTES  (/api/admin/reviews/...)
// =============================================================================
const adminReviewRoutes = express.Router();
adminReviewRoutes.use(authenticateAdmin);

adminReviewRoutes.get   ('/',           requirePermission('view_orders'),   reviewController.adminGetReviews);
adminReviewRoutes.patch ('/:id/reply',  requirePermission('manage_orders'), reviewController.replyToReview);
adminReviewRoutes.patch ('/:id/approve',requirePermission('manage_orders'), reviewController.approveReview);
adminReviewRoutes.delete('/:id',        requirePermission('manage_orders'), reviewController.deleteReview);

// =============================================================================
// PAYMENT ROUTES  (/api/payments/...)
// =============================================================================
const paymentRoutes = express.Router();

paymentRoutes.post('/initiate',           authenticateSession, rateLimiters.payment, paymentController.initiatePayment);
paymentRoutes.post('/verify/razorpay',    authenticateSession, paymentController.verifyRazorpayPayment);
paymentRoutes.post('/apply-coupon',       authenticateSession, paymentController.applyCoupon);
// Stripe webhook — raw body handled in app.js before JSON parser
paymentRoutes.post('/webhook/stripe',     express.raw({ type: 'application/json' }), paymentController.stripeWebhook);

// Admin payment actions
const adminPaymentRoutes = express.Router();
adminPaymentRoutes.use(authenticateAdmin);
adminPaymentRoutes.post('/refund', requirePermission('manage_payments'), paymentController.initiateRefund);

// =============================================================================
// ADMIN ANALYTICS ROUTES  (/api/admin/analytics/...)
// =============================================================================
const adminAnalyticsRoutes = express.Router();
adminAnalyticsRoutes.use(authenticateAdmin);

adminAnalyticsRoutes.get('/dashboard', requirePermission('view_analytics'), analyticsController.getDashboard);
adminAnalyticsRoutes.get('/sales',     requirePermission('view_analytics'), analyticsController.getSalesSummary);
adminAnalyticsRoutes.get('/products',  requirePermission('view_analytics'), analyticsController.getProductAnalytics);
adminAnalyticsRoutes.get('/report',    requirePermission('view_reports'),   analyticsController.generateReport);

// =============================================================================
// RESTAURANT ROUTES  (/api/admin/restaurant/...)
// =============================================================================
const adminRestaurantRoutes = express.Router();
adminRestaurantRoutes.use(authenticateAdmin);

adminRestaurantRoutes.get('/',   restaurantController.getRestaurant);
adminRestaurantRoutes.put('/',   requirePermission('manage_settings'),
  upload.fields([
    { name: 'logo',       maxCount: 1 },
    { name: 'coverImage', maxCount: 1 },
  ]),
  restaurantController.updateRestaurant,
);

// Public — no auth
const restaurantPublicRoutes = express.Router();
restaurantPublicRoutes.post('/register',   restaurantController.registerRestaurant);
restaurantPublicRoutes.get ('/:slug',      restaurantController.getPublicRestaurant);

// =============================================================================
// STAFF ROUTES  (/api/admin/staff/...)
// =============================================================================
const adminStaffRoutes = express.Router();
adminStaffRoutes.use(authenticateAdmin);

adminStaffRoutes.get   ('/',          requirePermission('manage_staff'), staffController.getStaff);
adminStaffRoutes.post  ('/',          requirePermission('manage_staff'), staffController.createStaff);
adminStaffRoutes.put   ('/:id',       requirePermission('manage_staff'), staffController.updateStaff);
adminStaffRoutes.delete('/:id',       requirePermission('manage_staff'), staffController.deleteStaff);
adminStaffRoutes.patch ('/:id/toggle',requirePermission('manage_staff'), staffController.toggleStaff);

// =============================================================================
// COUPON ROUTES  (/api/admin/coupons/...)
// =============================================================================
const adminCouponRoutes = express.Router();
adminCouponRoutes.use(authenticateAdmin);

adminCouponRoutes.get   ('/',          couponController.getCoupons);
adminCouponRoutes.post  ('/',          couponController.createCoupon);
adminCouponRoutes.put   ('/:id',       couponController.updateCoupon);
adminCouponRoutes.delete('/:id',       couponController.deleteCoupon);
adminCouponRoutes.patch ('/:id/toggle',couponController.toggleCoupon);

// =============================================================================
// NOTIFICATION ROUTES  (/api/admin/notifications/...)
// =============================================================================
const adminNotificationRoutes = express.Router();
adminNotificationRoutes.use(authenticateAdmin);

adminNotificationRoutes.get  ('/',          notificationController.getNotifications);
adminNotificationRoutes.patch('/read-all',  notificationController.markAllRead);
adminNotificationRoutes.patch('/:id/read',  notificationController.markRead);

// =============================================================================
// BILL ROUTES  (/api/bills/...)
// =============================================================================
const billRoutes = express.Router();

billRoutes.get('/:orderId/receipt',  billController.getReceipt);
billRoutes.get('/:orderId/download', billController.downloadBill);

// =============================================================================
// EXPORTS
// =============================================================================
module.exports = {
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
};
