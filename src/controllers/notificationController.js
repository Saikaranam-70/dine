'use strict';

const { Notification } = require('../models/index');
const { ApiResponse, asyncHandler, getPagination } = require('../utils/apiHelpers');

// GET /api/admin/notifications
exports.getNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const query = { restaurantId: req.restaurantId };

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(query),
    Notification.countDocuments({ restaurantId: req.restaurantId, isRead: false }),
  ]);

  return ApiResponse.paginated(
    res,
    { notifications, unreadCount },
    { page, limit, total },
  );
});

// PATCH /api/admin/notifications/:id/read
exports.markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { isRead: true, readAt: new Date() },
    { new: true },
  );

  if (!notification) return ApiResponse.notFound(res, 'Notification not found');
  return ApiResponse.success(res, { notification }, 'Marked as read');
});

// PATCH /api/admin/notifications/read-all
exports.markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { restaurantId: req.restaurantId, isRead: false },
    { isRead: true, readAt: new Date() },
  );

  return ApiResponse.success(
    res,
    { updated: result.modifiedCount },
    'All notifications marked as read',
  );
});
