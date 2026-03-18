const Redis = require('ioredis');
const logger = require('../utils/logger');

let redisClient = null;
let publisherClient = null;
let subscriberClient = null;

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: 0,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryDelayOnFailover: 100,
  retryDelayOnClusterDown: 100,
  retryDelayOnTryAgain: 100,
  connectTimeout: 10000,
  lazyConnect: false,
  keepAlive: 30000,
  family: 4,
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) return true;
    return false;
  },
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis: Max retry attempts reached');
      return null;
    }
    const delay = Math.min(times * 100, 3000);
    logger.warn(`Redis: Retrying connection in ${delay}ms (attempt ${times})`);
    return delay;
  },
};

// const createClient = (name = 'default') => {
//   const client = new Redis(redisConfig);

//   client.on('connect', () => logger.info(`Redis [${name}]: Connecting...`));
//   client.on('ready', () => logger.info(`Redis [${name}]: Ready`));
//   client.on('error', (err) => logger.error(`Redis [${name}] Error: ${err.message}`));
//   client.on('close', () => logger.warn(`Redis [${name}]: Connection closed`));
//   client.on('reconnecting', () => logger.warn(`Redis [${name}]: Reconnecting...`));
//   client.on('end', () => logger.warn(`Redis [${name}]: Connection ended`));

//   return client;
// };

const createClient = (name = 'default') => {
  const client = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new Redis(redisConfig);

  client.on('connect', () => logger.info(`Redis [${name}]: Connecting...`));
  client.on('ready', () => logger.info(`Redis [${name}]: Ready`));
  client.on('error', (err) => logger.error(`Redis [${name}] Error: ${err.message}`));
  client.on('close', () => logger.warn(`Redis [${name}]: Connection closed`));
  client.on('reconnecting', () => logger.warn(`Redis [${name}]: Reconnecting...`));
  client.on('end', () => logger.warn(`Redis [${name}]: Connection ended`));

  return client;
};

const connectRedis = async () => {
  try {
    redisClient = createClient('main');
    publisherClient = createClient('publisher');
    subscriberClient = createClient('subscriber');

    await redisClient.ping();
    logger.info('Redis connection established successfully');

    return { redisClient, publisherClient, subscriberClient };
  } catch (error) {
    logger.error(`Redis connection failed: ${error.message}`);
    // Don't crash — Redis is optional (graceful degradation)
    return { redisClient: null, publisherClient: null, subscriberClient: null };
  }
};

// ============================================
// CACHE SERVICE
// ============================================
class CacheService {
  constructor(client) {
    this.client = client;
    this.defaultTTL = 3600; // 1 hour
  }

  isAvailable() {
    return this.client && this.client.status === 'ready';
  }

  async get(key) {
    if (!this.isAvailable()) return null;
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error(`Cache GET error for key ${key}: ${err.message}`);
      return null;
    }
  }

  async set(key, value, ttl = this.defaultTTL) {
    if (!this.isAvailable()) return false;
    try {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await this.client.setex(key, ttl, serialized);
      } else {
        await this.client.set(key, serialized);
      }
      return true;
    } catch (err) {
      logger.error(`Cache SET error for key ${key}: ${err.message}`);
      return false;
    }
  }

  async del(key) {
    if (!this.isAvailable()) return false;
    try {
      await this.client.del(key);
      return true;
    } catch (err) {
      logger.error(`Cache DEL error for key ${key}: ${err.message}`);
      return false;
    }
  }

  async delPattern(pattern) {
    if (!this.isAvailable()) return false;
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
        logger.debug(`Cache: Deleted ${keys.length} keys matching ${pattern}`);
      }
      return true;
    } catch (err) {
      logger.error(`Cache DEL PATTERN error for ${pattern}: ${err.message}`);
      return false;
    }
  }

  async hset(key, field, value, ttl) {
    if (!this.isAvailable()) return false;
    try {
      await this.client.hset(key, field, JSON.stringify(value));
      if (ttl) await this.client.expire(key, ttl);
      return true;
    } catch (err) {
      logger.error(`Cache HSET error: ${err.message}`);
      return false;
    }
  }

  async hget(key, field) {
    if (!this.isAvailable()) return null;
    try {
      const data = await this.client.hget(key, field);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error(`Cache HGET error: ${err.message}`);
      return null;
    }
  }

  async hgetall(key) {
    if (!this.isAvailable()) return null;
    try {
      const data = await this.client.hgetall(key);
      if (!data) return null;
      const result = {};
      for (const [k, v] of Object.entries(data)) {
        result[k] = JSON.parse(v);
      }
      return result;
    } catch (err) {
      logger.error(`Cache HGETALL error: ${err.message}`);
      return null;
    }
  }

  // Increment counter (for analytics)
  async incr(key, ttl) {
    if (!this.isAvailable()) return null;
    try {
      const val = await this.client.incr(key);
      if (ttl && val === 1) await this.client.expire(key, ttl);
      return val;
    } catch (err) {
      logger.error(`Cache INCR error: ${err.message}`);
      return null;
    }
  }

  // Sorted set for leaderboards / top items
  async zadd(key, score, member) {
    if (!this.isAvailable()) return false;
    try {
      await this.client.zadd(key, score, member);
      return true;
    } catch (err) {
      logger.error(`Cache ZADD error: ${err.message}`);
      return false;
    }
  }

  async zrange(key, start, stop, withScores = false) {
    if (!this.isAvailable()) return [];
    try {
      if (withScores) {
        return await this.client.zrange(key, start, stop, 'WITHSCORES');
      }
      return await this.client.zrange(key, start, stop);
    } catch (err) {
      logger.error(`Cache ZRANGE error: ${err.message}`);
      return [];
    }
  }

  // Cache-aside pattern helper
  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    const cached = await this.get(key);
    if (cached !== null) {
      logger.debug(`Cache HIT: ${key}`);
      return cached;
    }
    logger.debug(`Cache MISS: ${key}`);
    const data = await fetchFn();
    if (data !== null && data !== undefined) {
      await this.set(key, data, ttl);
    }
    return data;
  }

  // Pipeline for batch operations
  async pipeline(operations) {
    if (!this.isAvailable()) return [];
    try {
      const pipe = this.client.pipeline();
      operations.forEach(([cmd, ...args]) => pipe[cmd](...args));
      return await pipe.exec();
    } catch (err) {
      logger.error(`Cache PIPELINE error: ${err.message}`);
      return [];
    }
  }
}

// Cache key builders
const CACHE_KEYS = {
  restaurant: (id) => `restaurant:${id}`,
  restaurantMenu: (id) => `restaurant:${id}:menu`,
  restaurantTables: (id) => `restaurant:${id}:tables`,
  menuCategory: (restaurantId, categoryId) => `menu:${restaurantId}:category:${categoryId}`,
  product: (id) => `product:${id}`,
  productsByRestaurant: (restaurantId) => `products:restaurant:${restaurantId}`,
  order: (id) => `order:${id}`,
  ordersByTable: (restaurantId, tableId) => `orders:restaurant:${restaurantId}:table:${tableId}`,
  reviewsByProduct: (productId) => `reviews:product:${productId}`,
  restaurantStats: (id, period) => `stats:restaurant:${id}:${period}`,
  topProducts: (restaurantId) => `top_products:${restaurantId}`,
  activeSession: (sessionToken) => `session:${sessionToken}`,
  rateLimit: (ip) => `rate_limit:${ip}`,
  qrCode: (tableId) => `qr:table:${tableId}`,
};

const TTL = {
  MENU: parseInt(process.env.CACHE_TTL_MENU) || 3600,
  RESTAURANT: parseInt(process.env.CACHE_TTL_RESTAURANT) || 1800,
  PRODUCTS: parseInt(process.env.CACHE_TTL_PRODUCTS) || 3600,
  REVIEWS: parseInt(process.env.CACHE_TTL_REVIEWS) || 600,
  STATS: parseInt(process.env.CACHE_TTL_STATS) || 300,
  SESSION: 86400, // 24 hours
  QR: 2592000, // 30 days
};

let cacheService = null;

const getCacheService = () => {
  if (!cacheService && redisClient) {
    cacheService = new CacheService(redisClient);
  }
  return cacheService || new CacheService(null); // Null-safe fallback
};

const getRedisClient = () => redisClient;
const getPublisher = () => publisherClient;
const getSubscriber = () => subscriberClient;

module.exports = {
  connectRedis,
  getCacheService,
  getRedisClient,
  getPublisher,
  getSubscriber,
  CACHE_KEYS,
  TTL,
  CacheService,
};
