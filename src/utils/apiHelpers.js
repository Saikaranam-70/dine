// ============================================
// API RESPONSE HANDLER
// ============================================
class ApiResponse {
  static success(res, data = {}, message = 'Success', statusCode = 200, meta = {}) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      ...(Object.keys(meta).length > 0 && { meta }),
      timestamp: new Date().toISOString(),
    });
  }

  static created(res, data = {}, message = 'Created successfully') {
    return this.success(res, data, message, 201);
  }

  static paginated(res, data, pagination, message = 'Success') {
    return res.status(200).json({
      success: true,
      message,
      data,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total: pagination.total,
        totalPages: Math.ceil(pagination.total / pagination.limit),
        hasNext: pagination.page < Math.ceil(pagination.total / pagination.limit),
        hasPrev: pagination.page > 1,
      },
      timestamp: new Date().toISOString(),
    });
  }

  static error(res, message = 'Something went wrong', statusCode = 500, errors = null) {
    return res.status(statusCode).json({
      success: false,
      message,
      ...(errors && { errors }),
      timestamp: new Date().toISOString(),
    });
  }

  static notFound(res, message = 'Resource not found') {
    return this.error(res, message, 404);
  }

  static unauthorized(res, message = 'Unauthorized access') {
    return this.error(res, message, 401);
  }

  static forbidden(res, message = 'Forbidden') {
    return this.error(res, message, 403);
  }

  static validationError(res, errors) {
    return this.error(res, 'Validation failed', 422, errors);
  }
}

// ============================================
// CUSTOM ERROR CLASS
// ============================================
class AppError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================
// ASYNC HANDLER (eliminates try/catch boilerplate)
// ============================================
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ============================================
// PAGINATION HELPER
// ============================================
const getPagination = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

// ============================================
// QUERY BUILDER
// ============================================
const buildSortQuery = (sortStr, allowedFields = []) => {
  if (!sortStr) return { createdAt: -1 };
  const sort = {};
  const parts = sortStr.split(',');
  parts.forEach(part => {
    const field = part.startsWith('-') ? part.slice(1) : part;
    if (allowedFields.length === 0 || allowedFields.includes(field)) {
      sort[field] = part.startsWith('-') ? -1 : 1;
    }
  });
  return Object.keys(sort).length > 0 ? sort : { createdAt: -1 };
};

module.exports = { ApiResponse, AppError, asyncHandler, getPagination, buildSortQuery };
