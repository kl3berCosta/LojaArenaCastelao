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

module.exports = { parseEventFields };
