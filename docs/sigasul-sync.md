# Siga Sul — Rotinas de Sincronização e Armazenamento

## Visão Geral

Os dados do Siga Sul são armazenados localmente no banco MySQL para eliminar chamadas repetidas à API externa. A estratégia é:

- **Dias passados** → sempre servidos do banco (rápido, offline-safe)
- **Hoje** → sempre consultado na API ao vivo (dados ainda não sincronizados)
- **Posições em tempo real** → sempre da API (rastreamento ao vivo)

---

## Tabelas

### `sigasul_sync_state`
Controle de estado da sincronização. Sempre contém exatamente **1 linha** (id = 1).

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | INT (PK) | Sempre 1 |
| `last_evento_controle_id` | BIGINT | Cursor incremental de jornadas (último id processado) |
| `last_positions_sync_date` | DATE | Última data de GPS sincronizada |
| `last_summary_sync_date` | DATE | Última data de resumo diário sincronizada |
| `updated_at` | DATETIME | Atualizado a cada sync |

---

### `sigasul_positions`
Histórico de posições GPS de todos os veículos. Retenção de **90 dias** (registros mais antigos são deletados automaticamente).

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `pos_id_ref` | BIGINT (PK) | ID único da posição vindo da API |
| `pos_data_hora_receb` | DATETIME | Data/hora do registro GPS |
| `pos_placa` | VARCHAR(20) | Placa do veículo |
| `pos_latitude` | DECIMAL(10,7) | Latitude |
| `pos_longitude` | DECIMAL(10,7) | Longitude |
| `pos_ignicao` | TINYINT(1) | Ignição ligada (1) ou desligada (0) |
| `pos_velocidade` | INT | Velocidade em km/h |
| `pos_odometro_calc` | INT | Odômetro calculado |
| `pos_equip_id` | VARCHAR(50) | ID do equipamento de rastreamento |
| `synced_at` | DATETIME | Momento em que foi inserido no banco |

**Índices:** `(pos_placa, pos_data_hora_receb)` e `(pos_data_hora_receb)`

---

### `sigasul_journeys`
Registro de jornadas dos motoristas.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id_jornada` | BIGINT (PK) | ID da jornada vindo da API |
| `id_motorista` | INT | ID do motorista |
| `nome_motorista` | VARCHAR(200) | Nome do motorista |
| `cartao_motorista` | VARCHAR(50) | Número do cartão do motorista |
| `id_cliente` | INT | ID do cliente/empresa |
| `nome_cliente` | VARCHAR(200) | Nome do cliente |
| `data_inicial` | DATETIME | Início da jornada |
| `data_final` | DATETIME | Fim da jornada (NULL se em andamento) |
| `duracao_segundos` | INT | Duração total em segundos |
| `synced_at` | DATETIME | Momento em que foi inserido no banco |

**Índices:** `(data_inicial)`

---

### `sigasul_journey_events`
Eventos individuais dentro de cada jornada (paradas, partidas, etc.).

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id_evento` | BIGINT (PK) | ID do evento |
| `id_evento_controle` | BIGINT (UNIQUE) | Cursor incremental — usado para buscar só eventos novos |
| `id_jornada` | BIGINT (FK) | Jornada à qual o evento pertence |
| `id_tipo_evento` | INT | Código do tipo de evento |
| `nome_tipo_evento` | VARCHAR(100) | Descrição do tipo (ex: "Início de Jornada") |
| `placa` | VARCHAR(20) | Placa do veículo no evento |
| `latitude` | DECIMAL(10,7) | Latitude do evento |
| `longitude` | DECIMAL(10,7) | Longitude do evento |
| `data_inicio` | DATETIME | Início do evento |
| `data_fim` | DATETIME | Fim do evento |
| `synced_at` | DATETIME | Momento em que foi inserido no banco |

**Índices:** `(id_jornada)`, `(placa, data_inicio)`, `(id_evento_controle)`

---

### `sigasul_daily_summary`
Resumo diário agregado por placa — horas com ignição ligada e quilometragem rodada. É a tabela mais consultada para relatórios de produtividade.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | INT (PK, auto) | — |
| `placa` | VARCHAR(20) | Placa do veículo |
| `data` | DATE | Data do resumo |
| `total_horas_ligado` | DECIMAL(8,4) | Total de horas com motor ligado no dia |
| `total_km` | DECIMAL(10,2) | Total de quilômetros rodados no dia |
| `num_eventos` | INT | Quantidade de eventos no dia |
| `synced_at` | DATETIME | Atualizado a cada re-sync |

**Índices:** `UNIQUE (placa, data)`, `(data)`

---

## Rotinas de Sincronização

### Rotina 1 — Jornadas (Incremental)
| Item | Detalhe |
|------|---------|
| **Frequência** | A cada **1 minuto** |
| **Horário** | Contínuo (junto com o cron principal do sistema) |
| **Função** | `syncJourneyEvents()` em `services/sigasulSyncService.js` |
| **Tabelas escritas** | `sigasul_journeys`, `sigasul_journey_events`, `sigasul_sync_state` |
| **Endpoint Siga Sul** | `GET /api/v2/jornadas/events/control/{last_id}` |

**Como funciona:** Busca apenas os eventos com `id_evento_controle` maior que o último cursor salvo. A cada execução, avança o cursor em `sigasul_sync_state.last_evento_controle_id`. Nunca re-processa eventos antigos.

**Onde é usado:** Endpoint `GET /api/sigasul/journeys` — exibe jornadas dos últimos 7 dias + jornadas em aberto (sem `data_final`).

---

### Rotina 2 — Posições GPS (Diária)
| Item | Detalhe |
|------|---------|
| **Frequência** | **1x por dia** |
| **Horário** | **02:05 (GMT-3)** — cron `5 5 * * *` UTC |
| **Função** | `syncPositions()` em `services/sigasulSyncService.js` |
| **Tabelas escritas** | `sigasul_positions`, `sigasul_sync_state` |
| **Endpoint Siga Sul** | `GET /api/v1/positions/data/{from}/{to}` |

**Como funciona:** Sincroniza todas as posições do dia **anterior** em bulk (lotes de 500 registros). Verifica `last_positions_sync_date` para não re-sincronizar o mesmo dia. Ao final, deleta registros com mais de 90 dias.

**Onde é usado:** Endpoints `GET /api/sigasul/positions/period` e `GET /api/sigasul/positions/vehicle/:plate` — retornam do banco para datas passadas; chamam a API para o dia atual.

---

### Rotina 3 — Resumo Diário (Diária)
| Item | Detalhe |
|------|---------|
| **Frequência** | **1x por dia** |
| **Horário** | **03:00 UTC** (00:00 GMT-3) — cron `0 3 * * *` |
| **Função** | `syncDailySummary()` em `services/sigasulSyncService.js` |
| **Tabelas escritas** | `sigasul_daily_summary`, `sigasul_sync_state` |
| **Endpoint Siga Sul** | `GET /api/jornadas/simplificada/{from}/{to}` |

**Como funciona:** Busca as jornadas simplificadas do dia anterior, agrega `tempoLigado` e `distancia` por placa, e salva (ou atualiza via `ON DUPLICATE KEY`) em `sigasul_daily_summary`. Verifica `last_summary_sync_date` para não re-processar.

**Onde é usado:** Endpoints `GET /api/sigasul/journeys/simplified` e `GET /api/sigasul/journeys/aggregate` — para ranges históricos, a query é um simples `SUM GROUP BY placa` na tabela, sem nenhuma chamada à API externa.

---

## Mapa de Endpoints × Fonte de Dados

| Endpoint | Histórico (dias passados) | Hoje (ao vivo) |
|----------|--------------------------|----------------|
| `GET /positions` | — | API sempre (tempo real) |
| `GET /positions/period` | `sigasul_positions` | API |
| `GET /positions/vehicle/:plate` | `sigasul_positions` (filtrado por placa) | API |
| `GET /journeys` | `sigasul_journeys` + `sigasul_journey_events` | Banco (sync 1 min) |
| `GET /journeys/simplified` | `sigasul_daily_summary` | API |
| `GET /journeys/aggregate` | `sigasul_daily_summary` (SUM por placa) | API (janelas de 24h) |

---

## Diagrama de Fluxo

```
Siga Sul API
     │
     ├─ /api/v2/jornadas/events/control/{id}  ──── [1 min] ────► sigasul_journeys
     │                                                             sigasul_journey_events
     │
     ├─ /api/v1/positions/data/{from}/{to}    ──── [02:05] ───► sigasul_positions
     │                                                             (retenção 90 dias)
     │
     └─ /api/jornadas/simplificada/{from}/{to} ─── [03:00] ───► sigasul_daily_summary


Backend (sigasulController.js)
     │
     ├─ Requisição para datas passadas ────────────────────────► Lê do banco MySQL
     │
     └─ Requisição que inclui hoje ────────────────────────────► Banco + API ao vivo
```
