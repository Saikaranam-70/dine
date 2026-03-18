const { Product, MenuCategory, Restaurant } = require('../models');
const { ApiResponse, asyncHandler, getPagination, buildSortQuery, AppError } = require('../utils/apiHelpers');
const { getCacheService, CACHE_KEYS, TTL } = require('../config/redis');
const { uploadImage, deleteImage } = require('../services/cloudinaryService');
const logger = require('../utils/logger');

// ============================================
// MENU CATEGORIES
// ============================================

// GET /api/menu/:restaurantId/categories
exports.getCategories = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const cache = getCacheService();
  const cacheKey = `categories:${restaurantId}`;

  const categories = await cache.getOrSet(cacheKey, async () => {
    return MenuCategory.find({ restaurantId, isActive: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
  }, TTL.MENU);

  return ApiResponse.success(res, { categories });
});

// POST /api/admin/menu/categories
exports.createCategory = asyncHandler(async (req, res) => {
  const { name, description, sortOrder, availableFrom, availableTo, availableDays, parentCategory } = req.body;

  let image;
  if (req.file) {
    image = await uploadImage(req.file, `restaurants/${req.restaurantId}/categories`);
  }

  const category = await MenuCategory.create({
    restaurantId: req.restaurantId,
    name, description, sortOrder, availableFrom, availableTo,
    availableDays: availableDays ? JSON.parse(availableDays) : undefined,
    parentCategory, image,
  });

  // Invalidate cache
  const cache = getCacheService();
  await cache.delPattern(`categories:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.created(res, { category }, 'Category created');
});

// PUT /api/admin/menu/categories/:id
exports.updateCategory = asyncHandler(async (req, res) => {
  const category = await MenuCategory.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!category) return ApiResponse.notFound(res, 'Category not found');

  const cache = getCacheService();
  await cache.delPattern(`categories:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.success(res, { category }, 'Category updated');
});

// DELETE /api/admin/menu/categories/:id
exports.deleteCategory = asyncHandler(async (req, res) => {
  const productCount = await Product.countDocuments({ categoryId: req.params.id, isActive: true });
  if (productCount > 0) {
    return ApiResponse.error(res, `Cannot delete: ${productCount} active products in this category`, 400);
  }

  await MenuCategory.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { isActive: false }
  );

  const cache = getCacheService();
  await cache.delPattern(`categories:${req.restaurantId}*`);

  return ApiResponse.success(res, {}, 'Category deleted');
});

// ============================================
// PRODUCTS
// ============================================

// GET /api/menu/:restaurantId/products (public)
exports.getMenuProducts = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const { categoryId, search, type, tags, page, limit } = req.query;
  const cache = getCacheService();

  // Full menu (all categories) with no filters - serve from cache
  if (!categoryId && !search && !type && !tags && !page) {
    const cacheKey = CACHE_KEYS.restaurantMenu(restaurantId);
    const cachedMenu = await cache.get(cacheKey);
    if (cachedMenu) {
      return ApiResponse.success(res, cachedMenu, 'Menu fetched', 200, { cached: true });
    }
  }

  const { page: pg, limit: lim, skip } = getPagination(req.query);
  const query = { restaurantId, isActive: true, isAvailable: true };

  if (categoryId) query.categoryId = categoryId;
  if (type) query.type = type;
  if (tags) query.tags = { $in: tags.split(',') };
  if (search) {
    query.$text = { $search: search };
  }

  const [products, total] = await Promise.all([
    Product.find(query)
      .populate('categoryId', 'name sortOrder')
      .sort(search ? { score: { $meta: 'textScore' } } : { sortOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    Product.countDocuments(query),
  ]);

  // Cache full menu without filters
  if (!categoryId && !search && !type && !tags && pg === 1) {
    const categories = await MenuCategory.find({ restaurantId, isActive: true })
      .sort({ sortOrder: 1 }).lean();
    const menuByCategory = categories.map(cat => ({
      category: cat,
      products: products.filter(p => p.categoryId?._id?.toString() === cat._id.toString()),
    }));
    const cache = getCacheService();
    await cache.set(CACHE_KEYS.restaurantMenu(restaurantId), { menu: menuByCategory, products }, TTL.MENU);
  }

  return ApiResponse.paginated(res, { products }, { page: pg, limit: lim, total });
});

// GET /api/menu/:restaurantId/products/:productId (public)
exports.getProduct = asyncHandler(async (req, res) => {
  const { restaurantId, productId } = req.params;
  const cache = getCacheService();
  const cacheKey = CACHE_KEYS.product(productId);

  const product = await cache.getOrSet(cacheKey, async () => {
    return Product.findOne({ _id: productId, restaurantId, isActive: true })
      .populate('categoryId', 'name')
      .lean();
  }, TTL.PRODUCTS);

  if (!product) return ApiResponse.notFound(res, 'Product not found');

  return ApiResponse.success(res, { product });
});

// GET /api/admin/menu/products (admin)
exports.adminGetProducts = asyncHandler(async (req, res) => {
  const { categoryId, search, isActive, isAvailable, isFeatured, sortBy } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const query = { restaurantId: req.restaurantId };
  if (categoryId) query.categoryId = categoryId;
  if (isActive !== undefined) query.isActive = isActive === 'true';
  if (isAvailable !== undefined) query.isAvailable = isAvailable === 'true';
  if (isFeatured !== undefined) query.isFeatured = isFeatured === 'true';
  if (search) query.$text = { $search: search };

  const sortAllowed = ['name', 'price', 'totalOrders', 'totalRevenue', 'avgRating', 'createdAt', 'sortOrder'];
  const sort = buildSortQuery(sortBy, sortAllowed);

  const [products, total] = await Promise.all([
    Product.find(query)
      .populate('categoryId', 'name')
      .sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(query),
  ]);

  return ApiResponse.paginated(res, { products }, { page, limit, total });
});

// POST /api/admin/menu/products
exports.createProduct = asyncHandler(async (req, res) => {
  const {
    categoryId, name, description, price, discountedPrice, type, spiceLevel,
    tags, allergens, nutritionInfo, variants, addOns, preparationTime,
    isAvailable, isFeatured, sortOrder, costPrice, stockManagement
  } = req.body;

  const category = await MenuCategory.findOne({ _id: categoryId, restaurantId: req.restaurantId });
  if (!category) return ApiResponse.error(res, 'Category not found', 400);

  let images = [];
  if (req.files?.length > 0) {
    const uploads = await Promise.all(
      req.files.map(f => uploadImage(f, `restaurants/${req.restaurantId}/products`))
    );
    images = uploads;
  }

  const discountPercent = discountedPrice && price
    ? Math.round(((price - discountedPrice) / price) * 100)
    : 0;

  const product = await Product.create({
    restaurantId: req.restaurantId,
    categoryId, name, description, price,
    discountedPrice: discountedPrice || undefined,
    discountPercent,
    costPrice,
    type, spiceLevel,
    tags: tags ? JSON.parse(tags) : [],
    allergens: allergens ? JSON.parse(allergens) : [],
    nutritionInfo: nutritionInfo ? JSON.parse(nutritionInfo) : undefined,
    variants: variants ? JSON.parse(variants) : [],
    addOns: addOns ? JSON.parse(addOns) : [],
    preparationTime, isAvailable, isFeatured, sortOrder, images,
    stockManagement: stockManagement ? JSON.parse(stockManagement) : undefined,
  });

  // Invalidate caches
  const cache = getCacheService();
  await cache.delPattern(`products:restaurant:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);
  await cache.delPattern(`categories:${req.restaurantId}*`);

  return ApiResponse.created(res, { product }, 'Product created successfully');
});

// PUT /api/admin/menu/products/:id
exports.updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!product) return ApiResponse.notFound(res, 'Product not found');

  const updateData = { ...req.body };
  // Parse JSON strings from FormData
  ['tags', 'allergens', 'nutritionInfo', 'variants', 'addOns', 'stockManagement'].forEach(field => {
    if (typeof updateData[field] === 'string') {
      try { updateData[field] = JSON.parse(updateData[field]); } catch {}
    }
  });

  if (req.files?.length > 0) {
    const uploads = await Promise.all(
      req.files.map(f => uploadImage(f, `restaurants/${req.restaurantId}/products`))
    );
    updateData.images = [...(product.images || []), ...uploads];
  }

  if (updateData.price && updateData.discountedPrice) {
    updateData.discountPercent = Math.round(
      ((updateData.price - updateData.discountedPrice) / updateData.price) * 100
    );
  }

  const updated = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).populate('categoryId', 'name');

  // Invalidate cache
  const cache = getCacheService();
  await cache.del(CACHE_KEYS.product(req.params.id));
  await cache.delPattern(`products:restaurant:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.success(res, { product: updated }, 'Product updated');
});

// DELETE /api/admin/menu/products/:id
exports.deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, restaurantId: req.restaurantId },
    { isActive: false },
    { new: true }
  );
  if (!product) return ApiResponse.notFound(res, 'Product not found');

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.product(req.params.id));
  await cache.delPattern(`products:restaurant:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.success(res, {}, 'Product deleted');
});

// PATCH /api/admin/menu/products/:id/toggle-availability
exports.toggleAvailability = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, restaurantId: req.restaurantId });
  if (!product) return ApiResponse.notFound(res, 'Product not found');

  product.isAvailable = !product.isAvailable;
  await product.save();

  const cache = getCacheService();
  await cache.del(CACHE_KEYS.product(req.params.id));
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.success(res, {
    isAvailable: product.isAvailable,
  }, `Product ${product.isAvailable ? 'available' : 'unavailable'}`);
});

// PATCH /api/admin/menu/products/bulk-update
exports.bulkUpdateProducts = asyncHandler(async (req, res) => {
  const { ids, updates } = req.body;
  if (!ids?.length) return ApiResponse.error(res, 'Product IDs required', 400);

  const result = await Product.updateMany(
    { _id: { $in: ids }, restaurantId: req.restaurantId },
    { $set: updates }
  );

  const cache = getCacheService();
  await cache.delPattern(`products:restaurant:${req.restaurantId}*`);
  await cache.delPattern(`restaurant:${req.restaurantId}:menu*`);

  return ApiResponse.success(res, {
    modified: result.modifiedCount,
  }, `${result.modifiedCount} products updated`);
});

// GET /api/menu/:restaurantId/featured
exports.getFeaturedProducts = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const cache = getCacheService();
  const cacheKey = `featured:${restaurantId}`;

  const products = await cache.getOrSet(cacheKey, async () => {
    return Product.find({ restaurantId, isFeatured: true, isActive: true, isAvailable: true })
      .populate('categoryId', 'name')
      .sort({ totalOrders: -1 })
      .limit(12)
      .lean();
  }, TTL.PRODUCTS);

  return ApiResponse.success(res, { products });
});

// GET /api/menu/:restaurantId/search
exports.searchProducts = asyncHandler(async (req, res) => {
  const { restaurantId } = req.params;
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return ApiResponse.error(res, 'Search query must be at least 2 characters', 400);
  }

  const products = await Product.find({
    restaurantId,
    isActive: true,
    isAvailable: true,
    $text: { $search: q },
  }, { score: { $meta: 'textScore' } })
    .populate('categoryId', 'name')
    .sort({ score: { $meta: 'textScore' } })
    .limit(20)
    .lean();

  return ApiResponse.success(res, { products, query: q });
});
