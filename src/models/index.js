const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Schema } = mongoose;

// ============================================
// RESTAURANT MODEL
// ============================================
const RestaurantSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  slug: { type: String, unique: true, lowercase: true },
  description: { type: String, maxlength: 500 },
  logo: { type: String },
  coverImage: { type: String },
  cuisine: [{ type: String }],
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    zipCode: String,
    coordinates: {
      lat: Number,
      lng: Number,
    },
  },
  contact: {
    phone: String,
    email: String,
    website: String,
  },
  businessHours: [{
    day: { type: String, enum: ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] },
    open: String,   // "09:00"
    close: String,  // "22:00"
    isClosed: { type: Boolean, default: false },
  }],
  settings: {
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    taxRate: { type: Number, default: 18 }, // GST %
    serviceCharge: { type: Number, default: 0 },
    allowCashPayment: { type: Boolean, default: true },
    allowOnlinePayment: { type: Boolean, default: true },
    orderNotificationEmail: String,
    autoAcceptOrders: { type: Boolean, default: false },
    preparationTimeDefault: { type: Number, default: 20 }, // minutes
    printBillAutomatically: { type: Boolean, default: false },
    allowReviews: { type: Boolean, default: true },
    minOrderAmount: { type: Number, default: 0 },
    maxTableCapacity: { type: Number, default: 10 },
  },
  subscription: {
    plan: { type: String, enum: ['free', 'starter', 'professional', 'enterprise'], default: 'free' },
    startDate: Date,
    endDate: Date,
    isActive: { type: Boolean, default: true },
  },
  isActive: { type: Boolean, default: true },
  isVerified: { type: Boolean, default: false },
  totalOrders: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
  avgRating: { type: Number, default: 0, min: 0, max: 5 },
  totalRatings: { type: Number, default: 0 },
}, { timestamps: true });

RestaurantSchema.index({ slug: 1 });
RestaurantSchema.index({ isActive: 1 });

// ============================================
// ADMIN USER MODEL
// ============================================
const AdminSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: {
    type: String,
    enum: ['super_admin', 'restaurant_owner', 'manager', 'cashier', 'kitchen_staff'],
    default: 'manager',
  },
  permissions: [{
    type: String,
    enum: [
      'view_orders', 'manage_orders', 'view_menu', 'manage_menu',
      'view_tables', 'manage_tables', 'view_reports', 'manage_staff',
      'manage_settings', 'view_analytics', 'manage_payments',
    ],
  }],
  isActive: { type: Boolean, default: true },
  lastLogin: Date,
  refreshToken: { type: String, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date,
}, { timestamps: true });

AdminSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

AdminSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

AdminSchema.methods.isLocked = function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

AdminSchema.index({ restaurantId: 1, role: 1 });

// ============================================
// TABLE MODEL
// ============================================
const TableSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  tableNumber: { type: String, required: true, trim: true },
  displayName: String,
  capacity: { type: Number, default: 4 },
  section: { type: String, default: 'Main' }, // Indoor, Outdoor, VIP
  qrCode: {
    url: String,
    image: String, // base64 or URL
    generatedAt: Date,
    token: String, // unique token per table
  },
  status: {
    type: String,
    enum: ['available', 'occupied', 'reserved', 'maintenance'],
    default: 'available',
  },
  currentSessionId: { type: Schema.Types.ObjectId, ref: 'TableSession' },
  isActive: { type: Boolean, default: true },
  totalOrdersServed: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
}, { timestamps: true });

TableSchema.index({ restaurantId: 1, tableNumber: 1 }, { unique: true });
TableSchema.index({ 'qrCode.token': 1 });

// ============================================
// TABLE SESSION (Anonymous user session)
// ============================================
const TableSessionSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true },
  tableNumber: String,
  sessionToken: { type: String, unique: true, required: true },
  customerName: String,
  customerPhone: String,
  guestCount: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['active', 'waiting_payment', 'paid', 'closed'],
    default: 'active',
  },
  startedAt: { type: Date, default: Date.now },
  closedAt: Date,
  totalAmount: { type: Number, default: 0 },
  notes: String,
}, { timestamps: true });

TableSessionSchema.index({ sessionToken: 1 });
TableSessionSchema.index({ restaurantId: 1, tableId: 1, status: 1 });

// ============================================
// MENU CATEGORY MODEL
// ============================================
const MenuCategorySchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  name: { type: String, required: true, trim: true },
  description: String,
  image: String,
  icon: String,
  sortOrder: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  availableFrom: String, // "09:00" - time-based availability
  availableTo: String,
  availableDays: [{ type: String }],
  parentCategory: { type: Schema.Types.ObjectId, ref: 'MenuCategory' }, // subcategories
}, { timestamps: true });

MenuCategorySchema.index({ restaurantId: 1, sortOrder: 1 });

// ============================================
// PRODUCT / MENU ITEM MODEL
// ============================================
const ProductSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  categoryId: { type: Schema.Types.ObjectId, ref: 'MenuCategory', required: true },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, maxlength: 500 },
  images: [String],
  price: { type: Number, required: true, min: 0 },
  discountedPrice: Number,
  discountPercent: Number,
  costPrice: Number, // for profit calc
  sku: String,
  barcode: String,
  type: {
    type: String,
    enum: ['veg', 'non-veg', 'vegan', 'egg'],
    default: 'veg',
  },
  spiceLevel: {
    type: String,
    enum: ['none', 'mild', 'medium', 'hot', 'extra-hot'],
    default: 'none',
  },
  tags: [String], // ['bestseller', 'chef-special', 'new', 'seasonal']
  allergens: [String],
  nutritionInfo: {
    calories: Number,
    protein: Number,
    carbs: Number,
    fat: Number,
    fiber: Number,
  },
  variants: [{
    name: String,       // "Size: Large"
    options: [{
      label: String,    // "Large"
      priceAddOn: Number, // +50
      isDefault: Boolean,
    }],
  }],
  addOns: [{
    name: String,       // "Extra Toppings"
    maxSelections: Number,
    options: [{
      label: String,
      price: Number,
      isDefault: Boolean,
    }],
  }],
  preparationTime: { type: Number, default: 15 }, // minutes
  isAvailable: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  stockManagement: {
    enabled: { type: Boolean, default: false },
    quantity: { type: Number, default: 0 },
    lowStockAlert: { type: Number, default: 10 },
    outOfStock: { type: Boolean, default: false },
  },
  sortOrder: { type: Number, default: 0 },
  totalOrders: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
  avgRating: { type: Number, default: 0, min: 0, max: 5 },
  totalRatings: { type: Number, default: 0 },
}, { timestamps: true });

ProductSchema.index({ restaurantId: 1, categoryId: 1, isActive: 1 });
ProductSchema.index({ restaurantId: 1, isAvailable: 1 });
ProductSchema.index({ restaurantId: 1, isFeatured: 1 });
ProductSchema.index({ name: 'text', description: 'text', tags: 'text' }); // text search

// ============================================
// ORDER MODEL
// ============================================
const OrderItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: String,
  productImage: String,
  categoryName: String,
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  discountedPrice: Number,
  selectedVariants: [{
    name: String,
    selected: String,
    priceAddOn: Number,
  }],
  selectedAddOns: [{
    name: String,
    selected: [String],
    price: Number,
  }],
  specialInstructions: String,
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled'],
    default: 'pending',
  },
  total: Number,
});

const OrderSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: true },
  sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession' },
  orderNumber: { type: String, unique: true, required: true },
  tableNumber: String,
  customerName: String,
  customerPhone: String,
  guestCount: { type: Number, default: 1 },
  items: [OrderItemSchema],
  status: {
    type: String,
    enum: ['placed', 'confirmed', 'preparing', 'ready', 'served', 'cancelled', 'refunded'],
    default: 'placed',
  },
  orderType: {
    type: String,
    enum: ['dine-in', 'takeaway', 'delivery'],
    default: 'dine-in',
  },
  pricing: {
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    taxRate: Number,
    serviceCharge: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    couponCode: String,
    couponDiscount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    tip: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
  },
  payment: {
    method: { type: String, enum: ['cash', 'card', 'upi', 'online', 'wallet', 'split', 'pending'] },
    status: { type: String, enum: ['pending', 'partial', 'paid', 'failed', 'refunded'], default: 'pending' },
    transactionId: String,
    gatewayOrderId: String,
    gatewayPaymentId: String,
    paidAt: Date,
    splitPayments: [{
      method: String,
      amount: Number,
      transactionId: String,
    }],
  },
  specialInstructions: String,
  estimatedTime: Number, // minutes
  actualServedTime: Date,
  cancelReason: String,
  cancelledBy: String,
  timeline: [{
    status: String,
    timestamp: { type: Date, default: Date.now },
    note: String,
    updatedBy: String,
  }],
  bill: {
    generated: { type: Boolean, default: false },
    generatedAt: Date,
    billNumber: String,
    url: String,
  },
  isRated: { type: Boolean, default: false },
}, { timestamps: true });

OrderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ orderNumber: 1 });
OrderSchema.index({ restaurantId: 1, tableId: 1, status: 1 });
OrderSchema.index({ restaurantId: 1, createdAt: -1 });
OrderSchema.index({ 'payment.status': 1 });

// ============================================
// REVIEW MODEL
// ============================================
const ReviewSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
  sessionId: { type: Schema.Types.ObjectId, ref: 'TableSession' },
  tableNumber: String,
  customerName: { type: String, default: 'Anonymous' },
  type: { type: String, enum: ['product', 'restaurant', 'overall'], default: 'product' },
  rating: { type: Number, required: true, min: 1, max: 5 },
  review: { type: String, maxlength: 500 },
  tags: [String], // ['tasty', 'spicy', 'good-portion', etc.]
  images: [String],
  isVerified: { type: Boolean, default: false }, // verified purchase
  isApproved: { type: Boolean, default: true },
  adminReply: {
    text: String,
    repliedAt: Date,
    repliedBy: String,
  },
  helpful: { type: Number, default: 0 },
}, { timestamps: true });

ReviewSchema.index({ productId: 1, isApproved: 1 });
ReviewSchema.index({ restaurantId: 1, type: 1 });
ReviewSchema.index({ orderId: 1 });

// ============================================
// COUPON MODEL
// ============================================
const CouponSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  code: { type: String, required: true, uppercase: true },
  description: String,
  type: { type: String, enum: ['percentage', 'fixed', 'bogo', 'free_item'], default: 'percentage' },
  value: { type: Number, required: true },
  minOrderAmount: { type: Number, default: 0 },
  maxDiscount: Number, // cap for percentage coupons
  freeItemId: { type: Schema.Types.ObjectId, ref: 'Product' }, // for free_item type
  usageLimit: Number,
  usedCount: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: 1 },
  validFrom: Date,
  validTo: Date,
  applicableCategories: [{ type: Schema.Types.ObjectId, ref: 'MenuCategory' }],
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

CouponSchema.index({ restaurantId: 1, code: 1 }, { unique: true });

// ============================================
// NOTIFICATION MODEL
// ============================================
const NotificationSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  type: {
    type: String,
    enum: ['new_order', 'order_update', 'payment', 'review', 'low_stock', 'system'],
  },
  title: String,
  message: String,
  data: Schema.Types.Mixed,
  isRead: { type: Boolean, default: false },
  readAt: Date,
  targetRole: [String], // which admin roles should see this
}, { timestamps: true });

NotificationSchema.index({ restaurantId: 1, isRead: 1 });

// ============================================
// ANALYTICS / DAILY REPORT MODEL
// ============================================
const DailyReportSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  date: { type: Date, required: true },
  dateString: String, // 'YYYY-MM-DD'
  orders: {
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    cancelled: { type: Number, default: 0 },
    pending: { type: Number, default: 0 },
  },
  revenue: {
    gross: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    serviceCharge: { type: Number, default: 0 },
    discounts: { type: Number, default: 0 },
    tips: { type: Number, default: 0 },
  },
  payments: {
    cash: { type: Number, default: 0 },
    online: { type: Number, default: 0 },
    card: { type: Number, default: 0 },
    upi: { type: Number, default: 0 },
  },
  topProducts: [{
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    quantity: Number,
    revenue: Number,
  }],
  peakHours: [{
    hour: Number,
    orderCount: Number,
  }],
  avgOrderValue: { type: Number, default: 0 },
  tablesUsed: { type: Number, default: 0 },
}, { timestamps: true });

DailyReportSchema.index({ restaurantId: 1, date: -1 }, { unique: true });

// ============================================
// KDS (Kitchen Display System) MODEL
// ============================================
const KDSTicketSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: 'Restaurant', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  orderNumber: String,
  tableNumber: String,
  items: [{
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    quantity: Number,
    variants: [String],
    addOns: [String],
    specialInstructions: String,
    status: { type: String, enum: ['pending', 'preparing', 'ready'], default: 'pending' },
    startedAt: Date,
    completedAt: Date,
  }],
  priority: { type: String, enum: ['normal', 'high', 'rush'], default: 'normal' },
  status: { type: String, enum: ['new', 'in_progress', 'done', 'cancelled'], default: 'new' },
  estimatedTime: Number,
  startedAt: Date,
  completedAt: Date,
  notes: String,
}, { timestamps: true });

KDSTicketSchema.index({ restaurantId: 1, status: 1 });

module.exports = {
  Restaurant: mongoose.model('Restaurant', RestaurantSchema),
  Admin: mongoose.model('Admin', AdminSchema),
  Table: mongoose.model('Table', TableSchema),
  TableSession: mongoose.model('TableSession', TableSessionSchema),
  MenuCategory: mongoose.model('MenuCategory', MenuCategorySchema),
  Product: mongoose.model('Product', ProductSchema),
  Order: mongoose.model('Order', OrderSchema),
  Review: mongoose.model('Review', ReviewSchema),
  Coupon: mongoose.model('Coupon', CouponSchema),
  Notification: mongoose.model('Notification', NotificationSchema),
  DailyReport: mongoose.model('DailyReport', DailyReportSchema),
  KDSTicket: mongoose.model('KDSTicket', KDSTicketSchema),
};
