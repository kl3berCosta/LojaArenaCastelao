const multer = require('multer');
const { IMAGE_TYPES } = require('../lib/storage');

// Upload em memória (o arquivo segue para o S3). Aceita somente imagens, até 10 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error('O banner deve ser uma imagem JPEG, PNG, WEBP ou GIF.');
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  }
});

module.exports = upload;
