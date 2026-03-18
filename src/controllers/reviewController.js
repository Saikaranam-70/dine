const { Review, Product, Order, Restaurant } = require('../models');
const { ApiResponse, asyncHandler, getPagination } = require('../utils/apiHelpers');
const { getCacheService, CACHE_KEYS, TTL } = require('../config/redis');

// POST /api/reviews (customer - no auth, just session)
exports.submitReview = asyncHandler(async (req, res) => {
  const { productId, orderId, rating, review, tags, customerName, type = 'product' } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    return ApiResponse.error(res, 'Rating must be between 1 and 5', 400);
  }

  // Verify order belongs to session (if orderId provided)
  if (orderId) {
    const order = await Order.findOne({ _id: orderId, sessionId: req.session._id });
    if (!order) return ApiResponse.error(res, 'Order not found for this session', 400);

    // Prevent duplicate review per order+product
    const exists = await Review.findOne({ orderId, productId, sessionId: req.session._id });
    if (exists) return ApiResponse.error(res, 'You already reviewed this item', 400);
  }

  const reviewDoc = await Review.create({
    restaurantId: req.restaurantId,
    productId: productId || undefined,
    orderId: orderId || undefined,
    sessionId: req.session._id,
    tableNumber: req.session.tableNumber,
    customerName: customerName || 'Anonymous',
    type,
    rating,
    review,
    tags: tags || [],
    isVerified: !!orderId,
  });

  // Update product rating
  if (productId) {
    const stats = await Review.aggregate([
      { $match: { productId: require('mongoose').Types.ObjectId.createFromHexString(productId), isApproved: true } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);

    if (stats.length > 0) {
      await Product.findByIdAndUpdate(productId, {
        avgRating: Math.round(stats[0].avgRating * 10) / 10,
        totalRatings: stats[0].count,
      });
    }

    const cache = getCacheService();
    await cache.del(CACHE_KEYS.product(productId));
    await cache.del(CACHE_KEYS.reviewsByProduct(productId));
  }

  // Update restaurant rating
  const restStats = await Review.aggregate([
    { $match: { restaurantId: req.session.restaurantId, type: 'overall', isApproved: true } },
    { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
  ]);
  if (restStats.length > 0) {
    await Restaurant.findByIdAndUpdate(req.restaurantId, {
      avgRating: Math.round(restStats[0].avgRating * 10) / 10,
      totalRatings: restStats[0].count,
    });
  }

  return ApiResponse.created(res, { review: reviewDoc }, 'Thank you for your review!');
});

// GET /api/menu/:restaurantId/products/:productId/reviews (public)
exports.getProductReviews = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { page, limit, skip } = getPagination(req.query);
  const cache = getCacheService();
  const cacheKey = `${CACHE_KEYS.reviewsByProduct(productId)}:${page}:${limit}`;

  const data = await cache.getOrSet(cacheKey, async () => {
    const [reviews, total, stats] = await Promise.all([
      Review.find({ productId, isApproved: true })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Review.countDocuments({ productId, isApproved: true }),
      Review.aggregate([
        { $match: { productId: require('mongoose').Types.ObjectId.createFromHexString(productId), isApproved: true } },
        {
          $group: {
            _id: '$rating',
            count: { $sum: 1 },
          }
        }
      ])
    ]);

    const ratingBreakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    stats.forEach(s => { ratingBreakdown[s._id] = s.count; });

    return { reviews, total, ratingBreakdown };
  }, TTL.REVIEWS);

  return ApiResponse.paginated(res, { reviews: data.reviews, ratingBreakdown: data.ratingBreakdown }, {
    page, limit, total: data.total,
  });
});

// GET /api/admin/reviews (admin)
exports.adminGetReviews = asyncHandler(async (req, res) => {
  const { isApproved, type, productId, rating, dateFrom, dateTo } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const query = { restaurantId: req.restaurantId };
  if (isApproved !== undefined) query.isApproved = isApproved === 'true';
  if (type) query.type = type;
  if (productId) query.productId = productId;
  if (rating) query.rating = parseInt(rating);
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  const [reviews, total] = await Promise.all([
    Review.find(query)
      .populate('productId', 'name images')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Review.countDocuments(query),
  ]);

  return ApiResponse.paginated(res, { reviews }, { page, limit, total });
});

// PATCH /api/admin/reviews/:id/reply
exports.replyToReview = asyncHandler(async (req, res) => {
  const { text } = req.body;
  const review = await Review.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    {
      $set: {
        adminReply: { text, repliedAt: new Date(), repliedBy: req.admin.name },
      }
    },
    { new: true }
  );
  if (!review) return ApiResponse.notFound(res, 'Review not found');

  const cache = getCacheService();
  if (review.productId) await cache.delPattern(`reviews:product:${review.productId}*`);

  return ApiResponse.success(res, { review }, 'Reply added');
});

// PATCH /api/admin/reviews/:id/approve
exports.approveReview = asyncHandler(async (req, res) => {
  const review = await Review.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { isApproved: true },
    { new: true }
  );
  if (!review) return ApiResponse.notFound(res, 'Review not found');

  const cache = getCacheService();
  if (review.productId) await cache.delPattern(`reviews:product:${review.productId}*`);

  return ApiResponse.success(res, { review }, 'Review approved');
});

// DELETE /api/admin/reviews/:id
exports.deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findOneAndDelete({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!review) return ApiResponse.notFound(res, 'Review not found');

  const cache = getCacheService();
  if (review.productId) await cache.delPattern(`reviews:product:${review.productId}*`);

  return ApiResponse.success(res, {}, 'Review deleted');
});
