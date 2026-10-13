// Assinaturas do ingresso:
//  - token de download (JWT): permite baixar o PDF pelo link do e-mail, sem login, só daquele pedido;
//  - código do QR: id do pedido + assinatura HMAC, para a portaria detectar QR falsificado.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config');

const PURPOSE = 'ticket-download';

function signDownloadToken(orderId, expiresIn = '30d') {
  return jwt.sign({ sub: orderId, purpose: PURPOSE }, JWT_SECRET, { expiresIn });
}

// Retorna o id do pedido do token, ou null se inválido/expirado/de outro pedido
function verifyDownloadToken(token, orderId) {
  try {
    const payload = jwt.verify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'] });
    return payload.purpose === PURPOSE && payload.sub === orderId ? orderId : null;
  } catch (err) {
    return null;
  }
}

function qrSignature(orderId) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`ticket:${orderId}`).digest('hex').slice(0, 16);
}

const qrPayload = (orderId) => `INGRESSO:${orderId}:${qrSignature(orderId)}`;

module.exports = { signDownloadToken, verifyDownloadToken, qrPayload, qrSignature };
