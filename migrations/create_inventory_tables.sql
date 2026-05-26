-- ============================================================================
-- migrations/create_inventory_tables.sql
-- Módulo de Estoque/Almoxarifado — Execute uma vez no banco de dados
-- ============================================================================

-- Categorias de itens
CREATE TABLE IF NOT EXISTS inventory_categories (
    id          VARCHAR(36)  NOT NULL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon        VARCHAR(50),
    color       VARCHAR(20)  DEFAULT 'gray-500',
    isActive    TINYINT(1)   NOT NULL DEFAULT 1,
    createdAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Itens de estoque
CREATE TABLE IF NOT EXISTS inventory_items (
    id            VARCHAR(36)    NOT NULL PRIMARY KEY,
    sku           VARCHAR(50)    NOT NULL UNIQUE,
    eaN           VARCHAR(20),
    internalCode  VARCHAR(50),
    name          VARCHAR(200)   NOT NULL,
    description   TEXT,
    categoryId    VARCHAR(36),
    quantity      INT            NOT NULL DEFAULT 0,
    minQuantity   INT            NOT NULL DEFAULT 5,
    maxQuantity   INT,
    unitPrice     DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
    lastCostPrice DECIMAL(10,2),
    unit          VARCHAR(20)    NOT NULL DEFAULT 'unidade',
    isActive      TINYINT(1)     NOT NULL DEFAULT 1,
    createdBy     VARCHAR(100),
    updatedBy     VARCHAR(100),
    createdAt     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (categoryId) REFERENCES inventory_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Movimentações de estoque
CREATE TABLE IF NOT EXISTS inventory_movements (
    id         VARCHAR(36)   NOT NULL PRIMARY KEY,
    itemId     VARCHAR(36)   NOT NULL,
    type       ENUM('entrada','saida','ajuste','perda','devolucao') NOT NULL,
    quantity   INT           NOT NULL,
    reason     VARCHAR(300),
    reference  VARCHAR(100),
    unitPrice  DECIMAL(10,2),
    createdBy  VARCHAR(100),
    createdAt  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (itemId) REFERENCES inventory_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Referências/equivalências entre itens
CREATE TABLE IF NOT EXISTS inventory_item_references (
    id              VARCHAR(36) NOT NULL PRIMARY KEY,
    itemId          VARCHAR(36) NOT NULL,
    referenceItemId VARCHAR(36) NOT NULL,
    type            ENUM('equivalencia','upgrade','substituto','compativel') NOT NULL DEFAULT 'equivalencia',
    notes           VARCHAR(300),
    priority        INT         NOT NULL DEFAULT 0,
    isActive        TINYINT(1)  NOT NULL DEFAULT 1,
    createdAt       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (itemId)          REFERENCES inventory_items(id) ON DELETE CASCADE,
    FOREIGN KEY (referenceItemId) REFERENCES inventory_items(id) ON DELETE CASCADE,
    UNIQUE KEY uq_item_reference (itemId, referenceItemId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alertas automáticos de estoque
CREATE TABLE IF NOT EXISTS inventory_alerts (
    id              VARCHAR(36)  NOT NULL PRIMARY KEY,
    itemId          VARCHAR(36),
    type            VARCHAR(50)  NOT NULL,
    severity        ENUM('info','warning','error','critical') NOT NULL DEFAULT 'warning',
    title           VARCHAR(200) NOT NULL,
    message         TEXT,
    suggestedAction TEXT,
    isActive        TINYINT(1)   NOT NULL DEFAULT 1,
    acknowledgedAt  DATETIME,
    acknowledgedBy  VARCHAR(100),
    createdAt       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (itemId) REFERENCES inventory_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;