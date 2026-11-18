-- Initial schema migration for Consul (Vercel Neon PostgreSQL)
-- Run using DIRECT_URL (non-pooled connection)

-- 1. Пользователи (вход по телефону + 2 согласия)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT,
    lang VARCHAR(5) NOT NULL DEFAULT 'uz', -- 'uz' | 'ru' | 'en'
    role VARCHAR(20) NOT NULL DEFAULT 'user', -- 'user' | 'chamber' | 'admin'
    consent_at TIMESTAMPTZ, -- Обязательное согласие на ПДн
    consent_version VARCHAR(20),
    stats_consent_at TIMESTAMPTZ, -- Добровольное согласие на статистику Палаты
    prefs JSONB NOT NULL DEFAULT '{}'::jsonb, -- { largeFont, voiceReply, voiceSpeed }
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Профиль бизнеса (онбординг + срезы для Палаты)
CREATE TABLE IF NOT EXISTS businesses (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    trade TEXT NOT NULL,
    sector VARCHAR(30) NOT NULL, -- 'dried_fruit' | 'food' | 'clothes' | 'services' | 'other'
    market VARCHAR(30) NOT NULL, -- 'chorsu' | 'oloy' | 'parkent' | 'quyliq' | 'other'
    status VARCHAR(20) NOT NULL, -- 'yatt' | 'oob' | 'mchj' | 'none'
    regime VARCHAR(20) NOT NULL, -- 'turnover' | 'vat6' | 'vat12'
    reserve BIGINT NOT NULL DEFAULT 0, -- Неприкосновенный запас (в сумах)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- История смены статуса (метрика "перешли в белый бизнес" для Палаты)
CREATE TABLE IF NOT EXISTS business_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_status VARCHAR(20),
    new_status VARCHAR(20) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Контрагенты (должники по насия и поставщики)
CREATE TABLE IF NOT EXISTS counterparties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind VARCHAR(20) NOT NULL, -- 'customer' | 'supplier'
    phone VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Журнал операций (Единственный источник истины)
CREATE TABLE IF NOT EXISTS ops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL, -- 'sale' | 'buy' | 'exp' | 'sup' | 'nas' | 'repaid' | 'fix' | 'opening'
    amount BIGINT NOT NULL, -- > 0 (кроме 'fix', который хранит дельту со знаком)
    method VARCHAR(10) NOT NULL, -- 'naqd' | 'karta' | 'none'
    label TEXT,
    counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
    fiscal BOOLEAN NOT NULL DEFAULT FALSE, -- Был ли чек / QR / терминал
    source VARCHAR(20) NOT NULL DEFAULT 'manual', -- 'text' | 'voice' | 'photo' | 'manual' | 'seed'
    raw_text TEXT,
    items JSONB, -- Массив позиций из чека/накладной
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ, -- Soft delete для функции "Отменить"
    idempotency_key VARCHAR(100),
    UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ops_user_active ON ops (user_id, occurred_at DESC) WHERE deleted_at IS NULL;

-- 5. Обязательные платежи (аренда, поставщики, кредиты)
CREATE TABLE IF NOT EXISTS obligations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL, -- 'rent' | 'supplier' | 'loan' | 'other'
    title TEXT NOT NULL,
    amount BIGINT NOT NULL,
    due_day INT, -- День месяца (1-31) для регулярных
    due_date DATE, -- Конкретная дата для разовых
    recurring BOOLEAN NOT NULL DEFAULT TRUE,
    counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL
);

-- 6. Память Consul и Чаты
CREATE TABLE IF NOT EXISTS memory_facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value TEXT NOT NULL,
    source_chat_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    topic VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- 'user' | 'assistant'
    text TEXT NOT NULL,
    reply JSONB, -- Полный объект Reply для UI
    tool_calls JSONB, -- Трасса вызовов инструментов
    model VARCHAR(50),
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    latency_ms INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Опросы и Снимки Палаты (Задача 21)
CREATE TABLE IF NOT EXISTS survey_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question VARCHAR(100) NOT NULL,
    answer VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS palata_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_end DATE NOT NULL,
    window_days INT NOT NULL, -- 30 | 90
    cut VARCHAR(20) NOT NULL, -- 'all' | 'sector' | 'market'
    cut_key VARCHAR(50) NOT NULL, -- 'all' или код отрасли/рынка
    n INT NOT NULL CHECK (n >= 5), -- k-анонимность: меньше 5 не пишем
    metrics JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (period_end, window_days, cut, cut_key)
);

-- 8. История расчётов и Бизнес-планы
CREATE TABLE IF NOT EXISTS calculation_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL, -- 'loan' | 'tax' | 'breakeven'
    input JSONB NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    input JSONB NOT NULL,
    content TEXT,
    structured JSONB,
    tool_calls JSONB,
    lang VARCHAR(5) NOT NULL DEFAULT 'uz',
    model VARCHAR(50),
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
