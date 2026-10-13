-- Esquema Relacional (Amazon RDS PostgreSQL) para Loja de Ingressos.
-- Fonte única: também é executado pelo server.js na inicialização (idempotente).

CREATE TABLE IF NOT EXISTS events (
    id VARCHAR(100) PRIMARY KEY,
    team_home VARCHAR(100) NOT NULL,
    team_away VARCHAR(100) NOT NULL,
    stadium VARCHAR(150) NOT NULL,
    event_date TIMESTAMPTZ NOT NULL,
    category VARCHAR(100) DEFAULT 'Arquibancada',
    price NUMERIC(10,2) NOT NULL DEFAULT 100.00,
    available INTEGER NOT NULL DEFAULT 100 CHECK(available >= 0),
    description TEXT,
    banner_url TEXT,
    thumbnail_url TEXT,
    processing_status VARCHAR(50) DEFAULT 'completed',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(100) PRIMARY KEY,
    -- Sem FK/CASCADE de propósito: excluir um jogo não pode apagar o histórico de vendas.
    event_id VARCHAR(100) NOT NULL,
    event_name VARCHAR(200) NOT NULL,
    customer_name VARCHAR(150) NOT NULL,
    customer_email VARCHAR(150) NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total NUMERIC(10,2) NOT NULL,
    status VARCHAR(50) DEFAULT 'confirmed',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_available ON events(available);
CREATE INDEX IF NOT EXISTS idx_orders_event_id ON orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);
-- Setores de cada jogo (Arquibancada Norte/Sul, Cadeira Central, Camarote): preço e estoque próprios.
CREATE TABLE IF NOT EXISTS sectors (
    id VARCHAR(150) PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    code VARCHAR(30) NOT NULL,
    name VARCHAR(100) NOT NULL,
    price NUMERIC(10,2) NOT NULL CHECK(price > 0),
    capacity INTEGER NOT NULL CHECK(capacity >= 0),
    available INTEGER NOT NULL CHECK(available >= 0),
    UNIQUE (event_id, code)
);

-- Reserva temporária do checkout: o estoque sai do setor ao reservar e volta se a reserva expirar.
CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(100) PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL,
    sector_id VARCHAR(150) NOT NULL,
    customer_email VARCHAR(150) NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | converted | expired | cancelled
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Colunas novas em pedidos (idempotente: funciona em bancos já existentes)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sector_id VARCHAR(150);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sector_name VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ticket_status VARCHAR(20) DEFAULT 'pending'; -- pending | ready

CREATE INDEX IF NOT EXISTS idx_sectors_event ON sectors(event_id);
CREATE INDEX IF NOT EXISTS idx_reservations_active ON reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_customer ON reservations(customer_email, status);
