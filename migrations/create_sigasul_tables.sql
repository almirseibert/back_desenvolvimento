-- ============================================================
-- SigaSul: tabelas de persistência de rastreamento
-- Rodar manualmente no banco antes de iniciar o backend
-- ============================================================

-- 1. Estado de sincronização (sempre 1 linha)
CREATE TABLE IF NOT EXISTS sigasul_sync_state (
    id INT PRIMARY KEY DEFAULT 1,
    last_evento_controle_id BIGINT DEFAULT 0,
    last_positions_sync_date DATE DEFAULT NULL,
    last_summary_sync_date DATE DEFAULT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO sigasul_sync_state (id) VALUES (1);

-- 2. Posições históricas (retenção 90 dias via cron)
CREATE TABLE IF NOT EXISTS sigasul_positions (
    pos_id_ref BIGINT PRIMARY KEY,
    pos_data_hora_receb DATETIME NOT NULL,
    pos_placa VARCHAR(20) NOT NULL,
    pos_latitude DECIMAL(10,7),
    pos_longitude DECIMAL(10,7),
    pos_ignicao TINYINT(1),
    pos_velocidade INT,
    pos_odometro_calc INT,
    pos_equip_id VARCHAR(50),
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_placa_data (pos_placa, pos_data_hora_receb),
    INDEX idx_data (pos_data_hora_receb)
);

-- 3. Jornadas
CREATE TABLE IF NOT EXISTS sigasul_journeys (
    id_jornada BIGINT PRIMARY KEY,
    id_motorista INT,
    nome_motorista VARCHAR(200),
    cartao_motorista VARCHAR(50),
    id_cliente INT,
    nome_cliente VARCHAR(200),
    data_inicial DATETIME,
    data_final DATETIME,
    duracao_segundos INT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_data_inicial (data_inicial)
);

-- 4. Eventos de jornada
CREATE TABLE IF NOT EXISTS sigasul_journey_events (
    id_evento BIGINT PRIMARY KEY,
    id_evento_controle BIGINT UNIQUE,
    id_jornada BIGINT NOT NULL,
    id_tipo_evento INT,
    nome_tipo_evento VARCHAR(100),
    placa VARCHAR(20),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    data_inicio DATETIME,
    data_fim DATETIME,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_jornada (id_jornada),
    INDEX idx_placa_data (placa, data_inicio),
    INDEX idx_controle (id_evento_controle)
);

-- 5. Resumo diário por placa (para confronto rápido sem chamar a API)
CREATE TABLE IF NOT EXISTS sigasul_daily_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    placa VARCHAR(20) NOT NULL,
    data DATE NOT NULL,
    total_horas_ligado DECIMAL(8,4) DEFAULT 0,
    total_km DECIMAL(10,2) DEFAULT 0,
    num_eventos INT DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_placa_data (placa, data),
    INDEX idx_data (data)
);
