require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const http = require('http');

// ====================================================================
// MIGRAÇÃO AUTOMÁTICA DE SCHEMA (adiciona colunas se não existirem)
// ====================================================================
(async () => {
    // { table, column, definition }
    const migrations = [
        { table: 'users',                  column: 'tentativas_falhas_abastecimento', def: 'INT DEFAULT 0' },
        { table: 'users',                  column: 'bloqueado_abastecimento',         def: 'TINYINT(1) DEFAULT 0' },
        { table: 'users',                  column: 'page_permissions',                def: 'JSON DEFAULT NULL' },
        { table: 'users',                  column: 'canAccessAnaliseGerencial',       def: 'TINYINT(1) NOT NULL DEFAULT 0' },
        { table: 'comboio_transactions',   column: 'authNumber',                      def: 'INT UNSIGNED DEFAULT NULL' },
        { table: 'obras',                  column: 'tipo_registro',                   def: "ENUM('obra','centro_custo') DEFAULT 'obra'" },
        // FASE 1.3 — Campos adicionais em obras
        { table: 'obras',                  column: 'orgao_contratante',               def: "VARCHAR(50) DEFAULT NULL" },
        { table: 'obras',                  column: 'regiao',                          def: "ENUM('Lajeado','Santa Maria') DEFAULT NULL" },
        // NOTA: obras.created_at é adicionada em IIFE dedicado (com backfill one-time), não aqui.
        // FASE 0.4 — Sub-tipos e médias de consumo
        { table: 'vehicles',               column: 'sub_tipo',                        def: 'VARCHAR(100) DEFAULT NULL' },
        { table: 'vehicles',               column: 'media_consumo',                   def: 'DECIMAL(10,3) DEFAULT NULL' },
        { table: 'vehicles',               column: 'percentual_tolerancia',           def: 'DECIMAL(5,2) DEFAULT 20.00' },
        // Veículos fictícios (ajuda de custo, gerador, lava-jato etc.) — ignoram bloqueio de ordem duplicada
        { table: 'vehicles',               column: 'permiteMultiplosAbastecimentos',  def: 'TINYINT(1) DEFAULT 0' },
        // Funcionários "placeholder" (COLABORADOR, TESTE, MAK SERVIÇOS etc.) usados
        // como operador temporário ao alocar veículo em obra antes do operador real.
        { table: 'employees',              column: 'isPlaceholder',                   def: 'TINYINT(1) DEFAULT 0' },
        // FASE 2.4 — Toxicológico
        { table: 'employees',              column: 'exameToxicologicoVencimento',      def: 'DATE DEFAULT NULL' },
        // FASE 2.9 — Canais de envio de ordem para parceiros (posto)
        { table: 'partners',               column: 'envia_por_whatsapp',               def: 'TINYINT(1) DEFAULT 0' },
        { table: 'partners',               column: 'envia_por_email',                  def: 'TINYINT(1) DEFAULT 0' },
        // FASE 2.10 — Colunas de movimentação de pneus
        { table: 'tire_transactions',      column: 'employeeName',                     def: 'VARCHAR(255) NULL' },
        { table: 'tire_transactions',      column: 'odometer',                         def: 'DECIMAL(10,1) NULL' },
        { table: 'tire_transactions',      column: 'horimeter',                        def: 'DECIMAL(10,1) NULL' },
        // FASE 2.6 — Comboio: períodos por obra + parceiro comboio
        { table: 'comboio_transactions',   column: 'obra_periodo_id',                  def: 'VARCHAR(36) DEFAULT NULL' },
        // Fotos das distribuições feitas pelo operador do comboio direto na obra
        // (horímetro, RE/placa, medidor zerado, medidor com litragem). JSON com URLs.
        { table: 'comboio_transactions',   column: 'fotos',                            def: 'JSON DEFAULT NULL' },
        // Drenagem: destino do combustível retirado do veículo de origem.
        // 'comboio' (devolve ao tanque do comboio), 'transfusao' (abastece outro
        // equipamento) ou 'eliminado' (combustível contaminado, descartado).
        { table: 'comboio_transactions',   column: 'destino',                          def: "VARCHAR(20) DEFAULT NULL" },
        { table: 'partners',               column: 'vehicle_id',                       def: 'VARCHAR(36) DEFAULT NULL' },
        // Campo KM/Hr atual no modal de OS/OC
        { table: 'orders',                 column: 'kmHrAtual',                        def: 'DECIMAL(12,1) DEFAULT NULL' },
        { table: 'orders',                 column: 'kmHrUnit',                         def: "VARCHAR(10) DEFAULT NULL" },
        // ── Saldo pré-pago em postos (controle de crédito por parceiro) ──
        // reserved_amount: valor empenhado quando a ordem foi criada (NULL em ordens antigas / fill-up sem valor)
        // reserved_price: preço usado no empenho (auditoria)
        // is_full_tank: ordem "encher tanque" — empenho fica em aberto até a baixa com o valor real
        { table: 'refuelings',             column: 'reserved_amount',                  def: 'DECIMAL(12,2) DEFAULT NULL' },
        { table: 'refuelings',             column: 'reserved_price',                   def: 'DECIMAL(8,3) DEFAULT NULL' },
        { table: 'refuelings',             column: 'is_full_tank',                     def: 'TINYINT(1) DEFAULT 0' },
        // Liga o refueling-espelho (ajuste negativo da origem / abastecimento do
        // receptor) à transação de drenagem que o gerou, para permitir reversão
        // na exclusão e o desconto de litragem no cálculo de médias.
        { table: 'refuelings',             column: 'drenagemTransactionId',            def: 'VARCHAR(36) DEFAULT NULL' },
        // ── Módulo de Planejamento de Obras (pré-obra) ──
        // Ciclo de vida: radar → planejada → mobilizacao → ativa → finalizada.
        // 'dataFimPrevisto' já existia no schema (órfã) e foi adotada; aqui só o par de início.
        { table: 'obras',                  column: 'dataInicioPrevisto',               def: 'DATE DEFAULT NULL' },
        { table: 'obras',                  column: 'origemInfo',                       def: 'VARCHAR(255) DEFAULT NULL' },
        { table: 'obras',                  column: 'confiancaInfo',                    def: "ENUM('rumor','plano_oficial','contrato_assinado') DEFAULT NULL" },
        { table: 'obras',                  column: 'obsPlanejamento',                  def: 'TEXT DEFAULT NULL' },
        // Plano de trabalho por SUBGRUPO (vehicles.sub_tipo) — contratos diferenciam
        // ex. Escavadeira 13t vs 26t. Campos antigos (…PorTipo) seguem como fallback.
        { table: 'obras',                  column: 'horasContratadasPorSubTipo',       def: 'JSON DEFAULT NULL' },
        { table: 'obras',                  column: 'valoresPorSubTipo',                def: 'JSON DEFAULT NULL' },
    ];

    for (const { table, column, def } of migrations) {
        try {
            await db.query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${column}\` ${def}`);
        } catch (e) {
            if (e.code === 'ER_PARSE_ERROR') {
                // MySQL < 8.0.3: fallback sem IF NOT EXISTS
                try {
                    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
                } catch (e2) {
                    if (e2.code !== 'ER_DUP_FIELDNAME') console.warn(`[migration] ${table}.${column}:`, e2.message);
                }
            } else if (e.code !== 'ER_DUP_FIELDNAME') {
                console.warn(`[migration] ${table}.${column}:`, e.message);
            }
        }
    }

    // Índice de performance para authNumber em comboio_transactions
    try {
        await db.query('ALTER TABLE `comboio_transactions` ADD INDEX `idx_authNumber` (`authNumber`)');
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') console.warn('[migration] idx_authNumber:', e.message);
    }

    // Backfill idempotente: drenagens antigas eram sempre "para o comboio".
    try {
        await db.query(
            "UPDATE comboio_transactions SET destino = 'comboio' WHERE type = 'drenagem' AND (destino IS NULL OR destino = '')"
        );
    } catch (e) {
        console.warn('[migration] backfill comboio_transactions.destino:', e.message);
    }

    // ───── Expandir ENUM partners.tipo_parceiro para suportar 'comboio' e 'locador' ─────
    // Causa do erro: "Data truncated for column 'tipo_parceiro' at row 1"
    // ao distribuir combustível de comboio (qualquer gravação que tentasse
    // 'comboio' falhava porque o ENUM só tinha 'posto' e 'fornecedor').
    // 'locador' (Equip. Terceirizados) foi adicionado depois: sem ele no ENUM,
    // o cadastro de Locador caía no fallback 'posto' e aparecia na aba errada.
    try {
        await db.query(`
            ALTER TABLE \`partners\`
            MODIFY COLUMN \`tipo_parceiro\` ENUM('posto','fornecedor','comboio','locador') DEFAULT 'posto'
        `);
        // Garante que nenhum registro fique com tipo nulo/vazio
        await db.query(`UPDATE partners SET tipo_parceiro = 'posto' WHERE tipo_parceiro IS NULL OR tipo_parceiro = ''`);
    } catch (e) {
        console.warn('[migration] partners.tipo_parceiro ENUM:', e.message);
    }

    // ───── Normalizar whatsapp_chatbot_sessions.step para VARCHAR(30) ─────
    // Causa do erro: "Data truncated for column 'step' at row 1" ao avançar
    // para 'posto'/'leitura' etc. — em produção a coluna foi criada como ENUM
    // antigo (sem todos os steps) ou VARCHAR curto. Migração idempotente.
    try {
        await db.query(`
            ALTER TABLE \`whatsapp_chatbot_sessions\`
            MODIFY COLUMN \`step\` VARCHAR(30) NOT NULL DEFAULT 'veiculo'
        `);
    } catch (e) {
        console.warn('[migration] whatsapp_chatbot_sessions.step:', e.message);
    }

    // ───── Seed de funcionários "placeholder" conhecidos ─────
    // Marca como isPlaceholder=1 funcionários cujo nome bate com os usados
    // historicamente como operador temporário ao alocar veículo a uma obra.
    // Admin pode marcar mais funcionários manualmente pelo cadastro.
    try {
        await db.query(`
            UPDATE employees
            SET isPlaceholder = 1
            WHERE isPlaceholder = 0
              AND UPPER(TRIM(nome)) IN (
                'COLABORADOR', 'TESTE', 'FUNC. TESTE', 'FUNC TESTE',
                'FUNCIONÁRIO TESTE', 'FUNCIONARIO TESTE', 'MAK SERVIÇOS', 'MAK SERVICOS'
              )
        `);
    } catch (e) {
        console.warn('[migration] seed employees.isPlaceholder:', e.message);
    }

    console.log('✅ Migração de schema concluída.');
})();

// ====================================================================
// MIGRAÇÃO AUTOMÁTICA — Tabelas Siga Sul (criação segura IF NOT EXISTS)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS sigasul_sync_state (
                id INT PRIMARY KEY DEFAULT 1,
                last_evento_controle_id BIGINT DEFAULT 0,
                last_positions_sync_date DATE DEFAULT NULL,
                last_summary_sync_date DATE DEFAULT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await db.query(`INSERT IGNORE INTO sigasul_sync_state (id) VALUES (1)`);
        await db.query(`
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
            )
        `);
        await db.query(`
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
            )
        `);
        await db.query(`
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
            )
        `);
        await db.query(`
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
            )
        `);
        console.log('✅ Migração Siga Sul concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] Siga Sul:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de Configuração de Tipos/Sub-tipos de Veículos
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_type_configs (
                id              VARCHAR(36)    PRIMARY KEY,
                tipo            VARCHAR(100)   NOT NULL,
                sub_tipo        VARCHAR(100)   DEFAULT NULL,
                media_consumo_padrao      DECIMAL(10,3)  DEFAULT NULL,
                percentual_tolerancia_padrao  DECIMAL(5,2)   DEFAULT 20.00,
                unidade         ENUM('L/h','h/L','Km/L','L/Km') NOT NULL DEFAULT 'L/h',
                created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
                updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_tipo_subtipo (tipo, sub_tipo)
            )
        `);
        // Tabelas antigas: amplia o ENUM (L/hr,L/100km -> 4 unidades) e converte valores legados.
        try {
            await db.query(`ALTER TABLE vehicle_type_configs
                MODIFY COLUMN unidade ENUM('L/h','h/L','Km/L','L/Km','L/hr','L/100km') NOT NULL DEFAULT 'L/h'`);
            await db.query(`UPDATE vehicle_type_configs SET unidade = 'L/h'  WHERE unidade = 'L/hr'`);
            await db.query(`UPDATE vehicle_type_configs SET unidade = 'Km/L' WHERE unidade = 'L/100km'`);
            await db.query(`ALTER TABLE vehicle_type_configs
                MODIFY COLUMN unidade ENUM('L/h','h/L','Km/L','L/Km') NOT NULL DEFAULT 'L/h'`);
        } catch (e2) {
            console.warn('⚠️ [migration] ajuste ENUM unidade:', e2.message);
        }
        console.log('✅ Migração vehicle_type_configs concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] vehicle_type_configs:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Taxonomia de Veículos (grupos → tipos → sub-tipos)
// Com seed idempotente a partir de utils/vehicleRules (fallback hardcoded)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_groups (
                id          VARCHAR(36)  PRIMARY KEY,
                nome        VARCHAR(100) NOT NULL UNIQUE,
                unidade     ENUM('L/h','h/L','Km/L','L/Km') NOT NULL DEFAULT 'L/h',
                ordem       INT          DEFAULT 0,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_types (
                id          VARCHAR(36)  PRIMARY KEY,
                group_id    VARCHAR(36)  NOT NULL,
                nome        VARCHAR(100) NOT NULL,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_group_nome (group_id, nome),
                CONSTRAINT fk_vt_group FOREIGN KEY (group_id) REFERENCES vehicle_groups(id) ON DELETE CASCADE
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_sub_types (
                id          VARCHAR(36)  PRIMARY KEY,
                type_id     VARCHAR(36)  NOT NULL,
                nome        VARCHAR(100) NOT NULL,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_type_nome (type_id, nome),
                CONSTRAINT fk_vst_type FOREIGN KEY (type_id) REFERENCES vehicle_types(id) ON DELETE CASCADE
            )
        `);

        // Seed apenas quando vazio (não sobrescreve edições do admin)
        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM vehicle_groups');
        if (total === 0) {
            const { randomUUID } = require('crypto');
            const { vehicleGroups, vehicleSubTypes } = require('./utils/vehicleRules');
            const groupNames = Object.keys(vehicleGroups);
            let ordem = 0;
            for (const grupo of groupNames) {
                const unidade = (grupo === 'Veículos Leves' || grupo === 'Caminhões de Trecho') ? 'Km/L' : 'L/h';
                const groupId = randomUUID();
                await db.query(
                    'INSERT INTO vehicle_groups (id, nome, unidade, ordem) VALUES (?, ?, ?, ?)',
                    [groupId, grupo, unidade, ordem++]
                );
                for (const tipo of vehicleGroups[grupo]) {
                    const typeId = randomUUID();
                    await db.query(
                        'INSERT INTO vehicle_types (id, group_id, nome) VALUES (?, ?, ?)',
                        [typeId, groupId, tipo]
                    );
                    for (const sub of (vehicleSubTypes[tipo] || [])) {
                        await db.query(
                            'INSERT INTO vehicle_sub_types (id, type_id, nome) VALUES (?, ?, ?)',
                            [randomUUID(), typeId, sub]
                        );
                    }
                }
            }
            console.log('🌱 Seed de taxonomia de veículos populado.');
        }
        console.log('✅ Migração taxonomia de veículos concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] taxonomia de veículos:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de períodos por obra dos comboios (Fase 2.6)
// Toda vez que um comboio é alocado/realocado entre obras, fechamos o
// período anterior e abrimos um novo. Permite atribuir cada transação
// do comboio a uma "estadia" específica em uma obra.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS comboio_periodos_obra (
                id          VARCHAR(36) PRIMARY KEY,
                comboio_id  VARCHAR(36) NOT NULL,
                obra_id     VARCHAR(36) NOT NULL,
                data_inicio DATETIME    NOT NULL,
                data_fim    DATETIME    DEFAULT NULL,
                ativo       TINYINT(1)  DEFAULT 1,
                created_at  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_comboio (comboio_id),
                INDEX idx_obra    (obra_id),
                INDEX idx_ativo   (ativo)
            )
        `);

        // Backfill: para cada veículo-comboio com obraAtualId mas sem período ativo,
        // abre um período. Idempotente — só faz nada se já existir.
        const { ensureOpenComboioPeriod } = require('./utils/comboioPeriodo');
        const [comboios] = await db.query(
            "SELECT id, obraAtualId FROM vehicles WHERE isComboioVehicle = 1 AND obraAtualId IS NOT NULL"
        );
        let opened = 0;
        for (const c of comboios) {
            const result = await ensureOpenComboioPeriod(db, c.id, c.obraAtualId);
            if (result?.created) opened++;
        }
        console.log(`✅ comboio_periodos_obra: ${opened} períodos abertos (backfill).`);
    } catch (e) {
        console.warn('⚠️ [migration] comboio_periodos_obra:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de contatos internos (Fase 4.1)
// Cadastro central de pessoas-chave (RH, Coordenação, Gestores) para
// referência rápida e como destinos de notificação futuros.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS internal_contacts (
                id         VARCHAR(36)  PRIMARY KEY,
                nome       VARCHAR(200) NOT NULL,
                cargo      VARCHAR(100) DEFAULT NULL,
                setor      VARCHAR(100) DEFAULT NULL,
                whatsapp   VARCHAR(20)  DEFAULT NULL,
                email      VARCHAR(200) DEFAULT NULL,
                observacao VARCHAR(500) DEFAULT NULL,
                ativo      TINYINT(1)   DEFAULT 1,
                created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_ativo (ativo),
                INDEX idx_nome  (nome)
            )
        `);
        console.log('✅ internal_contacts: tabela ok.');
    } catch (e) {
        console.warn('⚠️ [migration] internal_contacts:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de destinos de notificação (Fase 3.1)
// Configura, por event_type + canal (whatsapp/email), quem deve receber
// notificações. Substitui destinatários hardcoded no cronService.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS notification_targets (
                id           VARCHAR(36)   PRIMARY KEY,
                event_type   VARCHAR(100)  NOT NULL,
                channel      ENUM('whatsapp','email') NOT NULL,
                target_type  ENUM('user','role','employee','phone','email_address') NOT NULL,
                target_value VARCHAR(255)  NOT NULL,
                label        VARCHAR(200)  DEFAULT NULL,
                active       TINYINT(1)    DEFAULT 1,
                created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_event   (event_type),
                INDEX idx_channel (channel),
                INDEX idx_active  (active)
            )
        `);
        console.log('✅ notification_targets: tabela ok.');

        // Adiciona 'internal_contact' ao enum de target_type (idempotente).
        try {
            await db.query(
                "ALTER TABLE notification_targets MODIFY COLUMN target_type ENUM('user','role','employee','phone','email_address','internal_contact') NOT NULL"
            );
        } catch (alterErr) {
            console.warn('⚠️ [migration] enum internal_contact em notification_targets:', alterErr.message);
        }
    } catch (e) {
        console.warn('⚠️ [migration] notification_targets:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tokens de push do app mobile (Seção 11 do app)
// Cada dispositivo logado registra seu Expo push token (POST /auth/push-token).
// O notificationDispatcher usa o canal 'push' para resolver user/role → tokens
// e enviar via Expo Push API. Também adiciona 'push' ao enum de canais.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS user_push_tokens (
                id         INT AUTO_INCREMENT PRIMARY KEY,
                user_id    INT          NOT NULL,
                token      VARCHAR(255) NOT NULL,
                platform   VARCHAR(20)  DEFAULT NULL,
                updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_token (token),
                INDEX idx_user (user_id)
            )
        `);
        // Adiciona 'push' ao enum de canais (idempotente: ignora se já tiver).
        try {
            await db.query(
                "ALTER TABLE notification_targets MODIFY COLUMN channel ENUM('whatsapp','email','push') NOT NULL"
            );
        } catch (alterErr) {
            console.warn('⚠️ [migration] enum push em notification_targets:', alterErr.message);
        }
        console.log('✅ user_push_tokens: tabela ok.');
    } catch (e) {
        console.warn('⚠️ [migration] user_push_tokens:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de refresh tokens (renovação silenciosa de sessão)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id         VARCHAR(36)  NOT NULL PRIMARY KEY,
                user_id    VARCHAR(64)  NOT NULL,
                token_hash CHAR(64)     NOT NULL,
                expires_at DATETIME     NOT NULL,
                revoked    TINYINT(1)   NOT NULL DEFAULT 0,
                created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_token_hash (token_hash),
                INDEX idx_user (user_id),
                INDEX idx_expires (expires_at)
            )
        `);
        console.log('✅ refresh_tokens: tabela ok.');
    } catch (e) {
        console.warn('⚠️ [migration] refresh_tokens:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Garante partner-espelho para todo veículo-comboio existente
// ====================================================================
(async () => {
    try {
        const { syncAllComboioPartners } = require('./utils/ensureComboioPartner');
        const result = await syncAllComboioPartners(db);
        console.log(`✅ Comboio→partners sync: ${result.synced}/${result.total} veículos.`);
    } catch (e) {
        console.warn('⚠️ [migration] sync comboio→partners:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de log de erros de solicitação de abastecimento (app)
// Registra cada tentativa errônea (regressão de leitura, salto excessivo,
// duplicidade, estouro orçamentário) para análise de quem/quando/por quê.
// Também desbloqueia usuários que ficaram travados pelo antigo limite de 3.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS solicitacao_erros_log (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id      INT          NOT NULL,
                usuario_nome    VARCHAR(200) DEFAULT NULL,
                veiculo_id      VARCHAR(36)  DEFAULT NULL,
                veiculo_placa   VARCHAR(20)  DEFAULT NULL,
                obra_id         VARCHAR(36)  DEFAULT NULL,
                campo_erro      VARCHAR(50)  NOT NULL,
                tipo_erro       VARCHAR(50)  NOT NULL,
                mensagem        TEXT         NOT NULL,
                valor_informado VARCHAR(50)  DEFAULT NULL,
                valor_anterior  VARCHAR(50)  DEFAULT NULL,
                created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_usuario (usuario_id),
                INDEX idx_data    (created_at)
            )
        `);
        // Liberar usuários bloqueados pelo antigo critério dos 3 erros
        await db.query('UPDATE users SET bloqueado_abastecimento = 0 WHERE bloqueado_abastecimento = 1');
        console.log('✅ Migração solicitacao_erros_log concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] solicitacao_erros_log:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Requisições operacionais (sugestões de mudança de obra/operador)
// Usuários da Central Operacional sugerem ao admin a real obra/operador de um
// veículo. Sem fluxo de aprovação dedicado — admin visualiza em ADMIN → Frota.
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS operational_requests (
                id                  INT AUTO_INCREMENT PRIMARY KEY,
                tipo                VARCHAR(30)  NOT NULL,
                veiculo_id          VARCHAR(36)  NOT NULL,
                veiculo_registro    VARCHAR(100) DEFAULT NULL,
                obra_atual_id       VARCHAR(36)  DEFAULT NULL,
                obra_atual_nome     VARCHAR(200) DEFAULT NULL,
                operador_atual_nome VARCHAR(200) DEFAULT NULL,
                valor_sugerido_id   VARCHAR(36)  DEFAULT NULL,
                valor_sugerido_nome VARCHAR(200) NOT NULL,
                observacao          TEXT         DEFAULT NULL,
                status              VARCHAR(20)  DEFAULT 'pendente',
                solicitante_id      VARCHAR(36)  DEFAULT NULL,
                solicitante_email   VARCHAR(200) DEFAULT NULL,
                created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_veiculo (veiculo_id)
            )
        `);
        // Garante o tipo correto da coluna em bancos onde a tabela já existe com INT.
        try {
            await db.query('ALTER TABLE operational_requests MODIFY COLUMN solicitante_id VARCHAR(36) DEFAULT NULL');
        } catch (alterErr) {
            if (alterErr.code !== 'ER_DUP_FIELDNAME') {
                console.warn('[migration] ALTER operational_requests.solicitante_id:', alterErr.message);
            }
        }
        console.log('✅ Migração operational_requests concluída.');

        // Seed do template de cobrança de horas, se ainda não existir.
        // O admin pode editar o conteúdo na tela Comunicação > Templates.
        // Variáveis: {{responsavel}}, {{primeiro_nome}}, {{veiculo}}, {{obra}}, {{dias}}
        const TEMPLATE_COBRANCA_HORAS = 'Cobrança de Horas — Operacional';
        const conteudoPadrao =
            'Olá, {{primeiro_nome}}! Tudo bem? 😊\n\n' +
            'Notamos que o lançamento de horas do equipamento *{{veiculo}}* na obra *{{obra}}* está pendente há *{{dias}} dia(s)*.\n\n' +
            'Por gentileza, poderia regularizar o registro das horas assim que possível? Isso nos ajuda a manter o controle da obra em dia.\n\n' +
            'Agradecemos a colaboração! 🙏\n— Equipe MAK Serviços';
        // Garante que a tabela e a coluna event_key existam antes do seed —
        // o ALTER em adminRoutes.js pode ainda não ter rodado nesta ordem de boot.
        await db.query(`
            CREATE TABLE IF NOT EXISTS message_templates (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM message_templates LIKE 'event_key'");
            if (!cols || cols.length === 0) {
                await db.query("ALTER TABLE message_templates ADD COLUMN event_key VARCHAR(60) NULL UNIQUE AFTER id");
            }
        } catch (e) {
            console.warn('[migration] message_templates.event_key (server.js):', e.message);
        }
        await db.query(
            "UPDATE message_templates SET event_key = 'cobranca_horas_operacional' WHERE event_key IS NULL AND name = ?",
            [TEMPLATE_COBRANCA_HORAS]
        );
        const [existing] = await db.query(
            "SELECT id FROM message_templates WHERE event_key = 'cobranca_horas_operacional' OR name = ? LIMIT 1",
            [TEMPLATE_COBRANCA_HORAS]
        );
        if (!existing || existing.length === 0) {
            await db.query(
                'INSERT INTO message_templates (event_key, name, channel, content) VALUES (?, ?, ?, ?)',
                ['cobranca_horas_operacional', TEMPLATE_COBRANCA_HORAS, 'whatsapp', conteudoPadrao]
            );
            console.log('✅ Template padrão de cobrança de horas inserido.');
        }
    } catch (e) {
        console.warn('⚠️ [migration] operational_requests:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Fase 1.2: Tabela de médias de consumo de combustível
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_fuel_averages (
                id                VARCHAR(36)    PRIMARY KEY,
                vehicle_id        VARCHAR(36)    NOT NULL,
                vehicle_tipo      VARCHAR(100),
                vehicle_sub_tipo  VARCHAR(100),
                last_refueling_id VARCHAR(36),
                avg_last_1        DECIMAL(10,3)  DEFAULT NULL,
                avg_last_2        DECIMAL(10,3)  DEFAULT NULL,
                avg_last_3        DECIMAL(10,3)  DEFAULT NULL,
                avg_by_tipo       DECIMAL(10,3)  DEFAULT NULL,
                avg_by_subtipo    DECIMAL(10,3)  DEFAULT NULL,
                updated_at        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_vehicle (vehicle_id),
                INDEX idx_tipo    (vehicle_tipo),
                FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Migração vehicle_fuel_averages concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] vehicle_fuel_averages:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Tabela de Períodos de Obra do Comboio (Fase 2.6)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS comboio_periodos_obra (
                id          VARCHAR(36)  PRIMARY KEY,
                comboio_id  VARCHAR(36)  NOT NULL,
                obra_id     VARCHAR(36)  NOT NULL,
                data_inicio DATETIME     NOT NULL,
                data_fim    DATETIME     DEFAULT NULL,
                ativo       TINYINT(1)   DEFAULT 1,
                INDEX idx_comboio (comboio_id),
                INDEX idx_obra    (obra_id)
            )
        `);
        console.log('✅ Migração comboio_periodos_obra concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] comboio_periodos_obra:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Documentos dos Veículos (CRLV, PDFs, etc.)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_documents (
                id          VARCHAR(36)  PRIMARY KEY,
                vehicle_id  VARCHAR(36)  NOT NULL,
                nome        VARCHAR(255) NOT NULL,
                tipo        VARCHAR(100) DEFAULT 'Outro',
                url         VARCHAR(500) NOT NULL,
                tamanho     INT          DEFAULT NULL,
                uploaded_by VARCHAR(36)  DEFAULT NULL,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_vdoc_vehicle (vehicle_id),
                FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
            )
        `);
        // Correção: uploaded_by deve casar com users.id (VARCHAR(36) UUID), não INT.
        // Sem isso o INSERT de req.user.id (UUID) estoura "Data truncated for column 'uploaded_by'" → 500.
        try {
            await db.query(`ALTER TABLE vehicle_documents
                MODIFY COLUMN uploaded_by VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL`);
        } catch (e2) {
            console.warn('⚠️ [migration] vehicle_documents.uploaded_by:', e2.message);
        }
        console.log('✅ Migração vehicle_documents concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] vehicle_documents:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Terceirizados: contrato de locação nos veículos + pagamentos
// ====================================================================
(async () => {
    const addColumn = async (sql, label) => {
        try {
            await db.query(sql);
        } catch (e) {
            if (e.code !== 'ER_DUP_FIELDNAME') console.warn(`⚠️ [migration] ${label}:`, e.message);
        }
    };
    try {
        await addColumn(`ALTER TABLE vehicles ADD COLUMN locadorId VARCHAR(36) DEFAULT NULL`, 'vehicles.locadorId');
        await addColumn(`ALTER TABLE vehicles ADD COLUMN locacaoHorasContratadas DECIMAL(12,2) DEFAULT NULL`, 'vehicles.locacaoHorasContratadas');
        await addColumn(`ALTER TABLE vehicles ADD COLUMN locacaoValorTotal DECIMAL(14,2) DEFAULT NULL`, 'vehicles.locacaoValorTotal');
        await addColumn(`ALTER TABLE vehicles ADD COLUMN locacaoVigenciaInicio DATE DEFAULT NULL`, 'vehicles.locacaoVigenciaInicio');
        await addColumn(`ALTER TABLE vehicles ADD COLUMN locacaoVigenciaFim DATE DEFAULT NULL`, 'vehicles.locacaoVigenciaFim');

        await db.query(`
            CREATE TABLE IF NOT EXISTS terceirizado_pagamentos (
                id               VARCHAR(36)  PRIMARY KEY,
                locadorId        VARCHAR(36)  NOT NULL,
                vehicleId        VARCHAR(36)  DEFAULT NULL,
                data             DATE         DEFAULT NULL,
                valor            DECIMAL(14,2) NOT NULL DEFAULT 0,
                descricao        VARCHAR(500) DEFAULT NULL,
                created_by_email VARCHAR(255) DEFAULT NULL,
                created_at       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_tercpag_locador (locadorId),
                INDEX idx_tercpag_vehicle (vehicleId)
            )
        `);
        console.log('✅ Migração terceirizado_pagamentos concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] terceirizado_pagamentos:', e.message);
    }
})();

// ── Contratos de terceirizados (1 contrato = 1 terceiro/locador + 1 obra) ─────
// Valor FECHADO. Horas executadas = acompanhamento físico (não viram débito).
// Saldo a pagar = valorTotal − diesel abatido − adiantamentos.
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS terceiro_contratos (
                id                VARCHAR(36)   PRIMARY KEY,
                numero            VARCHAR(30)   NOT NULL,
                locadorId         VARCHAR(36)   NOT NULL,
                obraId            VARCHAR(36)   NOT NULL,
                tipoMaquina       VARCHAR(120)  DEFAULT NULL,
                horasContratadas  DECIMAL(12,2) NOT NULL DEFAULT 0,
                valorHora         DECIMAL(14,2) NOT NULL DEFAULT 0,
                valorTotal        DECIMAL(14,2) NOT NULL DEFAULT 0,
                vigenciaInicio    DATE          DEFAULT NULL,
                vigenciaFim       DATE          DEFAULT NULL,
                status            VARCHAR(20)   NOT NULL DEFAULT 'ativo',
                observacoes       VARCHAR(1000) DEFAULT NULL,
                maquinas          JSON          DEFAULT NULL,
                pdfUrl            VARCHAR(500)  DEFAULT NULL,
                created_by_email  VARCHAR(255)  DEFAULT NULL,
                created_at        TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_terccontrato_numero (numero),
                INDEX idx_terccontrato_locador (locadorId),
                INDEX idx_terccontrato_obra (obraId)
            )
        `);
        // Adiantamentos passam a poder apontar para um contrato específico.
        try {
            await db.query(`ALTER TABLE terceirizado_pagamentos ADD COLUMN contratoId VARCHAR(36) DEFAULT NULL`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
        // Máquinas vinculadas ao contrato (JSON array de vehicleId). 1 máquina : 1 contrato.
        try {
            await db.query(`ALTER TABLE terceiro_contratos ADD COLUMN maquinas JSON DEFAULT NULL`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
        // Plano de trabalho estilo Obra: tipo de contrato ('horas' | 'fechado') e
        // itens contratados por subgrupo ([{ type, hours, price }]). horasContratadas
        // e valorTotal continuam sendo os AGREGADOS (soma), consumidos pelo cálculo de saldo.
        try {
            await db.query(`ALTER TABLE terceiro_contratos ADD COLUMN contractType VARCHAR(20) NOT NULL DEFAULT 'horas'`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
        try {
            await db.query(`ALTER TABLE terceiro_contratos ADD COLUMN itensContratados JSON DEFAULT NULL`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') throw err;
        }
        // Cláusulas jurídicas parametrizáveis (extraídas de contrato real de terceiro,
        // ver services/contratoPdfGenerator.js): prazos e percentuais que hoje eram
        // texto fixo ou simplesmente ausentes do PDF gerado.
        const clausulasJuridicas = [
            { column: 'prazoPagamentoDias',              def: 'INT NOT NULL DEFAULT 30' },
            { column: 'percentualJurosMora',              def: 'DECIMAL(5,2) NOT NULL DEFAULT 1.00' },
            { column: 'percentualMultaMora',              def: 'DECIMAL(5,2) NOT NULL DEFAULT 1.00' },
            { column: 'prazoSubstituicaoHoras',           def: 'INT NOT NULL DEFAULT 48' },
            { column: 'prazoInicioServicoHoras',          def: 'INT NOT NULL DEFAULT 48' },
            { column: 'percentualMultaInadimplemento',    def: 'DECIMAL(5,2) NOT NULL DEFAULT 0.50' },
            { column: 'avisoPrevioRescisaoDias',          def: 'INT NOT NULL DEFAULT 2' },
            { column: 'foroComarca',                      def: "VARCHAR(60) NOT NULL DEFAULT 'Santa Maria'" },
        ];
        for (const { column, def } of clausulasJuridicas) {
            try {
                await db.query(`ALTER TABLE terceiro_contratos ADD COLUMN ${column} ${def}`);
            } catch (err) {
                if (err.code !== 'ER_DUP_FIELDNAME') throw err;
            }
        }
        console.log('✅ Migração terceiro_contratos concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] terceiro_contratos:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Log de e-mails enviados pelo sistema (auditoria de envios)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS email_log (
                id          VARCHAR(36)  PRIMARY KEY,
                para        VARCHAR(255) NOT NULL,
                assunto     VARCHAR(255) DEFAULT NULL,
                corpo       LONGTEXT     DEFAULT NULL,
                tipo        VARCHAR(60)  DEFAULT NULL,
                status      VARCHAR(20)  NOT NULL DEFAULT 'sent',
                erro        TEXT         DEFAULT NULL,
                message_id  VARCHAR(255) DEFAULT NULL,
                enviado_por VARCHAR(36)  DEFAULT NULL,
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_email_log_created (created_at),
                INDEX idx_email_log_status  (status)
            )
        `);
        console.log('✅ Migração email_log concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] email_log:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Sugestões dos usuários (Administração → Comunicação)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS suggestions (
                id          VARCHAR(36)  PRIMARY KEY,
                user_id     VARCHAR(36)  DEFAULT NULL,
                user_nome   VARCHAR(150) DEFAULT NULL,
                texto       TEXT         NOT NULL,
                anexos      JSON         DEFAULT NULL,
                status      VARCHAR(20)  NOT NULL DEFAULT 'nova',
                created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_suggestions_status  (status),
                INDEX idx_suggestions_created (created_at)
            )
        `);
        console.log('✅ Migração suggestions concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] suggestions:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Vínculos entre veículos (cavalo↔reboque, máquina↔acessório)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS vehicle_links (
                id                VARCHAR(36) PRIMARY KEY,
                parent_vehicle_id VARCHAR(36) NOT NULL,
                child_vehicle_id  VARCHAR(36) NOT NULL,
                tipo_vinculo      VARCHAR(60) DEFAULT NULL,
                observacao        VARCHAR(255) DEFAULT NULL,
                ativo             TINYINT     NOT NULL DEFAULT 1,
                created_at        TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
                data_fim          DATETIME    DEFAULT NULL,
                INDEX idx_vlink_parent (parent_vehicle_id),
                INDEX idx_vlink_child  (child_vehicle_id)
            )
        `);
        console.log('✅ Migração vehicle_links concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] vehicle_links:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — created_at em obras (ordenação "Abertura mais recente")
// Guardada por existência da coluna: o backfill roda UMA vez só. Se rodasse
// a cada boot, corromperia o created_at de obras que ativam depois (quando o
// dataInicio real é preenchido, ele sobrescreveria a data de criação).
// ====================================================================
(async () => {
    try {
        const [col] = await db.query(
            `SELECT COUNT(*) AS c FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'obras' AND column_name = 'created_at'`
        );
        if (col[0].c > 0) return; // coluna já existe — não re-executa o backfill

        await db.query('ALTER TABLE obras ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        // Backfill único: obras com início real herdam essa data como "abertura".
        // As pré-ativas (dataInicio null) ficam com o CURRENT_TIMESTAMP do ALTER.
        await db.query('UPDATE obras SET created_at = dataInicio WHERE dataInicio IS NOT NULL');
        console.log('✅ Migração obras.created_at + backfill concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] obras.created_at:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — responsavel_email em obras (Item 4: responsável notificável)
// ====================================================================
(async () => {
    try {
        await db.query(`ALTER TABLE obras ADD COLUMN IF NOT EXISTS responsavel_email VARCHAR(255) DEFAULT NULL`);
        console.log('✅ Migração obras.responsavel_email concluída.');
    } catch (e) {
        if (e.code === 'ER_PARSE_ERROR') {
            // MySQL < 8.0.29: sem suporte a IF NOT EXISTS em ADD COLUMN
            try {
                await db.query(`ALTER TABLE obras ADD COLUMN responsavel_email VARCHAR(255) DEFAULT NULL`);
                console.log('✅ Migração obras.responsavel_email concluída (fallback).');
            } catch (e2) {
                if (e2.code !== 'ER_DUP_FIELDNAME') console.warn('⚠️ [migration] obras.responsavel_email:', e2.message);
            }
        } else if (e.code !== 'ER_DUP_FIELDNAME') {
            console.warn('⚠️ [migration] obras.responsavel_email:', e.message);
        }
    }
})();

// ====================================================================
// MIGRAÇÃO — notification_log (Item 3: histórico de notificações enviadas)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS notification_log (
                id           VARCHAR(36)  PRIMARY KEY,
                event_type   VARCHAR(100) NOT NULL,
                channel      VARCHAR(30)  NOT NULL,
                contact      VARCHAR(255) NOT NULL,
                obra_id      VARCHAR(36)  DEFAULT NULL,
                status       ENUM('sent','failed','skipped') NOT NULL DEFAULT 'sent',
                error_msg    TEXT         DEFAULT NULL,
                payload_json TEXT         DEFAULT NULL,
                created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_nlog_event   (event_type),
                INDEX idx_nlog_obra    (obra_id),
                INDEX idx_nlog_created (created_at)
            )
        `);
        console.log('✅ Migração notification_log concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] notification_log:', e.message);
    }
})();

// ====================================================================
// MIGRAÇÃO — Saldo pré-pago em postos (partner_fuel_credit_entries + VIEW)
// ====================================================================
// Modelo append-only: cada movimentação (crédito, empenho, liberação de
// empenho, baixa, ajuste) entra como uma linha. O saldo disponível por
// posto é uma VIEW que soma os tipos com o sinal correto.
//
// Convenção de sinal (somente entry_type='adjustment' usa amount com sinal):
//   credit              → +amount   (entra dinheiro)
//   reservation         → -amount   (empenho ao criar ordem)
//   reservation_release → +amount   (libera empenho ao cancelar/editar/baixar)
//   settlement          → -amount   (baixa definitiva da ordem)
//   adjustment          → amount com sinal (estorno manual)
// ====================================================================
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS partner_fuel_credit_entries (
                id          BIGINT       AUTO_INCREMENT PRIMARY KEY,
                partner_id  VARCHAR(36)  NOT NULL,
                entry_type  ENUM('credit','reservation','reservation_release','settlement','adjustment') NOT NULL,
                amount      DECIMAL(12,2) NOT NULL,
                order_id    VARCHAR(36)  DEFAULT NULL,
                obra_id     VARCHAR(36)  DEFAULT NULL,
                description VARCHAR(255) DEFAULT NULL,
                created_by  VARCHAR(64)  DEFAULT NULL,
                created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_partner_created (partner_id, created_at),
                INDEX idx_order (order_id),
                INDEX idx_type (entry_type)
            )
        `);

        await db.query(`
            CREATE OR REPLACE VIEW v_partner_fuel_balance AS
            SELECT
                partner_id,
                COALESCE(SUM(CASE WHEN entry_type='credit'              THEN amount ELSE 0 END), 0) AS total_credited,
                COALESCE(SUM(CASE WHEN entry_type='reservation'         THEN amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN entry_type='reservation_release' THEN amount ELSE 0 END), 0) AS total_reserved,
                COALESCE(SUM(CASE WHEN entry_type='settlement'          THEN amount ELSE 0 END), 0) AS total_settled,
                COALESCE(SUM(CASE WHEN entry_type='adjustment'          THEN amount ELSE 0 END), 0) AS total_adjustment,
                (
                    COALESCE(SUM(CASE WHEN entry_type='credit'              THEN amount ELSE 0 END), 0)
                  - (
                        COALESCE(SUM(CASE WHEN entry_type='reservation'         THEN amount ELSE 0 END), 0)
                      - COALESCE(SUM(CASE WHEN entry_type='reservation_release' THEN amount ELSE 0 END), 0)
                    )
                  - COALESCE(SUM(CASE WHEN entry_type='settlement'          THEN amount ELSE 0 END), 0)
                  + COALESCE(SUM(CASE WHEN entry_type='adjustment'          THEN amount ELSE 0 END), 0)
                ) AS available
            FROM partner_fuel_credit_entries
            GROUP BY partner_id
        `);
        // Se a tabela já existia com created_by INT (versão inicial), converte.
        try {
            await db.query('ALTER TABLE partner_fuel_credit_entries MODIFY COLUMN created_by VARCHAR(64) DEFAULT NULL');
        } catch (e) { /* ignora se já estiver correto */ }

        // Recria a VIEW sempre (CREATE OR REPLACE) — se a tabela já existia,
        // o CREATE TABLE IF NOT EXISTS acima não fez nada, mas precisamos
        // garantir que a view esteja atualizada.
        console.log('✅ Migração partner_fuel_credit_entries + v_partner_fuel_balance concluída.');
    } catch (e) {
        console.warn('⚠️ [migration] partner_fuel_credit_entries:', e.message);
    }
})();

const { Server } = require("socket.io");
const multer = require('multer');

// ====================================================================
// 🔧 CONFIGURAÇÃO DE CORS SEGURO (CORRIGIDO)
// ====================================================================

// Função auxiliar para limpar e validar URLs
const sanitizeUrl = (url) => {
  if (!url) return null;
  return url.trim().toLowerCase().replace(/\/$/, '');
};

// Leitura das origens permitidas do .env
const envOrigins = process.env.ALLOWED_ORIGINS || '';
const customOrigins = envOrigins
  .split(',')
  .map(sanitizeUrl)
  .filter(Boolean); // Remove strings vazias

// 🚨 CORREÇÃO: Fallback com origens padrão SEMPRE incluído
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'https://frotamak.com',
  'https://www.frotamak.com',
  'https://frotasmak-frotas-backend.oehpg2.easypanel.host',
  'https://frotasmak-front-desenvolvimento.oehpg2.easypanel.host'
];

// 🚨 CORREÇÃO: Unimos as origens padrão com as customizadas para garantir que o sistema não perca o acesso
const allowedOrigins = [...new Set([...defaultOrigins, ...customOrigins])];

console.log('✅ Origens CORS permitidas:', allowedOrigins);

// Configuração do CORS para Express
const corsOptions = {
  origin: function (origin, callback) {
    // ⚠️ IMPORTANTE: Requisições sem 'origin' header (como preflight OPTIONS) são permitidas
    if (!origin) {
      console.log('ℹ️ Requisição sem header Origin (provavelmente preflight ou mesma origem) - PERMITIDA');
      return callback(null, true);
    }

    const cleanOrigin = sanitizeUrl(origin);
    
    if (allowedOrigins.includes(cleanOrigin)) {
      callback(null, true);
    } else {
      console.warn(`❌ CORS BLOQUEADO: Origem '${origin}' (limpa: '${cleanOrigin}') não está na whitelist`);
      // 🚨 CORREÇÃO CRÍTICA: Não retornar new Error(), retornar false. 
      // Retornar um erro quebrava o preflight (OPTIONS) e causava o "TypeError: Failed to fetch".
      callback(null, false); 
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true, // Permite cookies e credenciais
  optionsSuccessStatus: 204 // 204 No Content é o padrão mais seguro para respostas OPTIONS (preflight)
};

// ====================================================================
// INICIALIZAÇÃO DO APP E MIDDLEWARES GLOBAIS
// ====================================================================
const app = express();

// ⚠️ IMPORTANTE: Aplicar CORS ANTES de qualquer outra rota!
// O middleware genérico abaixo já captura e finaliza as requisições de preflight (OPTIONS)
// sem precisarmos definir app.options('*', ...) o que estava quebrando o path-to-regexp atualizado.
app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 🚨 CORREÇÃO: Rota vazia para o favicon.ico para não poluir os logs com erro 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Middleware para logar todas as requisições (debug)
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.path} | Origin: ${req.get('origin') || 'sem origin'}`);
  next();
});

// ====================================================================
// CONFIGURAÇÃO DE UPLOAD (MULTER)
// ====================================================================
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`📁 Diretório de uploads criado: ${uploadDir}`);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const cleanOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, uniqueSuffix + '-' + cleanOriginalName);
  }
});

const fileFilterGlobal = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`❌ Tipo de arquivo não permitido: ${file.mimetype}. Apenas imagens (JPEG/PNG/WEBP) e PDFs.`), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilterGlobal,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ====================================================================
// IMPORTAÇÃO DE MIDDLEWARES E ROTAS
// ====================================================================
const authMiddleware = require('./middlewares/authMiddleware');

const authRoutes = require('./routes/authRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const obraRoutes = require('./routes/obraRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const checklistRoutes = require('./routes/checklistRoutes');
const partnerRoutes = require('./routes/partnerRoutes');
const revisionRoutes = require('./routes/revisionRoutes');
const fineRoutes = require('./routes/fineRoutes');
const refuelingRoutes = require('./routes/refuelingRoutes');
const comboioTransactionRoutes = require('./routes/comboioTransactionRoutes');
const agendaRoutes = require('./routes/agendaRoutes');
const diarioDeBordoRoutes = require('./routes/diarioDeBordoRoutes');
const orderRoutes = require('./routes/orderRoutes');
const counterRoutes = require('./routes/counterRoutes');
const inactivityAlertRoutes = require('./routes/inactivityAlertRoutes');
const registrationRequestRoutes = require('./routes/registrationRequestRoutes');
const operationalRequestRoutes = require('./routes/operationalRequestRoutes');
const adminRoutes = require('./routes/adminRoutes');
const expensesRoutes = require('./routes/expenseRoutes');
const userRoutes = require('./routes/userRoutes');
const updateRoutes = require('./routes/updateRoutes');
const tireRoutes = require('./routes/tireRoutes');
const obraSupervisorRoutes = require('./routes/obraSupervisorRoutes');
const solicitacaoRoutes = require('./routes/solicitacaoRoutes');
const billingRoutes = require('./routes/billingRoutes');
const confrontoRoutes = require('./routes/confrontoRoutes');
const analiseGerencialRoutes = require('./routes/analiseGerencialRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const washingRoutes = require('./routes/washingRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const sigasulRoutes = require('./routes/sigasulRoutes');
const vehicleTypeConfigRoutes = require('./routes/vehicleTypeConfigRoutes');
const vehicleTaxonomyRoutes = require('./routes/vehicleTaxonomyRoutes');
const partnerFuelCreditsRoutes = require('./routes/partnerFuelCreditsRoutes');
const notificationLogRoutes    = require('./routes/notificationLogRoutes');
const suggestionRoutes         = require('./routes/suggestionRoutes');
const vehicleLinkRoutes        = require('./routes/vehicleLinkRoutes');
const comboioReportRoutes      = require('./routes/comboioReportRoutes');
const terceirizadoPagamentoRoutes = require('./routes/terceirizadoPagamentoRoutes');
const terceiroContratoRoutes      = require('./routes/terceiroContratoRoutes');

// ====================================================================
// CONFIGURAÇÃO DO HTTP SERVER E SOCKET.IO
// ====================================================================
const port = process.env.PORT || 3001;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins, // Usa a mesma whitelist do Express
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true
  },
  transports: ['websocket', 'polling'] // Fallback para polling se websocket falhar
});

global.io = io;

// ====================================================================
// ROTAS ESTÁTICAS E MIDDLEWARE
// ====================================================================

// Servir arquivos estáticos (uploads)
app.use('/uploads', express.static(uploadDir, {
  maxAge: '1d', // Cache de 1 dia
  etag: false
}));

// Disponibilizar 'io' em todas as requisições
app.use((req, res, next) => {
  req.io = io;
  next();
});

// ====================================================================
// DEFINIÇÃO DAS ROTAS API
// ====================================================================
const apiRouter = express.Router();

// Health check
apiRouter.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: '🚀 API Frotas MAK está funcionando!',
    timestamp: new Date().toISOString()
  });
});

// ⚠️ Rotas Públicas (SEM autenticação)
apiRouter.use('/auth', authRoutes);
apiRouter.use('/registrationRequests', registrationRequestRoutes);
apiRouter.use('/operationalRequests', operationalRequestRoutes);

// ====================================================================
// MIDDLEWARE DE AUTENTICAÇÃO (Aplicado a partir daqui)
// ====================================================================
apiRouter.use(authMiddleware);

// ✅ Rota de Upload Genérica (Protegida)
apiRouter.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'Nenhum arquivo foi recebido.',
        hint: 'Verifique se o arquivo está sendo enviado no campo "file" do formulário.'
      });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    res.status(200).json({
      message: '✅ Upload realizado com sucesso.',
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size
    });
  } catch (error) {
    console.error('❌ Erro no upload genérico:', error);
    res.status(500).json({ 
      error: 'Falha interna ao processar o upload do arquivo.',
      details: error.message
    });
  }
});

// ✅ Contatos internos ativos (leitura) — usado no seletor de Responsável da Obra.
// A gestão completa (CRUD) continua restrita a admin em /admin/internal-contacts.
apiRouter.get('/internal-contacts', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, nome, cargo, setor, whatsapp, email
             FROM internal_contacts
             WHERE ativo = 1
             ORDER BY nome ASC`
        );
        res.json(rows);
    } catch (error) {
        console.error('❌ Erro ao listar contatos internos:', error);
        res.status(500).json({ error: 'Erro ao listar contatos internos.' });
    }
});

// ✅ Rotas Protegidas
apiRouter.use('/vehicles', vehicleRoutes);
apiRouter.use('/obras', obraRoutes);
apiRouter.use('/employees', employeeRoutes);
apiRouter.use('/checklists', checklistRoutes);
apiRouter.use('/partners', partnerRoutes);
apiRouter.use('/revisions', revisionRoutes);
apiRouter.use('/fines', fineRoutes);
apiRouter.use('/refuelings', refuelingRoutes);
apiRouter.use('/comboioTransactions', comboioTransactionRoutes);
apiRouter.use('/diarioDeBordo', diarioDeBordoRoutes);
apiRouter.use('/orders', orderRoutes);
apiRouter.use('/counters', counterRoutes);
apiRouter.use('/inactivityAlerts', inactivityAlertRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/expenses', expensesRoutes);
apiRouter.use('/users', userRoutes);
apiRouter.use('/updates', updateRoutes);
apiRouter.use('/tires', tireRoutes);
apiRouter.use('/supervisor', obraSupervisorRoutes);
apiRouter.use('/billing', billingRoutes);
apiRouter.use('/confronto', confrontoRoutes);
apiRouter.use('/analise-gerencial', analiseGerencialRoutes);
apiRouter.use('/dashboard', dashboardRoutes);
apiRouter.use('/solicitacoes', solicitacaoRoutes);
apiRouter.use('/maintenances', maintenanceRoutes);
apiRouter.use('/washings', washingRoutes);
apiRouter.use('/agenda', agendaRoutes);
apiRouter.use('/inventory', inventoryRoutes);
apiRouter.use('/whatsapp', whatsappRoutes);
apiRouter.use('/sigasul', sigasulRoutes);
apiRouter.use('/vehicle-type-configs', vehicleTypeConfigRoutes);
apiRouter.use('/vehicle-taxonomy', vehicleTaxonomyRoutes);
apiRouter.use('/partnerFuelCredits', partnerFuelCreditsRoutes);
apiRouter.use('/notification-log', notificationLogRoutes);
apiRouter.use('/suggestions', suggestionRoutes);
apiRouter.use('/vehicle-links', vehicleLinkRoutes);
apiRouter.use('/comboio-report', comboioReportRoutes);
apiRouter.use('/terceirizadoPagamentos', terceirizadoPagamentoRoutes);
apiRouter.use('/terceiroContratos', terceiroContratoRoutes);

// ─── WEBHOOK PÚBLICO DO CHATBOT ─────────────────────────────────────────────
// Deve ficar ANTES de app.use('/api', apiRouter) para não passar pelo authMiddleware
app.post('/api/whatsapp/webhook', require('./controllers/chatbotController').receberMensagem);

// Registrar todas as rotas sob /api
app.use('/api', apiRouter);

// ====================================================================
// TRATAMENTO DE ERROS CORS (Middleware de tratamento no final)
// ====================================================================
app.use((err, req, res, next) => {
  if (err.message && err.message.includes('CORS')) {
    console.error(`🚨 ERRO CORS: ${err.message}`);
    return res.status(403).json({
      error: 'CORS: Acesso bloqueado',
      message: err.message,
      origin: req.get('origin'),
      allowedOrigins: allowedOrigins
    });
  }
  
  if (err.message && err.message.includes('arquivo')) {
    console.error(`🚨 ERRO DE UPLOAD: ${err.message}`);
    return res.status(400).json({
      error: 'Erro ao processar arquivo',
      message: err.message
    });
  }

  // Erro genérico
  console.error('🚨 ERRO SERVIDOR:', err);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Entre em contato com o suporte'
  });
});

// ====================================================================
// SOCKET.IO - EVENTOS E CONEXÕES
// ====================================================================
io.on('connection', (socket) => {
  console.log(`🔌 Cliente Socket.io conectado: ${socket.id} | IP: ${socket.handshake.address}`);

  socket.on('disconnect', () => {
    console.log(`❌ Cliente Socket.io desconectado: ${socket.id}`);
  });

  // Evento de teste (opcional, para debug)
  socket.on('ping', (callback) => {
    console.log(`📡 Ping recebido de ${socket.id}`);
    callback({ status: 'pong', timestamp: new Date().toISOString() });
  });
});

// ====================================================================
// INICIALIZAÇÃO DO BANCO DE DADOS
// ====================================================================
db.getConnection()
  .then(connection => {
    console.log('✅ Conexão com o banco de dados estabelecida com sucesso!');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Erro ao conectar ao banco de dados:', err.message);
    console.error('   Stack:', err.stack);
    // NÃO interrompe o servidor, apenas loga o erro
  });

// ====================================================================
// IMPORTAR E INICIAR SERVIÇOS EM SEGUNDO PLANO
// ====================================================================
try {
  require('./services/cronService');
  console.log('✅ Serviço CRON iniciado com sucesso.');
} catch (error) {
  console.error('⚠️ Erro ao iniciar serviço CRON:', error.message);
}


// ====================================================================
// INICIAR O SERVIDOR
// ====================================================================
server.listen(port, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log(`║  🚀 SERVIDOR FROTAS MAK INICIADO COM SUCESSO!           ║`);
  console.log(`║  🌐 Porta: ${port}                                         ║`);
  console.log(`║  📡 HTTP + WebSocket (Socket.io) ATIVO                  ║`);
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Upload Genérico:     POST /api/upload               ║`);
  console.log(`║  ✅ Autenticação:        POST /api/auth/login           ║`);
  console.log(`║  ✅ Veículos:            GET  /api/vehicles             ║`);
  console.log(`║  ✅ Funcionários:        GET  /api/employees            ║`);
  console.log(`║  ✅ Agenda:              GET  /api/agenda               ║`);
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  🔐 Origens CORS Permitidas:                           ║`);
  allowedOrigins.forEach(origin => {
    console.log(`║     • ${origin.padEnd(50)} ║`);
  });
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Rejeição não tratada em Promise:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Exceção não capturada:', error);
  process.exit(1);
});

module.exports = { app, server, io };