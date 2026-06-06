-- =============================================================================
-- Migration 003: Coluna pricePerLiterArla em refuelings
-- Permite registrar o preço unitário do Arla 32 separadamente do combustível
-- principal, refletindo no cálculo do valor total da nota.
-- Execute uma única vez. Se já executado, falhará com "Duplicate column name".
-- =============================================================================

ALTER TABLE `refuelings`
    ADD COLUMN `pricePerLiterArla` DECIMAL(10,3) DEFAULT NULL AFTER `pricePerLiter`;
