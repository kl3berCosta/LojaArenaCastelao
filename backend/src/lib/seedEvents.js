// Jogos iniciais: semeados no RDS quando a tabela está vazia (e no store local em desenvolvimento).
function seedEvents() {
  return [
    {
      id: 'match-1',
      teamHome: 'Fortaleza',
      teamAway: 'Ceará',
      stadium: 'Arena Castelão',
      date: '2026-10-25T16:00:00',
      price: 80.00,
      available: 320,
      category: 'Arquibancada',
      description: 'Clássico-Rei pelo Campeonato Brasileiro',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    },
    {
      id: 'match-2',
      teamHome: 'Ceará',
      teamAway: 'Sport',
      stadium: 'Arena Castelão',
      date: '2026-11-01T18:30:00',
      price: 60.00,
      available: 210,
      category: 'Cadeiras laterais',
      description: 'Rodada do Campeonato Brasileiro no Castelão',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    },
    {
      id: 'match-3',
      teamHome: 'Ferroviário',
      teamAway: 'Fortaleza',
      stadium: 'Estádio Presidente Vargas',
      date: '2026-11-08T19:00:00',
      price: 40.00,
      available: 260,
      category: 'Arquibancada',
      description: 'Jogo no tradicional Presidente Vargas',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    }
  ];
}

module.exports = { seedEvents };
