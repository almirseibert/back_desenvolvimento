-- =============================================================================
-- Migration 002: Tabelas do Chatbot WhatsApp
-- Execute uma única vez. Use IF NOT EXISTS para ser seguro em reexecuções.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `whatsapp_chatbot_sessions` (
    `id`               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `phone_number`     VARCHAR(30)  NOT NULL,
    `employee_id`      VARCHAR(36)  NULL,
    `employee_name`    VARCHAR(150) NULL,
    `step`             VARCHAR(30)  NOT NULL DEFAULT 'veiculo',
    `session_data`     JSON         NULL,
    `foto_painel_path` VARCHAR(300) NULL,
    `created_at`       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `last_activity`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_phone_step_activity` (`phone_number`, `step`, `last_activity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Logs de mensagens WhatsApp (caso não exista)
CREATE TABLE IF NOT EXISTS `whatsapp_logs` (
    `id`                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `destinatario_nome`   VARCHAR(150) NULL,
    `destinatario_numero` VARCHAR(30)  NOT NULL,
    `motivo_envio`        VARCHAR(100) NULL,
    `mensagem`            TEXT         NULL,
    `anexo_url`           VARCHAR(500) NULL,
    `message_id_api`      VARCHAR(200) NULL,
    `status`              VARCHAR(20)  NOT NULL DEFAULT 'ENVIADO',
    `data_envio`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_data_envio` (`data_envio`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Solicitações de abastecimento (caso não exista)
CREATE TABLE IF NOT EXISTS `solicitacoes_abastecimento` (
    `id`                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `usuario_id`            INT UNSIGNED NULL,
    `veiculo_id`            INT UNSIGNED NOT NULL,
    `obra_id`               INT UNSIGNED NULL,
    `posto_id`              INT UNSIGNED NULL,
    `funcionario_id`        INT UNSIGNED NULL,
    `tipo_combustivel`      VARCHAR(30)  NOT NULL,
    `litragem_solicitada`   DECIMAL(10,2) NULL,
    `flag_tanque_cheio`     TINYINT(1)   NOT NULL DEFAULT 0,
    `flag_outros`           TINYINT(1)   NOT NULL DEFAULT 0,
    `horimetro_informado`   DECIMAL(10,2) NULL,
    `odometro_informado`    DECIMAL(10,2) NULL,
    `foto_painel_path`      VARCHAR(300) NULL,
    `foto_cupom_path`       VARCHAR(300) NULL,
    `geo_latitude`          DECIMAL(10,7) NULL,
    `geo_longitude`         DECIMAL(10,7) NULL,
    `status`                VARCHAR(30)  NOT NULL DEFAULT 'PENDENTE',
    `alerta_media_consumo`  TINYINT(1)   NOT NULL DEFAULT 0,
    `data_solicitacao`      DATE         NOT NULL,
    `data_aprovacao`        DATETIME     NULL,
    `aprovado_por_usuario_id` INT UNSIGNED NULL,
    `motivo_negativa`       TEXT         NULL,
    `observacao`            TEXT         NULL,
    INDEX `idx_status` (`status`),
    INDEX `idx_veiculo_status` (`veiculo_id`, `status`),
    INDEX `idx_data_solicitacao` (`data_solicitacao`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
