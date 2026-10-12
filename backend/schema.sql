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