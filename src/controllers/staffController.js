'use strict';

const { Admin } = require('../models/index');
const { ApiResponse, asyncHandler } = require('../utils/apiHelpers');
const { getCacheService } = require('../config/redis');

// ─── Helper ────────────────────────────────────────────────────────────────
function getDefaultPermissions(role) {
  const map = {
    manager: [
      'view_orders', 'manage_orders', 'view_menu', 'manage_menu',
      'view_tables', 'manage_tables', 'view_reports', 'view_analytics',
    ],
    cashier: ['view_orders', 'manage_orders', 'manage_payments', 'view_tables'],
    kitchen_staff: ['view_orders', 'manage_orders'],
  };
  return map[role] || [];
}

// GET /api/admin/staff
exports.getStaff = asyncHandler(async (req, res) => {
  const staff = await Admin.find({
    restaurantId: req.restaurantId,
    role: { $ne: 'super_admin' },
  })
    .select('-password -refreshToken')
    .sort({ createdAt: -1 })
    .lean();

  return ApiResponse.success(res, { staff });
});

// POST /api/admin/staff
exports.createStaff = asyncHandler(async (req, res) => {
  const { name, email, password, role, permissions } = req.body;

  const exists = await Admin.findOne({ email: email.toLowerCase() });
  if (exists) return ApiResponse.error(res, 'Email already exists', 400);

  const staff = await Admin.create({
    restaurantId: req.restaurantId,
    name,
    email: email.toLowerCase(),
    password,
    role,
    permissions: permissions || getDefaultPermissions(role),
  });

  return ApiResponse.created(res, {
    staff: {
      id: staff._id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      permissions: staff.permissions,
    },
  }, 'Staff member created');
});

// PUT /api/admin/staff/:id
exports.updateStaff = asyncHandler(async (req, res) => {
  const { name, role, permissions, isActive } = req.body;

  const staff = await Admin.findOneAndUpdate(
    {
      _id: req.params.id,
      restaurantId: req.restaurantId,
      role: { $ne: 'restaurant_owner' },
    },
    { $set: { name, role, permissions, isActive } },
    { new: true, runValidators: true },
  ).select('-password -refreshToken');

  if (!staff) return ApiResponse.notFound(res, 'Staff member not found');

  // Invalidate cache
  const cache = getCacheService();
  await cache.del(`admin:${staff._id}`);

  return ApiResponse.success(res, { staff }, 'Staff member updated');
});

// DELETE /api/admin/staff/:id
exports.deleteStaff = asyncHandler(async (req, res) => {
  const staff = await Admin.findOneAndDelete({
    _id: req.params.id,
    restaurantId: req.restaurantId,
    role: { $ne: 'restaurant_owner' },
  });

  if (!staff) return ApiResponse.notFound(res, 'Staff member not found');

  const cache = getCacheService();
  await cache.del(`admin:${staff._id}`);

  return ApiResponse.success(res, {}, 'Staff member deleted');
});

// PATCH /api/admin/staff/:id/toggle
exports.toggleStaff = asyncHandler(async (req, res) => {
  const staff = await Admin.findOne({
    _id: req.params.id,
    restaurantId: req.restaurantId,
    role: { $ne: 'restaurant_owner' },
  });

  if (!staff) return ApiResponse.notFound(res, 'Staff member not found');

  staff.isActive = !staff.isActive;
  await staff.save({ validateBeforeSave: false });

  const cache = getCacheService();
  await cache.del(`admin:${staff._id}`);

  return ApiResponse.success(
    res,
    { isActive: staff.isActive },
    `Staff member ${staff.isActive ? 'activated' : 'deactivated'}`,
  );
});
