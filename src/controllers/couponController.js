'use strict';

const { Coupon } = require('../models/index');
const { ApiResponse, asyncHandler, getPagination } = require('../utils/apiHelpers');

// GET /api/admin/coupons
exports.getCoupons = asyncHandler(async (req, res) => {
  const { isActive } = req.query;
  const query = { restaurantId: req.restaurantId };
  if (isActive !== undefined) query.isActive = isActive === 'true';

  const coupons = await Coupon.find(query).sort({ createdAt: -1 }).lean();
  return ApiResponse.success(res, { coupons });
});

// POST /api/admin/coupons
exports.createCoupon = asyncHandler(async (req, res) => {
  const code = req.body.code?.toUpperCase();

  const existing = await Coupon.findOne({ restaurantId: req.restaurantId, code });
  if (existing) return ApiResponse.error(res, 'Coupon code already exists', 400);

  const coupon = await Coupon.create({
    ...req.body,
    restaurantId: req.restaurantId,
    code,
  });

  return ApiResponse.created(res, { coupon }, 'Coupon created');
});

// PUT /api/admin/coupons/:id
exports.updateCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { $set: req.body },
    { new: true, runValidators: true },
  );

  if (!coupon) return ApiResponse.notFound(res, 'Coupon not found');
  return ApiResponse.success(res, { coupon }, 'Coupon updated');
});

// DELETE /api/admin/coupons/:id
exports.deleteCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOneAndDelete({
    _id: req.params.id,
    restaurantId: req.restaurantId,
  });

  if (!coupon) return ApiResponse.notFound(res, 'Coupon not found');
  return ApiResponse.success(res, {}, 'Coupon deleted');
});

// PATCH /api/admin/coupons/:id/toggle
exports.toggleCoupon = asyncHandler(async (req, res) => {
  const coupon = await Coupon.findOne({
    _id: req.params.id,
    restaurantId: req.restaurantId,
  });

  if (!coupon) return ApiResponse.notFound(res, 'Coupon not found');

  coupon.isActive = !coupon.isActive;
  await coupon.save();

  return ApiResponse.success(
    res,
    { isActive: coupon.isActive },
    `Coupon ${coupon.isActive ? 'activated' : 'deactivated'}`,
  );
});
