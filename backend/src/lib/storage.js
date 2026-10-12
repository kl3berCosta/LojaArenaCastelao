// AMAZON S3 - Armazenamento de arquivos binários (banners e thumbnails).
// A leitura pública dos objetos é concedida por bucket policy (ver infra/main.tf), não por ACL por objeto.
// Sem S3 configurado (desenvolvimento) os arquivos vão para backend/uploads/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { AWS_REGION, UPLOADS_DIR } = require('../config');

const BUCKET = process.env.S3_BUCKET_NAME;
const s3 = BUCKET ? new S3Client({ region: AWS_REGION }) : null;

// Somente imagens são aceitas como banner; a extensão vem do tipo MIME, nunca do nome enviado.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const publicUrl = (key) => `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

async function put(subfolder, fileName, buffer, contentType) {
  if (s3) {
    const key = `${subfolder}/${fileName}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
    return { url: publicUrl(key), bucket: BUCKET, key, fileName };
  }

  const localTarget = path.join(UPLOADS_DIR, subfolder, fileName);
  fs.mkdirSync(path.dirname(localTarget), { recursive: true });
  fs.writeFileSync(localTarget, buffer);
  return { url: `/uploads/${subfolder}/${fileName}`, localPath: localTarget, fileName };
}

// Banner original enviado pelo administrador (multer file) -> banners/raw/
function saveBanner(file) {
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${IMAGE_TYPES[file.mimetype] || '.jpg'}`;
  return put('banners/raw', fileName, file.buffer, file.mimetype);
}

// Thumbnail gerado pelo worker -> banners/processed/. Retorna a URL.
async function saveThumbnail(buffer) {
  const fileName = `thumb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  const saved = await put('banners/processed', fileName, buffer, 'image/jpeg');
  return saved.url;
}

// Obtém os bytes da imagem descrita por uma tarefa da fila.
async function loadImage(task) {
  if (task.imageBase64) {
    return Buffer.from(task.imageBase64, 'base64');
  }

  if (s3 && task.s3Bucket && task.s3Key) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: task.s3Bucket, Key: task.s3Key }));
    return Buffer.from(await obj.Body.transformToByteArray());
  }

  if (task.localFilePath && fs.existsSync(task.localFilePath)) {
    return fs.readFileSync(task.localFilePath);
  }

  if (task.bannerUrl && task.bannerUrl.startsWith('http')) {
    const res = await fetch(task.bannerUrl);
    if (!res.ok) throw new Error(`Download do banner falhou (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  return null;
}

module.exports = { IMAGE_TYPES, saveBanner, saveThumbnail, loadImage };
