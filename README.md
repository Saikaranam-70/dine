# 🍽️ Restaurant SaaS — Enterprise Backend

A production-ready, enterprise-level multi-tenant restaurant SaaS backend with QR-based ordering, real-time kitchen display, Redis caching, MongoDB, Socket.IO, load balancing, and more.

---

## 🏗️ Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │           NGINX Load Balancer            │
                    │  (Rate Limiting, SSL, Static Cache)      │
                    └──────────────┬──────────────────────────┘
                                   │
              ┌──────┬─────────────┼─────────────┬──────┐
              │      │             │             │      │
           App:5000 App:5001   App:5002        App:5003  (PM2/Docker replicas)
              │      │             │             │
              └──────┴──────┬──────┴─────────────┘
                            │
              ┌─────────────┴─────────────────┐
              │                               │
        ┌─────▼──────┐              ┌─────────▼──────┐
        │  MongoDB   │              │     Redis       │
        │ (Replica   │              │ (Cache + Pub/   │
        │   Set)     │              │  Sub + Queues)  │
        └────────────┘              └────────────────┘
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Seed Database (demo data)
```bash
npm run seed
```

### 4. Start Development
```bash
npm run dev
```

### 5. Start Production (Cluster Mode)
```bash
npm run start:cluster
```

### 6. Docker (Full Stack)
```bash
docker-compose up -d
docker-compose --profile dev up -d   # With admin UIs
```

---

## 📋 API Reference

**Base URL:** `http://localhost:5000/api`  
**Swagger Docs:** `http://localhost:5000/api/docs` (dev only)

---

### 🔐 Admin Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/auth/login` | Admin login → returns JWT |
| POST | `/admin/auth/refresh` | Refresh access token |
| POST | `/admin/auth/logout` | Logout (invalidates token) |
| POST | `/admin/auth/forgot-password` | Forgot password |
| PATCH | `/admin/auth/reset-password/:token` | Reset password |
| PATCH | `/admin/auth/change-password` | Change password |
| GET | `/admin/auth/me` | Get current admin info |

**Login Example:**
```json
POST /api/admin/auth/login
{
  "email": "admin@grandbites.com",
  "password": "Admin@123"
}
```

---

### 📱 Customer Flow (No Auth)

#### Step 1: Scan QR Code
```
GET /api/tables/scan/:qrToken
→ Returns: { sessionToken, table, restaurant }
```

#### Step 2: Use sessionToken in all requests
```
Header: X-Session-Token: <sessionToken>
```

#### Step 3: Browse Menu
```
GET /api/menu/:restaurantId/products
GET /api/menu/:restaurantId/products/featured
GET /api/menu/:restaurantId/products/search?q=biryani
GET /api/menu/:restaurantId/categories
```

#### Step 4: Place Order
```json
POST /api/orders
Header: X-Session-Token: abc123

{
  "customerName": "Ravi",
  "guestCount": 2,
  "items": [
    {
      "productId": "...",
      "quantity": 2,
      "selectedVariants": [{ "name": "Portion", "selected": "Full" }],
      "selectedAddOns": [],
      "specialInstructions": "Less spicy"
    }
  ],
  "couponCode": "WELCOME10"
}
```

#### Step 5: Track Order
```
GET /api/orders/:orderId/status
GET /api/orders
```

#### Step 6: Pay Online
```json
POST /api/payments/initiate
{
  "orderId": "...",
  "gateway": "razorpay"
}
```

#### Step 7: Request Bill / Call Waiter
```json
POST /api/tables/session/request-bill
POST /api/tables/session/call-waiter
{ "reason": "Need extra napkins" }
```

#### Step 8: Submit Review
```json
POST /api/reviews
{
  "productId": "...",
  "orderId": "...",
  "rating": 5,
  "review": "Absolutely delicious!",
  "tags": ["tasty", "good-portion"],
  "customerName": "Ravi"
}
```

---

### 🍽️ Menu Management (Admin)

| Method | Endpoint | Auth |
|--------|----------|------|
| GET | `/admin/menu/categories` | Admin |
| POST | `/admin/menu/categories` | manage_menu |
| PUT | `/admin/menu/categories/:id` | manage_menu |
| DELETE | `/admin/menu/categories/:id` | manage_menu |
| GET | `/admin/menu/products` | view_menu |
| POST | `/admin/menu/products` | manage_menu |
| PUT | `/admin/menu/products/:id` | manage_menu |
| DELETE | `/admin/menu/products/:id` | manage_menu |
| PATCH | `/admin/menu/products/:id/toggle` | manage_menu |
| PATCH | `/admin/menu/products/bulk-update` | manage_menu |

---

### 📦 Order Management (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/orders` | List orders (filterable) |
| GET | `/admin/orders/live` | Live orders + KDS tickets |
| GET | `/admin/orders/:id` | Order detail |
| PATCH | `/admin/orders/:id/status` | Update status |
| PATCH | `/admin/orders/:id/cancel` | Cancel order |
| POST | `/admin/orders/:id/bill` | Generate bill |
| PATCH | `/admin/orders/:id/payment` | Mark payment |
| PATCH | `/admin/orders/:id/items` | Update item status (KDS) |

**Order Status Flow:**
```
placed → confirmed → preparing → ready → served
         ↓
       cancelled
```

---

### 🪑 Table Management (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/tables` | All tables with live status |
| POST | `/admin/tables` | Create table + auto-generate QR |
| PUT | `/admin/tables/:id` | Update table |
| DELETE | `/admin/tables/:id` | Delete table |
| POST | `/admin/tables/:id/regenerate-qr` | New QR code |
| GET | `/admin/tables/sessions` | All sessions |
| POST | `/admin/tables/sessions/:id/close` | Close session |

---

### 📊 Analytics & Reports (Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/analytics/dashboard` | Real-time dashboard |
| GET | `/admin/analytics/sales?period=week` | Sales summary |
| GET | `/admin/analytics/products` | Product analytics |
| GET | `/admin/analytics/report?format=pdf` | Full report (JSON/PDF) |

**Dashboard Response:**
```json
{
  "today": { "orders": 45, "revenue": 38500, "avgOrderValue": "855.56", "guests": 120 },
  "growth": { "revenue": 12.5, "orders": 8.3 },
  "week": { "orders": 312, "revenue": 265000 },
  "live": { "orders": 8, "pendingPayments": 3, "activeTables": 6 }
}
```

---

### 💰 Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/payments/initiate` | Start online payment (Razorpay/Stripe) |
| POST | `/payments/verify/razorpay` | Verify Razorpay payment |
| POST | `/payments/apply-coupon` | Validate & apply coupon |
| POST | `/payments/webhook/stripe` | Stripe webhook |
| POST | `/admin/payments/refund` | Process refund |

---

### 👥 Staff Management (Admin)

```
GET    /admin/staff
POST   /admin/staff
PUT    /admin/staff/:id
DELETE /admin/staff/:id
PATCH  /admin/staff/:id/toggle
```

**Roles:** `restaurant_owner` | `manager` | `cashier` | `kitchen_staff`

---

### 🎟️ Coupons (Admin)

```
GET    /admin/coupons
POST   /admin/coupons
PUT    /admin/coupons/:id
DELETE /admin/coupons/:id
PATCH  /admin/coupons/:id/toggle
```

**Coupon Types:** `percentage` | `fixed` | `bogo` | `free_item`

---

### 🔔 Notifications (Admin)

```
GET   /admin/notifications
PATCH /admin/notifications/:id/read
PATCH /admin/notifications/read-all
```

---

### 🧾 Bills

```
GET /bills/:orderId/receipt      - Get receipt data
GET /bills/:orderId/download     - Download PDF bill
```

---

## 🔄 Real-time (Socket.IO)

### Admin Namespace: `/admin`
```js
const socket = io('/admin', { auth: { token: 'JWT_TOKEN' } });

socket.on('orders:NEW_ORDER', (order) => { /* new order */ });
socket.on('orders:ORDER_STATUS_UPDATED', (data) => { /* status change */ });
socket.on('kitchen:NEW_TICKET', (ticket) => { /* KDS update */ });
socket.on('table:BILL_REQUESTED', (data) => { /* customer bill request */ });
socket.on('notification', (notif) => { /* general notification */ });
```

### Customer Namespace: `/customer`
```js
const socket = io('/customer', { auth: { sessionToken: 'SESSION_TOKEN' } });

socket.on('order:update', (data) => { /* live order status */ });
socket.on('payment:update', (data) => { /* payment confirmation */ });
socket.on('waiter:acknowledged', (msg) => { /* waiter notified */ });
```

---

## ⚡ Caching Strategy (Redis)

| Data | Cache Key | TTL |
|------|-----------|-----|
| Full menu | `restaurant:{id}:menu` | 1 hour |
| Product detail | `product:{id}` | 1 hour |
| Restaurant info | `restaurant:{id}` | 30 min |
| Reviews | `reviews:product:{id}` | 10 min |
| Analytics | `stats:restaurant:{id}:{period}` | 5 min |
| Table list | `restaurant:{id}:tables` | 5 min |
| Admin session | `admin:{id}` | 5 min |
| Customer session | `session:{token}` | 24 hours |

---

## 🛡️ Security Features

- JWT auth with refresh tokens
- Account lockout (5 failed attempts → 30 min lock)
- Rate limiting per endpoint (Redis-backed)
- Slow-down middleware for burst traffic
- Helmet.js security headers
- MongoDB sanitization (NoSQL injection prevention)
- XSS-clean middleware
- HPP (HTTP parameter pollution) protection
- CORS with whitelist
- Stripe webhook signature verification
- Razorpay HMAC signature verification

---

## 📁 Project Structure

```
src/
├── config/
│   ├── database.js      # MongoDB connection (pooling)
│   ├── redis.js         # Redis + CacheService
│   └── swagger.js       # API docs
├── controllers/
│   ├── adminAuthController.js
│   ├── menuController.js
│   ├── orderController.js
│   ├── tableController.js
│   ├── analyticsController.js
│   ├── reviewController.js
│   ├── paymentController.js
│   └── restaurantController.js
├── middleware/
│   └── index.js         # Auth, rate limit, error handler
├── models/
│   └── index.js         # All Mongoose models
├── routes/
│   └── index.js         # All routes
├── services/
│   ├── billService.js   # PDF bill generation
│   ├── cloudinaryService.js
│   ├── orderService.js  # Pricing, KDS
│   └── socketService.js # Real-time events
├── utils/
│   ├── apiHelpers.js    # ApiResponse, AppError, asyncHandler
│   └── logger.js        # Winston logger
├── workers/
│   └── queueWorker.js   # Bull queues + cron jobs
├── app.js               # Express app setup
├── server.js            # HTTP server + bootstrap
└── cluster.js           # Multi-core clustering
nginx/
└── nginx.conf           # Load balancer config
scripts/
└── seed.js              # Database seeder
docker-compose.yml
Dockerfile
```

---

## 🗓️ Background Jobs (Cron)

| Job | Schedule | Description |
|-----|----------|-------------|
| Daily report | 00:05 daily | Generate sales report per restaurant |
| Notification cleanup | Every hour | Delete old read notifications (>7 days) |
| Stale session close | Every 30 min | Auto-close 8h+ idle sessions |
| Stock alerts | Every 15 min | Notify low stock items |

---

## 📦 Special Features

- **QR Code per table** — Auto-generated on table creation, regeneratable
- **Anonymous customer sessions** — No login, just scan → order
- **Kitchen Display System (KDS)** — Real-time kitchen tickets via Socket.IO
- **Bill PDF generation** — 80mm thermal receipt format
- **Sales report PDF** — Full A4 report with analytics
- **Split payments** — Multiple payment methods per order
- **Coupon system** — Percentage, fixed, BOGO, free item
- **Staff roles & permissions** — Granular access control
- **Product add-ons & variants** — e.g., size, toppings
- **Multi-gateway payments** — Razorpay (India) + Stripe (global)
- **Offline fallback** — Graceful Redis degradation
- **Cluster mode** — Auto-scales to CPU cores with auto-restart
- **MongoDB replica set** — High availability, read scaling

---

## 🔧 Environment Variables

See `.env.example` for all configuration options.

**Minimum required:**
```
MONGO_URI=mongodb://localhost:27017/restaurant_saas
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_secret_min_64_chars
ADMIN_JWT_SECRET=your_admin_secret
JWT_REFRESH_SECRET=your_refresh_secret
```
