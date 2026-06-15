-- ============================================================
-- Corrige tipo de employee_id em analise_dia_maquina.
-- O schema original criou como INT, mas employees.id é VARCHAR.
-- (Também ajusta justificado_por pela mesma razão se necessário.)
-- ============================================================

ALTER TABLE analise_dia_maquina
    MODIFY COLUMN employee_id VARCHAR(255) NULL,
    MODIFY COLUMN justificado_por VARCHAR(255) NULL;
