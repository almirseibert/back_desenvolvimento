-- Adicionar coluna authNumber à tabela comboio_transactions
-- Execute isto no seu banco de dados

ALTER TABLE comboio_transactions ADD COLUMN authNumber INT UNSIGNED DEFAULT NULL AFTER id;

-- Criar índice para melhor performance
ALTER TABLE comboio_transactions ADD INDEX idx_authNumber (authNumber);

-- Verificar se a coluna foi adicionada
SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'comboio_transactions' AND COLUMN_NAME = 'authNumber';