-- =============================================================================
-- Migration 001: Índices de performance
-- Gerado com base na estrutura real do banco (db-teste.sql, MySQL 9.7.0)
-- Execute uma única vez. Se já executado, os comandos abaixo falharão com
-- "Duplicate key name" — isso é esperado e inofensivo.
-- =============================================================================
-- OBS: orders.date já existe na tabela — não precisa de ADD COLUMN.
-- =============================================================================

-- whatsapp_logs — ORDER BY data_envio DESC LIMIT 50 (sem índice atualmente)
ALTER TABLE `whatsapp_logs`
    ADD INDEX `idx_data_envio` (`data_envio`);

-- user_agenda — cron de minutos (filtro is_completed + event_datetime)
-- O índice (user_id, event_datetime) já existe; adiciona o composto para o cron
ALTER TABLE `user_agenda`
    ADD INDEX `idx_completed_datetime` (`is_completed`, `event_datetime`);

-- comboio_transactions — filtros por data (sem índice de data atualmente)
ALTER TABLE `comboio_transactions`
    ADD INDEX `idx_date` (`date`);

-- vehicle_history — filtro startDate (vehicleId já tem índice; adiciona composto)
ALTER TABLE `vehicle_history`
    ADD INDEX `idx_vehicleId_startDate` (`vehicleId`, `startDate`);

-- tire_transactions — filtro por pneu+data (tireId já tem índice; adiciona composto)
ALTER TABLE `tire_transactions`
    ADD INDEX `idx_tireId_date` (`tireId`, `date`);

-- diario_de_bordo — filtro endTime (employeeId já tem índice)
ALTER TABLE `diario_de_bordo`
    ADD INDEX `idx_employeeId_endTime` (`employeeId`, `endTime`);
