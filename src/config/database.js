const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const mongoURI = process.env.NODE_ENV === 'production'
      ? process.env.MONGO_URI_PROD
      : process.env.MONGO_URI;

    const options = {
      maxPoolSize: 50,           // Max connection pool size
      minPoolSize: 10,           // Min connection pool size
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
      retryWrites: true,
      writeConcern: { w: 'majority' },
      readPreference: 'secondaryPreferred', // Read from secondaries for load balancing
      compressors: ['zlib'],
    };

    mongoose.set('strictQuery', false);

    const conn = await mongoose.connect(mongoURI, options);

    logger.info(`MongoDB Connected: ${conn.connection.host} [Pool: ${options.maxPoolSize}]`);

    // Connection events
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected! Attempting reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB connection error: ${err}`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed through app termination');
      process.exit(0);
    });

  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
