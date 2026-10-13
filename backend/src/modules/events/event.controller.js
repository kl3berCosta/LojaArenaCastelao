// CONTROLLER de jogos: valida a entrada, orquestra model + S3 + auditoria + cache + fila e monta a resposta HTTP.
const crypto = require('node:crypto');
const Event = require('./event.model');
const { parseEventFields, parseSectorChanges } = require('./event.validation');
const Sector = require('../sectors/sector.model');
const { logCrudAction } = require('../audit/audit.model');
const { getCached, invalidateCache } = require('../../lib/cache');
const storage = require('../../lib/storage');
const queue = require('../../lib/queue');
const { serverError } = require('../../lib/http');

const eventKey = (id) => `events:${id}`;

// Desacopla o processamento do banner (SNS -> SQS -> worker). Se a publicação falhar o jogo já foi salvo:
// marcamos o processamento como "failed" em vez de perder a requisição.
async function enqueueBanner(eventId, s3Info, file, bannerUrl) {
  try {
    return await queue.publishTask({
      eventId,
      bannerUrl,
      s3Bucket: s3Info?.bucket,
      s3Key: s3Info?.key,
      localFilePath: s3Info?.localPath,
      imageBase64: !s3Info?.bucket ? file.buffer.toString('base64') : null,
      fileName: file.originalname
    });
  } catch (error) {
    console.error('[Queue] Falha ao enfileirar processamento do banner:', error);
    await Event.update(eventId, { processingStatus: 'failed' }).catch(() => {});
    await invalidateCache(['events:list', eventKey(eventId)]);
    return null;
  }
}

// GET /events - lista com cache no Redis
async function list(req, res) {
  try {
    const events = await getCached('events:list', () => Event.findAll(), 60);
    logCrudAction('READ', 'event-list', { count: events.length }); // auditoria sem bloquear a resposta
    return res.json(events);
  } catch (error) {
    return serverError(res, 'Erro ao listar eventos.', error);
  }
}

// GET /events/:id - detalhe com cache no Redis
async function getOne(req, res) {
  try {
    const event = await getCached(eventKey(req.params.id), () => Event.findById(req.params.id), 60);
    if (!event) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }
    await logCrudAction('READ', 'event', { eventId: event.id, eventName: `${event.teamHome} x ${event.teamAway}` });
    return res.json(event);
  } catch (error) {
    return serverError(res, 'Erro ao buscar evento.', error);
  }
}

// POST /events - cria jogo (com banner opcional)
async function create(req, res) {
  const { values, errors } = parseEventFields(req.body || {}, { partial: false });
  if (errors.length) {
    return res.status(400).json({ message: `Campos inválidos ou ausentes: ${errors.join(', ')}.` });
  }

  try {
    const eventId = `match-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    let bannerUrl = values.bannerUrl || null;
    let s3Info = null;

    if (req.file) {
      s3Info = await storage.saveBanner(req.file);
      bannerUrl = s3Info.url;
    }

    const newEvent = {
      id: eventId,
      teamHome: values.teamHome,
      teamAway: values.teamAway,
      stadium: values.stadium,
      date: values.date,
      category: values.category || 'Arquibancada',
      price: values.price,
      available: values.available ?? 100,
      description: values.description || '',
      bannerUrl,
      thumbnailUrl: null,
      processingStatus: req.file ? 'pending' : 'completed',
      createdAt: new Date().toISOString()
    };

    const created = await Event.create(newEvent); // RDS (jogo + setores, numa transação)
    newEvent.sectors = created.sectors;
    await logCrudAction('CREATE', 'event', newEvent); // DynamoDB
    await invalidateCache(['events:list']); // Redis

    let queueInfo = null;
    if (req.file) {
      queueInfo = await enqueueBanner(eventId, s3Info, req.file, bannerUrl);
      if (!queueInfo) newEvent.processingStatus = 'failed';
    }

    return res.status(201).json({
      message: 'Evento cadastrado com sucesso!',
      event: newEvent,
      decoupledProcessing: queueInfo ? { enqueued: queueInfo.enqueued, provider: queueInfo.provider } : null
    });
  } catch (error) {
    return serverError(res, 'Erro ao criar evento.', error);
  }
}

// PUT /events/:id - atualiza somente os campos permitidos
async function update(req, res) {
  try {
    const existing = await Event.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    // Lista branca de campos: ignora id, thumbnailUrl, processingStatus etc. vindos do cliente.
    // Preço e estoque são editados por setor (campo `sectors`), não no jogo.
    const { values: updates, errors } = parseEventFields(req.body || {}, { partial: true });
    const { changes: sectorChanges, errors: sectorErrors } = parseSectorChanges(req.body?.sectors);
    errors.push(...sectorErrors);
    if (errors.length) {
      return res.status(400).json({ message: `Campos inválidos: ${errors.join(', ')}.` });
    }
    delete updates.price;
    delete updates.available;

    let s3Info = null;
    if (req.file) {
      s3Info = await storage.saveBanner(req.file);
      updates.bannerUrl = s3Info.url;
      updates.thumbnailUrl = null; // o thumbnail antigo não corresponde mais ao novo banner
      updates.processingStatus = 'pending';
    }

    if (sectorChanges && !(await Sector.updateMany(req.params.id, sectorChanges))) {
      return res.status(400).json({ message: 'Setor não pertence a este jogo.' });
    }

    const updated = await Event.update(req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    await logCrudAction('UPDATE', 'event', updated);
    await invalidateCache(['events:list', eventKey(req.params.id)]);

    if (req.file) {
      const queueInfo = await enqueueBanner(updated.id, s3Info, req.file, updated.bannerUrl);
      if (!queueInfo) updated.processingStatus = 'failed';
    }

    return res.json({ message: 'Evento atualizado com sucesso!', event: updated });
  } catch (error) {
    return serverError(res, 'Erro ao atualizar evento.', error);
  }
}

// DELETE /events/:id
async function remove(req, res) {
  try {
    const deleted = await Event.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    await logCrudAction('DELETE', 'event', deleted);
    await invalidateCache(['events:list', eventKey(req.params.id)]);

    return res.json({ message: 'Evento removido com sucesso!', event: deleted });
  } catch (error) {
    return serverError(res, 'Erro ao excluir evento.', error);
  }
}

module.exports = { list, getOne, create, update, remove };
