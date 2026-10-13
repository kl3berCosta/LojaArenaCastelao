// Gera o PDF do ingresso (A5) com QR code. Executado pelo worker, fora da requisição de compra.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { qrPayload } = require('./ticket.token');

const NAVY = '#0b1e3a';
const SUN = '#ff7a1a';
const MUTED = '#667089';

const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Fortaleza' });
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
  return `${date} às ${time}`;
}

// order: pedido confirmado; event: { teamHome, teamAway, stadium, date } (pode ser null)
async function generateTicketPdf(order, event) {
  const qrPng = await QRCode.toBuffer(qrPayload(order.id), { errorCorrectionLevel: 'M', margin: 1, width: 360 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margins: { top: 36, left: 36, right: 36, bottom: 8 }, info: { Title: `Ingresso ${order.id}`, Author: 'Ingressos Futebol' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    // Cabeçalho
    doc.rect(0, 0, W, 92).fill(NAVY);
    doc.fillColor(SUN).font('Helvetica-Bold').fontSize(9).text('INGRESSO OFICIAL DIGITAL', 36, 26, { characterSpacing: 1.5 });
    const teams = event ? `${event.teamHome} x ${event.teamAway}` : order.eventName;
    doc.fillColor('#ffffff').fontSize(20).text(teams, 36, 42, { width: W - 72 });

    // Dados do jogo
    let y = 112;
    const line = (label, value) => {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), 36, y, { characterSpacing: 0.8 });
      doc.fillColor(NAVY).font('Helvetica').fontSize(11.5).text(value || '-', 36, y + 11, { width: W - 72 });
      y += 34;
    };
    if (event) {
      line('Estádio', event.stadium);
      line('Data e horário', when(event.date));
    }
    line('Setor', order.sectorName || 'Arquibancada');
    line('Quantidade', `${order.quantity} ingresso(s)${order.unitPrice ? ` x ${money(order.unitPrice)}` : ''}`);
    line('Titular', `${order.customerName} (${order.customerEmail})`);
    line('Total pago', money(order.total));

    // QR code
    const qrSize = 150;
    const qrX = (W - qrSize) / 2;
    y += 6;
    doc.image(qrPng, qrX, y, { width: qrSize, height: qrSize });
    y += qrSize + 8;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('CÓDIGO LOCALIZADOR', 36, y, { width: W - 72, align: 'center' });
    doc.fillColor(NAVY).font('Courier-Bold').fontSize(9).text(order.id, 36, y + 11, { width: W - 72, align: 'center' });

    // Rodapé
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text('Apresente este QR code na entrada do estádio. O código é único e válido para um único acesso por ingresso.',
        36, doc.page.height - 44, { width: W - 72, align: 'center' });
    doc.end();
  });
}

module.exports = { generateTicketPdf };
