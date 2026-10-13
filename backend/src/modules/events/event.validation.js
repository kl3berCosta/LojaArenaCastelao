// Converte e valida os campos de um jogo. Em modo parcial (PUT) só valida o que foi enviado.
function parseEventFields(body, { partial }) {
  const values = {};
  const errors = [];
  const has = (k) => body[k] !== undefined && body[k] !== '';

  for (const [key, label] of [['teamHome', 'time mandante'], ['teamAway', 'time visitante'], ['stadium', 'estádio']]) {
    if (has(key)) values[key] = String(body[key]).trim();
    else if (!partial) errors.push(label);
  }
  if (has('category')) values.category = String(body.category).trim();
  if (body.description !== undefined) values.description = String(body.description);

  if (has('date')) {
    const d = new Date(body.date);
    if (Number.isNaN(d.getTime())) errors.push('data válida');
    else values.date = d.toISOString();
  } else if (!partial) errors.push('data');

  if (has('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) errors.push('preço maior que zero');
    else values.price = price;
  } else if (!partial) errors.push('preço');

  if (has('available')) {
    const available = Number(body.available);
    if (!Number.isInteger(available) || available < 0) errors.push('quantidade disponível (inteiro ≥ 0)');
    else values.available = available;
  }

  if (has('bannerUrl')) {
    if (/^https?:\/\//i.test(String(body.bannerUrl))) values.bannerUrl = String(body.bannerUrl);
    else errors.push('bannerUrl http(s)');
  }

  return { values, errors };
}

// Alterações de setores enviadas pelo admin na edição do jogo:
// JSON (string no formulário multipart, ou array) com [{ id, price?, available? }].
function parseSectorChanges(raw) {
  if (raw === undefined || raw === '') return { changes: null, errors: [] };
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (err) {
      return { changes: null, errors: ['setores (JSON inválido)'] };
    }
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) return { changes: null, errors: ['setores'] };

  const errors = [];
  const changes = list.map((item) => {
    const change = { id: String(item?.id || '') };
    if (!change.id) errors.push('id do setor');
    if (item?.price !== undefined && item.price !== '') {
      const price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0) errors.push(`preço do setor ${change.id}`);
      else change.price = Math.round(price * 100) / 100;
    }
    if (item?.available !== undefined && item.available !== '') {
      const available = Number(item.available);
      if (!Number.isInteger(available) || available < 0) errors.push(`disponível do setor ${change.id}`);
      else change.available = available;
    }
    return change;
  });
  return { changes: errors.length ? null : changes, errors };
}

module.exports = { parseEventFields, parseSectorChanges };
