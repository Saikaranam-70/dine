'use strict';
require('dotenv').config();

const mongoose = require('mongoose');
const QRCode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  Restaurant, Admin, Table,
  MenuCategory, Product, Coupon,
} = require('../src/models/index');

const logger = require('../src/utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
const seed = async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/restaurant_saas';
    await mongoose.connect(uri);
    logger.info('MongoDB connected for seeding');

    // Wipe existing data
    await Promise.all([
      Restaurant.deleteMany({}),
      Admin.deleteMany({}),
      Table.deleteMany({}),
      MenuCategory.deleteMany({}),
      Product.deleteMany({}),
      Coupon.deleteMany({}),
    ]);
    logger.info('Existing data cleared');

    // ── Restaurant ────────────────────────────────────────────────────────────
    const restaurant = await Restaurant.create({
      name        : 'The Grand Bites',
      slug        : 'the-grand-bites',
      description : 'A modern dining experience with authentic flavors from across India.',
      cuisine     : ['Indian', 'Continental', 'Chinese'],
      address     : { street: '42, MG Road', city: 'Hyderabad', state: 'Telangana', country: 'India', zipCode: '500001' },
      contact     : { phone: '+91-9876543210', email: 'info@grandbites.com' },
      businessHours: [
        { day: 'monday',    open: '11:00', close: '23:00' },
        { day: 'tuesday',   open: '11:00', close: '23:00' },
        { day: 'wednesday', open: '11:00', close: '23:00' },
        { day: 'thursday',  open: '11:00', close: '23:00' },
        { day: 'friday',    open: '11:00', close: '23:30' },
        { day: 'saturday',  open: '11:00', close: '23:30' },
        { day: 'sunday',    open: '12:00', close: '22:00' },
      ],
      settings: {
        currency: 'INR', currencySymbol: '₹',
        taxRate: 18, serviceCharge: 5,
        allowCashPayment: true, allowOnlinePayment: true,
        autoAcceptOrders: false, preparationTimeDefault: 20,
        allowReviews: true, minOrderAmount: 100,
      },
      subscription: { plan: 'professional', isActive: true },
      isActive: true, isVerified: true,
    });
    logger.info(`Restaurant: ${restaurant.name} [${restaurant._id}]`);

    // ── Admin accounts ────────────────────────────────────────────────────────
    await Admin.create([
      {
        restaurantId: restaurant._id,
        name: 'Ravi Kumar', email: 'admin@grandbites.com', password: 'Admin@123',
        role: 'restaurant_owner',
        permissions: [
          'view_orders','manage_orders','view_menu','manage_menu',
          'view_tables','manage_tables','view_reports','manage_staff',
          'manage_settings','view_analytics','manage_payments',
        ],
      },
      {
        restaurantId: restaurant._id,
        name: 'Priya Singh', email: 'manager@grandbites.com', password: 'Manager@123',
        role: 'manager',
        permissions: ['view_orders','manage_orders','view_menu','view_tables','manage_tables','view_reports','view_analytics'],
      },
      {
        restaurantId: restaurant._id,
        name: 'Chef Ahmed', email: 'kitchen@grandbites.com', password: 'Kitchen@123',
        role: 'kitchen_staff',
        permissions: ['view_orders','manage_orders'],
      },
      {
        restaurantId: restaurant._id,
        name: 'Cashier Raj', email: 'cashier@grandbites.com', password: 'Cashier@123',
        role: 'cashier',
        permissions: ['view_orders','manage_orders','manage_payments','view_tables'],
      },
    ]);
    logger.info('Admin accounts created');

    // ── Tables with QR codes ──────────────────────────────────────────────────
    const tableData = [
      { tableNumber: 'T1',  displayName: 'Window Table 1',  capacity: 2, section: 'Window'    },
      { tableNumber: 'T2',  displayName: 'Window Table 2',  capacity: 2, section: 'Window'    },
      { tableNumber: 'T3',  displayName: 'Family Table 1',  capacity: 6, section: 'Main Hall' },
      { tableNumber: 'T4',  displayName: 'Family Table 2',  capacity: 6, section: 'Main Hall' },
      { tableNumber: 'T5',  displayName: 'Couple Table 1',  capacity: 2, section: 'Main Hall' },
      { tableNumber: 'T6',  displayName: 'Couple Table 2',  capacity: 2, section: 'Main Hall' },
      { tableNumber: 'T7',  displayName: 'VIP Booth 1',     capacity: 8, section: 'VIP'       },
      { tableNumber: 'T8',  displayName: 'VIP Booth 2',     capacity: 8, section: 'VIP'       },
      { tableNumber: 'T9',  displayName: 'Outdoor Table 1', capacity: 4, section: 'Outdoor'   },
      { tableNumber: 'T10', displayName: 'Outdoor Table 2', capacity: 4, section: 'Outdoor'   },
    ];

    const base = process.env.QR_BASE_URL || 'https://yourdomain.com';
    for (const t of tableData) {
      const token  = uuidv4();
      const qrUrl  = `${base}/scan/${token}`;
      const qrImg  = await QRCode.toDataURL(qrUrl, { width: 400, margin: 2 });
      await Table.create({
        restaurantId: restaurant._id, ...t,
        qrCode: { url: qrUrl, image: qrImg, generatedAt: new Date(), token },
      });
    }
    logger.info(`${tableData.length} tables created with QR codes`);

    // ── Menu categories ───────────────────────────────────────────────────────
    const catDefs = [
      { name: 'Starters',   icon: '🍢', sortOrder: 1 },
      { name: 'Soups',      icon: '🍲', sortOrder: 2 },
      { name: 'Main Course',icon: '🍛', sortOrder: 3 },
      { name: 'Breads',     icon: '🫓', sortOrder: 4 },
      { name: 'Biryani',    icon: '🍚', sortOrder: 5 },
      { name: 'Chinese',    icon: '🥢', sortOrder: 6 },
      { name: 'Desserts',   icon: '🍮', sortOrder: 7 },
      { name: 'Beverages',  icon: '🥤', sortOrder: 8 },
    ];
    const cats = await MenuCategory.insertMany(
      catDefs.map(c => ({ ...c, restaurantId: restaurant._id, isActive: true }))
    );
    const C = (name) => cats.find(c => c.name === name)._id;
    logger.info(`${cats.length} categories created`);

    // ── Products ──────────────────────────────────────────────────────────────
    const products = [
      // Starters
      { name: 'Paneer Tikka',       price: 280, type: 'veg',     spiceLevel: 'medium', isFeatured: true,  tags: ['bestseller','chef-special'], preparationTime: 15, description: 'Marinated cottage cheese grilled in tandoor',       categoryId: C('Starters')    },
      { name: 'Chicken 65',         price: 320, type: 'non-veg', spiceLevel: 'hot',    isFeatured: true,  tags: ['bestseller'],                preparationTime: 20, description: 'Crispy deep-fried spiced chicken',                  categoryId: C('Starters')    },
      { name: 'Hara Bhara Kebab',   price: 220, type: 'veg',     spiceLevel: 'mild',   isFeatured: false, tags: ['healthy'],                   preparationTime: 15, description: 'Spinach & peas kebab',                              categoryId: C('Starters')    },
      { name: 'Mutton Seekh Kebab', price: 380, type: 'non-veg', spiceLevel: 'medium', isFeatured: false, tags: ['chef-special'],              preparationTime: 25, description: 'Minced mutton with aromatic herbs on skewers',       categoryId: C('Starters')    },
      { name: 'Veg Spring Rolls',   price: 180, type: 'veg',     spiceLevel: 'mild',   isFeatured: false, tags: [],                            preparationTime: 15, description: 'Crispy rolls stuffed with fresh vegetables',          categoryId: C('Starters')    },
      { name: 'Fish Tikka',         price: 360, type: 'non-veg', spiceLevel: 'medium', isFeatured: true,  tags: ['chef-special'],              preparationTime: 20, description: 'Tender fish marinated and grilled in tandoor',        categoryId: C('Starters')    },
      // Soups
      { name: 'Tomato Basil Soup',  price: 150, type: 'veg',     spiceLevel: 'none',   isFeatured: false, tags: [],                            preparationTime: 10, description: 'Fresh tomato soup with basil',                       categoryId: C('Soups')       },
      { name: 'Hot & Sour Soup',    price: 160, type: 'veg',     spiceLevel: 'hot',    isFeatured: false, tags: [],                            preparationTime: 10, description: 'Classic Indo-Chinese hot and sour soup',             categoryId: C('Soups')       },
      { name: 'Chicken Corn Soup',  price: 180, type: 'non-veg', spiceLevel: 'mild',   isFeatured: false, tags: [],                            preparationTime: 10, description: 'Creamy chicken and sweet corn soup',                 categoryId: C('Soups')       },
      { name: 'Manchow Soup',       price: 170, type: 'veg',     spiceLevel: 'hot',    isFeatured: false, tags: [],                            preparationTime: 10, description: 'Spicy Manchow soup with crispy noodles',             categoryId: C('Soups')       },
      // Main Course
      { name: 'Butter Chicken',         price: 380, type: 'non-veg', spiceLevel: 'medium', isFeatured: true,  tags: ['bestseller','chef-special'], preparationTime: 25, description: 'Creamy tomato-based chicken curry',                  categoryId: C('Main Course') },
      { name: 'Dal Makhani',            price: 280, type: 'veg',     spiceLevel: 'mild',   isFeatured: true,  tags: ['bestseller'],                preparationTime: 20, description: 'Slow-cooked black lentils in rich cream gravy',      categoryId: C('Main Course') },
      { name: 'Paneer Butter Masala',   price: 320, type: 'veg',     spiceLevel: 'medium', isFeatured: false, tags: ['chef-special'],              preparationTime: 20, description: 'Cottage cheese in buttery tomato gravy',            categoryId: C('Main Course') },
      { name: 'Lamb Rogan Josh',        price: 450, type: 'non-veg', spiceLevel: 'hot',    isFeatured: false, tags: ['chef-special'],              preparationTime: 35, description: 'Kashmiri slow-cooked aromatic lamb curry',           categoryId: C('Main Course') },
      { name: 'Palak Tofu',             price: 300, type: 'vegan',   spiceLevel: 'medium', isFeatured: false, tags: ['healthy','vegan'],           preparationTime: 20, description: 'Tofu in creamy spinach gravy',                      categoryId: C('Main Course') },
      { name: 'Prawn Masala',           price: 520, type: 'non-veg', spiceLevel: 'hot',    isFeatured: true,  tags: ['chef-special'],              preparationTime: 25, description: 'Jumbo prawns in coastal spice masala',              categoryId: C('Main Course') },
      { name: 'Kadai Paneer',           price: 310, type: 'veg',     spiceLevel: 'hot',    isFeatured: false, tags: [],                            preparationTime: 20, description: 'Paneer cooked in kadai with bell peppers',           categoryId: C('Main Course') },
      { name: 'Chicken Chettinad',      price: 420, type: 'non-veg', spiceLevel: 'hot',    isFeatured: false, tags: [],                            preparationTime: 30, description: 'Fiery South Indian chicken curry',                   categoryId: C('Main Course') },
      // Breads
      { name: 'Butter Naan',    price: 60,  type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [], preparationTime: 8,  categoryId: C('Breads') },
      { name: 'Garlic Naan',    price: 80,  type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [], preparationTime: 8,  categoryId: C('Breads') },
      { name: 'Tandoori Roti',  price: 50,  type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [], preparationTime: 5,  categoryId: C('Breads') },
      { name: 'Stuffed Paratha',price: 90,  type: 'veg', spiceLevel: 'mild', isFeatured: false, tags: [], preparationTime: 10, categoryId: C('Breads') },
      { name: 'Lachha Paratha', price: 70,  type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [], preparationTime: 8,  categoryId: C('Breads') },
      // Biryani
      {
        name: 'Hyderabadi Chicken Biryani', price: 380, type: 'non-veg', spiceLevel: 'hot',
        isFeatured: true, tags: ['bestseller','chef-special'], preparationTime: 30,
        description: 'Authentic Hyderabadi dum biryani with tender chicken',
        categoryId: C('Biryani'),
        variants: [{ name: 'Portion', options: [{ label: 'Half', priceAddOn: 0, isDefault: true }, { label: 'Full', priceAddOn: 150 }] }],
      },
      { name: 'Veg Biryani',    price: 280, type: 'veg',     spiceLevel: 'medium', isFeatured: true,  tags: [],            preparationTime: 25, description: 'Fragrant basmati rice with vegetables and spices', categoryId: C('Biryani') },
      { name: 'Mutton Biryani', price: 480, type: 'non-veg', spiceLevel: 'hot',    isFeatured: false, tags: ['bestseller'], preparationTime: 40, description: 'Slow-cooked mutton biryani',                        categoryId: C('Biryani') },
      { name: 'Prawn Biryani',  price: 520, type: 'non-veg', spiceLevel: 'hot',    isFeatured: false, tags: [],            preparationTime: 35, description: 'Aromatic biryani with juicy prawns',               categoryId: C('Biryani') },
      // Chinese
      { name: 'Veg Fried Rice',     price: 220, type: 'veg',     spiceLevel: 'mild', isFeatured: false, tags: [],            preparationTime: 15, categoryId: C('Chinese') },
      { name: 'Chicken Fried Rice', price: 280, type: 'non-veg', spiceLevel: 'mild', isFeatured: false, tags: [],            preparationTime: 15, categoryId: C('Chinese') },
      { name: 'Chilli Paneer',      price: 320, type: 'veg',     spiceLevel: 'hot',  isFeatured: true,  tags: ['bestseller'], preparationTime: 20, categoryId: C('Chinese') },
      { name: 'Veg Hakka Noodles',  price: 200, type: 'veg',     spiceLevel: 'mild', isFeatured: false, tags: [],            preparationTime: 15, categoryId: C('Chinese') },
      { name: 'Chicken Manchurian', price: 300, type: 'non-veg', spiceLevel: 'hot',  isFeatured: false, tags: [],            preparationTime: 20, categoryId: C('Chinese') },
      // Desserts
      { name: 'Gulab Jamun',        price: 120, type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [],      preparationTime: 5,  description: 'Soft milk-solid dumplings in rose syrup', categoryId: C('Desserts') },
      { name: 'Kulfi Falooda',      price: 160, type: 'veg', spiceLevel: 'none', isFeatured: true,  tags: [],      preparationTime: 5,  description: 'Traditional Indian ice cream with falooda', categoryId: C('Desserts') },
      { name: 'Chocolate Lava Cake',price: 200, type: 'veg', spiceLevel: 'none', isFeatured: false, tags: ['new'], preparationTime: 12, description: 'Warm chocolate cake with molten centre',   categoryId: C('Desserts') },
      { name: 'Rasmalai',           price: 150, type: 'veg', spiceLevel: 'none', isFeatured: false, tags: [],      preparationTime: 5,  description: 'Soft cottage cheese discs in saffron milk', categoryId: C('Desserts') },
      // Beverages
      {
        name: 'Fresh Lime Soda', price: 80, type: 'veg', spiceLevel: 'none', preparationTime: 3, categoryId: C('Beverages'),
        variants: [{ name: 'Flavour', options: [{ label: 'Sweet', priceAddOn: 0, isDefault: true }, { label: 'Salted', priceAddOn: 0 }, { label: 'Mixed', priceAddOn: 0 }] }],
      },
      { name: 'Mango Lassi',  price: 120, type: 'veg',  spiceLevel: 'none', isFeatured: false, tags: ['bestseller'], preparationTime: 5, categoryId: C('Beverages') },
      { name: 'Masala Chai',  price: 60,  type: 'veg',  spiceLevel: 'none', isFeatured: false, tags: [],            preparationTime: 5, categoryId: C('Beverages') },
      { name: 'Cold Coffee',  price: 150, type: 'veg',  spiceLevel: 'none', isFeatured: false, tags: [],            preparationTime: 5, categoryId: C('Beverages') },
      { name: 'Fresh Juice',  price: 140, type: 'vegan',spiceLevel: 'none', isFeatured: false, tags: ['healthy'],   preparationTime: 5, categoryId: C('Beverages') },
    ];

    await Product.insertMany(
      products.map((p, i) => ({
        restaurantId: restaurant._id,
        isActive: true, isAvailable: true, sortOrder: i,
        totalOrders : Math.floor(Math.random() * 300),
        totalRevenue: Math.floor(Math.random() * 80000),
        avgRating   : parseFloat((3.5 + Math.random() * 1.5).toFixed(1)),
        totalRatings: Math.floor(Math.random() * 120),
        ...p,
      }))
    );
    logger.info(`${products.length} products created`);

    // ── Coupons ───────────────────────────────────────────────────────────────
    await Coupon.insertMany([
      {
        restaurantId: restaurant._id, code: 'WELCOME10',
        description: '10% off on your first order', type: 'percentage', value: 10,
        minOrderAmount: 200, maxDiscount: 100, usageLimit: 500, isActive: true,
        validTo: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
      {
        restaurantId: restaurant._id, code: 'FLAT50',
        description: '₹50 off on orders above ₹300', type: 'fixed', value: 50,
        minOrderAmount: 300, usageLimit: 200, isActive: true,
        validTo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      {
        restaurantId: restaurant._id, code: 'WEEKEND20',
        description: '20% off on weekends', type: 'percentage', value: 20,
        minOrderAmount: 500, maxDiscount: 200, usageLimit: 100, isActive: true,
        validTo: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      },
    ]);
    logger.info('3 coupons created');

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║      DATABASE SEEDED SUCCESSFULLY ✅          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  Restaurant ID : ${restaurant._id}`);
    console.log(`  Slug          : ${restaurant.slug}`);
    console.log('');
    console.log('  Admin Credentials:');
    console.log('  ┌─────────────────────────────────────────┐');
    console.log('  │ Owner   admin@grandbites.com / Admin@123   │');
    console.log('  │ Manager manager@grandbites.com / Manager@123│');
    console.log('  │ Kitchen kitchen@grandbites.com / Kitchen@123│');
    console.log('  │ Cashier cashier@grandbites.com / Cashier@123│');
    console.log('  └─────────────────────────────────────────┘');
    console.log(`  Tables   : ${tableData.length} (all with QR codes)`);
    console.log(`  Products : ${products.length}`);
    console.log(`  Coupons  : WELCOME10 | FLAT50 | WEEKEND20`);
    console.log('');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
};

seed();
