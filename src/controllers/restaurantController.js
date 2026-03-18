// ============================================
// RESTAURANT CONTROLLER
// ============================================
const { Restaurant, Admin } = require('../models');
const { ApiResponse, asyncHandler } = require('../utils/apiHelpers');
const { getCacheService, CACHE_KEYS, TTL } = require('../config/redis');
const { uploadImage } = require('../services/cloudinaryService');
const bcrypt = require('bcryptjs');

exports.getRestaurant = asyncHandler(async (req, res) => {
  const cache = getCacheService();
  const cacheKey = CACHE_KEYS.restaurant(req.restaurantId);
  const restaurant = await cache.getOrSet(cacheKey, () =>
    Restaurant.findById(req.restaurantId).lean(), TTL.RESTAURANT
  );
  if (!restaurant) return ApiResponse.notFound(res, 'Restaurant not found');
  return ApiResponse.success(res, { restaurant });
});

exports.getPublicRestaurant = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findOne({
    slug: req.params.slug, isActive: true,
  }).select('name slug logo coverImage cuisine address contact businessHours settings.currency settings.currencySymbol settings.allowCashPayment settings.allowOnlinePayment settings.allowReviews avgRating totalRatings').lean();
  if (!restaurant) return ApiResponse.notFound(res, 'Restaurant not found');
  return ApiResponse.success(res, { restaurant });
});

exports.updateRestaurant = asyncHandler(async (req, res) => {
  const updateData = { ...req.body };

  if (req.files?.logo?.[0]) {
    updateData.logo = await uploadImage(req.files.logo[0], `restaurants/${req.restaurantId}`);
  }
  if (req.files?.coverImage?.[0]) {
    updateData.coverImage = await uploadImage(req.files.coverImage[0], `restaurants/${req.restaurantId}`);
  }

  // Parse nested objects
  ['settings', 'address', 'contact', 'businessHours'].forEach(field => {
    if (typeof updateData[field] === 'string') {
      try { updateData[field] = JSON.parse(updateData[field]); } catch {}
    }
  });

  const restaurant = await Restaurant.findByIdAndUpdate(
    req.restaurantId, { $set: updateData }, { new: true, runValidators: true }
  );

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.restaurant(req.restaurantId));

  return ApiResponse.success(res, { restaurant }, 'Restaurant updated');
});

exports.registerRestaurant = asyncHandler(async (req, res) => {
  const { restaurantName, ownerName, email, password, phone, address } = req.body;

  const existing = await Admin.findOne({ email: email.toLowerCase() });
  if (existing) return ApiResponse.error(res, 'Email already registered', 400);

  const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') + '-' + Date.now().toString(36);

  const restaurant = await Restaurant.create({
    name: restaurantName, slug,
    contact: { phone, email },
    address: address || {},
  });

  const admin = await Admin.create({
    restaurantId: restaurant._id,
    name: ownerName,
    email: email.toLowerCase(),
    password,
    role: 'restaurant_owner',
    permissions: ['view_orders', 'manage_orders', 'view_menu', 'manage_menu',
      'view_tables', 'manage_tables', 'view_reports', 'manage_staff',
      'manage_settings', 'view_analytics', 'manage_payments'],
  });

  return ApiResponse.created(res, {
    restaurant: { id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
    admin: { id: admin._id, email: admin.email, role: admin.role },
  }, 'Restaurant registered successfully');
});
