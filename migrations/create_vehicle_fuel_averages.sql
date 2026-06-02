-- Fase 1.2 — Tabela de médias de consumo de combustível por veículo
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
  UNIQUE KEY uq_vehicle  (vehicle_id),
  INDEX idx_tipo         (vehicle_tipo),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);
