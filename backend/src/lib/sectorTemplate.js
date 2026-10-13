// Modelo padrão de setores de um estádio. Ao cadastrar um jogo o admin informa o preço base
// (arquibancada) e a capacidade total; os setores são gerados por esta tabela e podem ser
// ajustados depois, um a um, na edição do jogo.
const SECTOR_TEMPLATE = [
  { code: 'norte', name: 'Arquibancada Norte', priceFactor: 1, share: 0.35 },
  { code: 'sul', name: 'Arquibancada Sul', priceFactor: 1, share: 0.35 },
  { code: 'central', name: 'Cadeira Central', priceFactor: 1.75, share: 0.22 },
  { code: 'camarote', name: 'Camarote', priceFactor: 3.5, share: 0.08 }
];

const round2 = (n) => Math.round(n * 100) / 100;

function buildSectors(eventId, basePrice, capacity) {
  const total = Math.max(0, Math.floor(Number(capacity) || 0));
  const sectors = SECTOR_TEMPLATE.map((t) => ({
    id: `${eventId}-${t.code}`,
    eventId,
    code: t.code,
    name: t.name,
    price: round2(Number(basePrice) * t.priceFactor),
    capacity: Math.floor(total * t.share)
  }));
  // O que sobrar do arredondamento vai para a Arquibancada Norte
  sectors[0].capacity += total - sectors.reduce((sum, s) => sum + s.capacity, 0);
  return sectors.map((s) => ({ ...s, available: s.capacity }));
}

module.exports = { SECTOR_TEMPLATE, buildSectors };
