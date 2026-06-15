-- ============================================================
-- Confronto Faturamento × Rastreador (SigaSul)
-- Tabela materializada de conciliação por placa+data+obra.
-- Atualizada via job diário e endpoint de reprocessamento manual.
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_tracker_confronto (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_id VARCHAR(36) NOT NULL,
    placa VARCHAR(20) NOT NULL,
    data DATE NOT NULL,
    obra_id VARCHAR(36) NULL,
    daily_log_id VARCHAR(36) NULL,
    bucket ENUM(
        'ok',
        'atividade_fora_janela',
        'sem_lancamento',
        'lancamento_sem_rastreio',
        'sem_dados_rastreador'
    ) NOT NULL,
    minutos_atividade_total INT DEFAULT 0,
    minutos_dentro_janela INT DEFAULT 0,
    minutos_fora_janela INT DEFAULT 0,
    intervalos_rastreador_json JSON NULL,
    intervalos_lancados_json JSON NULL,
    fonte_sinal ENUM('ignicao','velocidade') DEFAULT 'ignicao',
    gerado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- obra_id pode ser NULL (bucket sem_lancamento). MySQL trata NULLs como distintos
    -- em UNIQUE, então usamos coluna gerada com COALESCE para garantir 1 linha por chave.
    obra_key VARCHAR(36) GENERATED ALWAYS AS (COALESCE(obra_id, '__none__')) STORED,
    UNIQUE KEY uk_placa_data_obra (placa, data, obra_key),
    INDEX idx_bucket_data (bucket, data),
    INDEX idx_obra_data (obra_id, data),
    INDEX idx_vehicle_data (vehicle_id, data)
);
