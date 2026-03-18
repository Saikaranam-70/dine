const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Admin, Restaurant } = require('../models');
const { ApiResponse, AppError, asyncHandler } = require('../utils/apiHelpers');
const { getCacheService } = require('../config/redis');
const logger = require('../utils/logger');

const generateTokens = (adminId, restaurantId, role) => {
  const accessToken = jwt.sign(
    { id: adminId, restaurantId, role },
    process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '1d' }
  );

  const refreshToken = jwt.sign(
    { id: adminId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

  return { accessToken, refreshToken };
};

// POST /api/admin/auth/login
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return ApiResponse.error(res, 'Email and password required', 400);
  }

  const admin = await Admin.findOne({ email: email.toLowerCase() })
    .select('+password +refreshToken')
    .populate('restaurantId', 'name slug isActive settings');

  if (!admin) return ApiResponse.unauthorized(res, 'Invalid credentials');

  // Check account lock
  if (admin.isLocked()) {
    const lockTime = Math.ceil((admin.lockUntil - Date.now()) / 60000);
    return ApiResponse.error(res, `Account locked for ${lockTime} more minutes`, 423);
  }

  const isMatch = await admin.comparePassword(password);
  if (!isMatch) {
    // Increment login attempts
    admin.loginAttempts += 1;
    if (admin.loginAttempts >= 5) {
      admin.lockUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 min lock
      logger.warn(`Admin account locked: ${admin.email}`);
    }
    await admin.save({ validateBeforeSave: false });
    return ApiResponse.unauthorized(res, `Invalid credentials. ${5 - admin.loginAttempts} attempts remaining`);
  }

  if (!admin.isActive) return ApiResponse.forbidden(res, 'Account deactivated');

  // Reset login attempts on success
  admin.loginAttempts = 0;
  admin.lockUntil = undefined;
  admin.lastLogin = new Date();

  const { accessToken, refreshToken } = generateTokens(
    admin._id,
    admin.restaurantId._id,
    admin.role
  );

  admin.refreshToken = refreshToken;
  await admin.save({ validateBeforeSave: false });

  logger.info(`Admin logged in: ${admin.email} | Restaurant: ${admin.restaurantId.name}`);

  return ApiResponse.success(res, {
    accessToken,
    refreshToken,
    admin: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions,
      restaurant: admin.restaurantId,
    },
  }, 'Login successful');
});

// POST /api/admin/auth/refresh
exports.refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return ApiResponse.error(res, 'Refresh token required', 400);

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return ApiResponse.unauthorized(res, 'Invalid or expired refresh token');
  }

  const admin = await Admin.findById(decoded.id).select('+refreshToken');
  if (!admin || admin.refreshToken !== refreshToken) {
    return ApiResponse.unauthorized(res, 'Invalid refresh token');
  }

  const { accessToken, refreshToken: newRefreshToken } = generateTokens(
    admin._id,
    admin.restaurantId,
    admin.role
  );

  admin.refreshToken = newRefreshToken;
  await admin.save({ validateBeforeSave: false });

  return ApiResponse.success(res, { accessToken, refreshToken: newRefreshToken }, 'Token refreshed');
});

// POST /api/admin/auth/logout
exports.logout = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.admin._id).select('+refreshToken');
  if (admin) {
    admin.refreshToken = undefined;
    await admin.save({ validateBeforeSave: false });
  }

  // Invalidate cache
  const cache = getCacheService();
  await cache.del(`admin:${req.admin._id}`);

  return ApiResponse.success(res, {}, 'Logged out successfully');
});

// POST /api/admin/auth/forgot-password
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const admin = await Admin.findOne({ email: email?.toLowerCase() });

  // Always respond success to prevent email enumeration
  if (!admin) {
    return ApiResponse.success(res, {}, 'If email exists, reset link sent');
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  admin.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  admin.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
  await admin.save({ validateBeforeSave: false });

  // TODO: Send email via EmailService
  logger.info(`Password reset requested for: ${admin.email}`);

  return ApiResponse.success(res, {}, 'Password reset link sent to email');
});

// PATCH /api/admin/auth/reset-password/:token
exports.resetPassword = asyncHandler(async (req, res) => {
  const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const admin = await Admin.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select('+password');

  if (!admin) return ApiResponse.error(res, 'Invalid or expired reset token', 400);

  admin.password = req.body.password;
  admin.passwordResetToken = undefined;
  admin.passwordResetExpires = undefined;
  admin.loginAttempts = 0;
  admin.lockUntil = undefined;
  await admin.save();

  return ApiResponse.success(res, {}, 'Password reset successful');
});

// PATCH /api/admin/auth/change-password
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = await Admin.findById(req.admin._id).select('+password');

  if (!(await admin.comparePassword(currentPassword))) {
    return ApiResponse.error(res, 'Current password incorrect', 400);
  }

  admin.password = newPassword;
  await admin.save();

  // Invalidate all sessions
  const cache = getCacheService();
  await cache.del(`admin:${admin._id}`);

  return ApiResponse.success(res, {}, 'Password changed successfully');
});

// GET /api/admin/auth/me
exports.getMe = asyncHandler(async (req, res) => {
  const admin = await Admin.findById(req.admin._id)
    .populate('restaurantId', 'name slug logo settings subscription');
  return ApiResponse.success(res, { admin });
});
