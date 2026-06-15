-- ============================================================
-- Análise Gerencial — Discrepâncias Operacionais
-- Uma linha por (vehicle_id, data, obra_id). Armazena tudo: dias OK
-- entram com discrepancias_json = '[]', dias não analisados nem existem.
-- Permite distinguir "dia OK" de "dia não processado".
-- ============================================================

CREATE TABLE IF NOT EXISTS analise_dia_maquina (
    id INT AUTO_INCREMENT PRIMARY KEY,
    obra_id VARCHAR(36) NULL,
    data DATE NOT NULL,
    vehicle_id VARCHAR(36) NOT NULL,
    employee_id INT NULL,                            -- só preenchido após integração com ponto (Fase 2)
    discrepancias_json JSON NOT NULL,                -- [] = dia OK; senão lista de { tipo, magnitude_min, intervalos_envolvidos }
    maior_magnitude_min INT NOT NULL DEFAULT 0,      -- 0 se OK; senão maior gap detectado — usado para ordenação
    fontes_disponiveis_json JSON NOT NULL,           -- { faturado:bool, rastreador:bool, ponto:bool }
    faturado_intervalos_json JSON NULL,
    rastreador_intervalos_json JSON NULL,
    ponto_intervalos_json JSON NULL,
    fonte_sinal ENUM('ignicao','velocidade') DEFAULT 'ignicao',
    justificado_em DATETIME NULL,
    justificado_por INT NULL,
    justificativa TEXT NULL,
    gerado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- obra_id pode ser NULL; coluna gerada com COALESCE garante 1 linha por chave
    obra_key VARCHAR(36) GENERATED ALWAYS AS (COALESCE(obra_id, '__none__')) STORED,
    UNIQUE KEY uk_vehicle_data_obra (vehicle_id, data, obra_key),
    INDEX idx_obra_data (obra_id, data),
    INDEX idx_magnitude (maior_magnitude_min, data),
    INDEX idx_employee (employee_id, data)
);

-- ============================================================
-- Flag de acesso à seção Análise Gerencial.
-- Permite dar acesso a sócio/gerente sem promover a admin pleno.
-- Bloco idempotente compatível com MySQL < 8.0.29 (sem ADD COLUMN IF NOT EXISTS).
-- ============================================================
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'canAccessAnaliseGerencial'
);
SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE users ADD COLUMN canAccessAnaliseGerencial TINYINT(1) NOT NULL DEFAULT 0',
    'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
