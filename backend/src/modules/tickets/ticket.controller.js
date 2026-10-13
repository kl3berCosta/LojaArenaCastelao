// CONTROLLER de ingressos em PDF.
const Order = require('../orders/order.model');
const storage = require('../../lib/storage');
const { signDownloadToken, verifyDownloadToken } = require('./ticket.token');
const { serverError } = require('../../lib/http');

// GET /orders/:id/ticket (cliente logado) - status do PDF e link de download do próprio ingresso
async function getMine(req, res) {
  try {
    const order = await Order.findById(req.params.id);
    // 404 também para pedido de outra pessoa: não revelamos que ele existe
    if (!order || order.customerEmail !== req.user.email) {
      return res.status(404).json({ message: 'Ingresso não encontrado.' });
    }
    if (order.ticketStatus !== 'ready') {
      return res.status(202).json({ status: 'pending', message: 'O PDF do seu ingresso está sendo gerado. Tente em alguns segundos.' });
    }
    const token = signDownloadToken(order.id, '10m');
    return res.json({ status: 'ready', downloadUrl: `/tickets/${encodeURIComponent(order.id)}/download?token=${token}` });
  } catch (error) {
    return serverError(res, 'Erro ao consultar o ingresso.', error);
  }
}

const page = (title, text, refresh) => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="4">' : ''}
<title>${title}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="container" style="padding:60px 0"><section class="panel" style="max-width:560px;margin:0 auto;text-align:center">
<h2>${title}</h2><p class="sub">${text}</p><a class="btn btn-primary" href="/meus-ingressos.html">Ver meus ingressos</a>
</section></main></body></html>`;

// GET /tickets/:id/download?token=... - link do e-mail (sem login, protegido pelo token assinado)
async function download(req, res) {
  const orderId = verifyDownloadToken(req.query.token, req.params.id);
  if (!orderId) {
    return res.status(401).send(page('Link inválido ou expirado', 'Entre na sua conta e baixe o ingresso pela página Meus ingressos.'));
  }
  try {
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).send(page('Ingresso não encontrado', 'Este pedido não existe mais.'));
    if (order.ticketStatus !== 'ready') {
      return res.status(202).send(page('Gerando seu ingresso...', 'O PDF fica pronto em alguns segundos. Esta página atualiza sozinha.', true));
    }
    const target = await storage.ticketDownload(orderId);
    if (target.url) return res.redirect(302, target.url); // presigned URL do S3 (5 minutos)
    return res.type('application/pdf').sendFile(target.filePath);
  } catch (error) {
    return serverError(res, 'Erro ao baixar o ingresso.', error);
  }
}

module.exports = { getMine, download };
