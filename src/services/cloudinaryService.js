const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only images (JPEG, PNG, WebP) are allowed'), false);
  }
};

exports.upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
  fileFilter,
});

exports.uploadImage = async (file, folder = 'uploads') => {
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          quality: 'auto:good',
          fetch_format: 'auto',
          transformation: [{ width: 800, crop: 'limit' }],
        },
        (err, result) => { if (err) reject(err); else resolve(result); }
      );
      stream.end(file.buffer);
    });

    return result.secure_url;
  } catch (err) {
    logger.error(`Cloudinary upload error: ${err.message}`);
    throw err;
  }
};

exports.deleteImage = async (imageUrl) => {
  try {
    const publicId = imageUrl.split('/').slice(-2).join('/').split('.')[0];
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    logger.error(`Cloudinary delete error: ${err.message}`);
  }
};
