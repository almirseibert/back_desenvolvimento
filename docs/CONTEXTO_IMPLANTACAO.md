# CONTEXTO DE IMPLANTAÇÃO — SISTEMA MAK FROTAS
*Estado consolidado pós-implantação completa (Fases 0 → 4).*
*Use este arquivo como referência. As fases abaixo já estão em produção — só revise antes de mudar.*

---

## STACK E ESTRUTURA

```
frotamak_desenvolvimento/
├── back_desenvolvimento/    Node.js + Express 5, MySQL2, Socket.io, JWT, nodemailer, whatsapp-web.js
├── front_desenvolvimento/   React 18 + CRA, Tailwind CSS 3, Lucide React, jsPDF, Socket.io-client
└── server_desenvolvimento/  frotasmak_mysql.sql (schema completo)
```

**Portas**: backend 3001 · frontend 3000 · MySQL banco `frotasmak`
**Hospedagem**: Easypanel (front: `frotasmak-front-desenvolvimento.oehpg2.easypanel.host`)
**Repositórios git**:
- `back_desenvolvimento` → `github.com/almirseibert/back_desenvolvimento` (branch `main`)
- `front_desenvolvimento` → `github.com/almirseibert/front_desenvolvimento` (branch `main`)
- Deploy: push em `main` → Easypanel rebuilda automaticamente.

---

## ARQUIVOS-CHAVE DO BACKEND

- `server.js` — Express, CORS, Socket.io, todas as migrações automáticas no boot
- `database.js` — pool MySQL (timezone GMT-3 aplicado — Fase 0.1)
- `middlewares/authMiddleware.js` — JWT + verificação em tempo real
- `utils/vehicleRules.js` — cópia das regras do frontend (manter em sincronia)
- `utils/updateVehicleReading.js` — atualização unificada de leituras (Fase 1.1)
- `utils/recalcFuelAverage.js` — recálculo de médias de combustível (Fase 1.2)
- `utils/comboioPeriodo.js` — gestão de períodos por obra do comboio (Fase 2.6)
- `utils/permissions.js` — matriz de roles e permissões (Fase 0.2)
- `services/cronService.js` — jobs agendados
- `services/whatsappService.js` — envio WhatsApp via microserviço Evolution
- `services/emailService.js` — envio e-mail via nodemailer (config em `admin_settings`)
- `services/orderNotifier.js` — envio de ordens para postos (Fase 3.3)
- `services/notificationDispatcher.js` — **dispatcher central de notificações** (Fase 3.2)
- `routes/` — 29 arquivos
- `controllers/` — 28 controllers

## ARQUIVOS-CHAVE DO FRONTEND

- `App.js` — roteamento por `currentPage`, lazy loading, modais globais
- `contexts/AuthContext.js` — JWT, roles, permissões
- `contexts/DataContext.js` — lazy loading + cache + invalidação por Socket.io
- `services/apiClient.js` — wrapper fetch com todos os endpoints
- `utils/vehicleRules.js` — fonte de verdade das regras (sub-tipos incluídos)
- `utils/vehicleAlerts.js` — processamento O(V+R+F) de alertas
- `components/Sidebar.js` — navegação com controle de role
- `pages/` — 25+ páginas
- `components/admin/` — abas da Admin
- `components/modals/` — 25+ modais

---

## ROLES E PERMISSÕES (Fase 0.2)

Roles suportados: `admin`, `gerencia`, `rh`, `faturamento`, `abastecimento`, `oficina`, `editor`, `operador`, `viewer`.

Definidos em `back_desenvolvimento/utils/permissions.js`:
- `ROLE_PAGE_ACCESS` — quais páginas cada role enxerga
- `VEHICLE_ACTION_BUTTONS` — botões visíveis na página Veículos
- `ROLES_NO_DELETE` — roles que não podem excluir
- `ROLES_NO_PASSWORD_RELEASE` — roles que não podem liberar abastecimento por senha

Coluna `users.page_permissions` (JSON) permite override por usuário.

---

## REGRAS DE NEGÓCIO CONSOLIDADAS

### Odômetro vs Horímetro (`vehicleRules.js`)
- **Leves** (Automóvel, Camionete, Utilitários, Moto) → Odômetro (Km)
- **Caminhões de Trecho** (Prancha, Semirreboques) → Odômetro (Km)
- **Demais** (Caminhões, Máquinas Pesadas) → Horímetro (Hr)

### Sub-tipos (Fase 0.4)
Coluna `vehicles.sub_tipo`. Tipos com sub-tipos:
- Caçamba (7m³, 10m³, 12m³, 14m³, 16m³, 20m³)
- Escavadeira (13T, 15T, 23T, 26T, 35T, 36T, + Rompedor, Longo Alcance)
- Pá Carregadeira (11T, 20T)
- Trator Esteira (21T, 36T)

### Travas de leitura (`checkReadingConsistency`)
- Regressão → `bloqueio` (override por senha admin)
- Salto > 1.000 Km → `bloqueio`
- Salto > 50 Hr → `bloqueio`

### Atualização unificada de leituras (Fase 1.1)
`utils/updateVehicleReading.js` é chamado em:
- `refuelingController` ao concluir ordem
- `comboioTransactionController` ao registrar saída para máquina
- `vehicleController` na edição manual
- `obraController` ao editar `odometroEntrada/Saida` e `horimetroEntrada/Saida`

Só atualiza para cima (`newVal > currentVal`), nunca regride.

### Sistema de alertas
- `type: 'error'` → vermelho (vencido)
- `type: 'warning'` → amarelo (≤30 dias)
- Categorias: `manutencao`, `documento`, `bloqueio`

### Autenticação
- JWT 24h em `localStorage.authToken`
- `authMiddleware.js` busca dados frescos do DB a cada requisição
- `req.user`: `id`, `email`, `role`, `user_type`, `canAccessRefueling`, `bloqueado_abastecimento`

### DataContext (lazy loading)
- **Bootstrap**: `vehicles`, `obras`, `employees`, `partners`
- **Lazy**: `revisions`, `expenses`, `refuelings`, `comboioTransactions`, `fines`, `diarioDeBordoLogs`, `dailyWorkLogs`, `orders`
- Socket.io `server:sync` invalida cache pelo target name

---

## FASE 0 — FUNDAÇÃO ✅

### 0.1 Timezone GMT-3 ✅
`database.js` configurado com `timezone: '-03:00'` no pool MySQL.

### 0.2 Sistema de Permissões Granular ✅
- Migração `users.page_permissions` (JSON)
- `back_desenvolvimento/utils/permissions.js` com a matriz completa
- `AuthContext.js` expõe `roleNormalized` para componentes
- `Sidebar.js` filtra grupos pelo role

### 0.3 Obra vs Centro de Custo ✅
- Migração `obras.tipo_registro` ENUM('obra','centro_custo')
- Modal de obra com toggle
- Filtros e relatórios excluem centros de custo quando apropriado

### 0.4 Sub-tipos de Veículos ✅
- Migração `vehicles.sub_tipo` (VARCHAR 100)
- `vehicleSubTypes` em ambos `vehicleRules.js`
- Modal de veículo com select condicional

---

## FASE 1 — INFRAESTRUTURA DE DADOS ✅

### 1.1 Base Unificada de Leituras ✅
`utils/updateVehicleReading.js` integrado em refueling, comboio, vehicle, obra controllers. Após cada update emite `io.emit('server:sync', { target: 'vehicles' })`.

### 1.2 Médias de Combustível ✅
- Tabela `vehicle_fuel_averages` (criada via migração)
- `utils/recalcFuelAverage.js` faz UPSERT a cada conclusão de ordem
- Calcula `avg_last_1`, `avg_last_2`, `avg_last_3`, `avg_by_tipo`, `avg_by_subtipo`

### 1.3 Campos Adicionais em Obras ✅
- Migrações `obras.orgao_contratante` (VARCHAR 50) e `obras.regiao` (ENUM 'Lajeado','Santa Maria')
- Valores válidos para `orgao_contratante`: ALUGUEL, DOAÇÃO, INCRA, MUNICÍPIO, PARTICULAR, SEAPI, SEDUR
- Modal de obra, listagem `[ÓRGÃO] Nome` e filtro de região implementados

---

## FASE 2 — MÓDULOS INDIVIDUAIS ✅

### 2.1 Dashboard ✅
- Card "Obras Ativas" filtra `tipo_registro = 'obra'`
- Card "Total Frota" exclui `Inativo`, `Sucata` e `is_terceiro = 1` (migração `vehicles.is_terceiro` aplicada)
- Layout profissional reformulado
- Alertas de CNH/documento/revisão são clicáveis e redirecionam

### 2.2 Obras ✅
- Funcionários no modal: só `status = 'Ativo'`
- Profissão exibida ao lado do nome (`Nome — Função`)
- Card com borda amarela quando campos obrigatórios faltam
- Prefixo `[ÓRGÃO]` antes do nome
- Filtro Lajeado/Santa Maria no header
- Edição de leituras chama `updateVehicleReading`
- Listas ordenadas alfabeticamente
- Permissões por role aplicadas

### 2.3 Veículos ✅
- Layout dos cards mais compacto
- Campo `sub_tipo` condicional no modal
- Botões filtrados por `VEHICLE_ACTION_BUTTONS`
- Confirmação de abastecimento atualiza leituras via Fase 1.1

### 2.4 Alertas — Toxicológico + Fix Duplicatas ✅
- Migração `employees.data_vencimento_toxicologico` (DATE)
- Campo no modal de funcionários
- Toxicológico no grupo de alertas (CNH-like: error/warning)
- Bug de duplicação no relatório de alertas corrigido

### 2.5 Abastecimento ✅
- Filtro de postos `status != 'Bloqueado'`
- Listagem só de parceiros do tipo posto
- Email de resumo inclui odômetro/horímetro atual
- Liberação por senha substituída por aviso → admin libera na interface

### 2.6 Comboio — Reestruturação ✅
**Migrações**:
- `comboio_transactions.obra_periodo_id` (VARCHAR 36)
- Tabela `comboio_periodos_obra` (id, comboio_id, obra_id, data_inicio, data_fim, ativo)

**Funcionalidades**:
- Histórico por período/obra (mudança de obra fecha período anterior e abre novo)
- Entrada gera Ordem + envio ao posto (via `orderNotifier`)
- Distribuição para máquina insere em `refuelings` para alimentar médias
- Comboio-espelho em `partners` (criado/sincronizado automaticamente — `utils/ensureComboioPartner.js`)
- Painel UX: saldo, última entrada, consumo por máquina, **filtro "Obras atendidas"** (dropdown com obras + litros agregados)
- Backfill na inicialização do server.js para comboios já alocados

**Aba Admin → Comboios**: botão "Histórico por obra" expansível com badge ATIVO e totais por período (entrada/saída/drenagem em litros + nº de transações).

### 2.7 Ordens C/S ✅
- "Excluir Ordem" só para admin e gerencia
- Layout reformulado
- Bug de botões ocultos em 1080p corrigido

### 2.8 Faturamento ✅
- Queries filtram `tipo_registro = 'obra'`

### 2.9 Postos Parceiros ✅
- Migrações `partners.envia_por_whatsapp` e `partners.envia_por_email` (TINYINT)
- Checkboxes independentes no modal de Posto (`PartnersPage.js`)

### 2.10 Pneus e Manutenção ✅
- Cálculo de desgaste e revisão lê de `vehicles.odometro` / `vehicles.horimetro`

---

## FASE 3 — NOTIFICAÇÕES AUTOMATIZADAS ✅

### 3.1 Tabela e Tela de Configuração ✅
**Migração**: `notification_targets` (id, event_type, channel, target_type, target_value, label, active, created_at + 3 índices)

**Endpoints (`adminOnly`)**:
- `GET    /admin/notification-targets[?event_type=…]`
- `POST   /admin/notification-targets`
- `PUT    /admin/notification-targets/:id`
- `DELETE /admin/notification-targets/:id`

**`apiClient`**: `adminListNotificationTargets`, `adminCreateNotificationTarget`, `adminUpdateNotificationTarget`, `adminDeleteNotificationTarget`

**Aba "Notificações"** em `AdminPage.js` (`components/admin/NotificacoesAdminTab.js`):
- 12 eventos catalogados, filtros por evento/canal
- Modal de criação/edição
- Tipos de destino: `role`, `user`, `employee`, `phone`, `email_address`
- Toggle ativo, exclusão, agrupamento por evento

### 3.2 CronService usando dispatcher ✅
**`services/notificationDispatcher.js`** (novo):
- `dispatch(eventType, payload, opts)` e `dispatchAsync(...)` (fire-and-forget)
- Lê `notification_targets WHERE event_type = ? AND active = 1`
- Resolve `target_type`:
  - `phone` / `email_address` → direto
  - `employee` → busca `contato`/`email` em `employees`
  - `user` → busca `email` em `users`
  - `role` → busca todos `users` ativos com o role
- Templates internos para os 12 eventos
- Deduplica destinos repetidos
- Envia via `whatsappService.enviarMensagem` ou `emailService.sendEmail`

**Eventos integrados ao `cronService.js`** (rotina diária, GMT-3 8h00 padrão):
| Evento | Trigger |
|---|---|
| `cnh_vencendo` | 30 dias antes do vencimento |
| `cnh_vencida` | No dia do vencimento |
| `toxicologico_vencendo` | 30 dias antes |
| `funcionario_retornou_ferias` | No dia que retorna de férias |
| `revisao_veiculo_leve` | Cron diário (uso de Odômetro) |
| `revisao_veiculo_pesado` | Cron diário (uso de Horímetro) |
| `documento_veiculo_vencido` | CRLV ou Seguro vencendo hoje |

**Eventos disparados por controllers**:
| Evento | Origem |
|---|---|
| `obra_criada` | `obraController.createObra` |
| `obra_progresso` | `obraController.updateObra` quando %  cruza 30/50/70 (defensivo: só se a coluna existir) |
| `multa_lancada` | `fineController.createFine` |
| `ordem_gerada` | `orderController.createOrder` |

**Pendente (sem dispositivo de origem disponível)**:
- `combustivel_obra_20pct`: tabela `obras` ainda não tem coluna de orçamento de combustível; basta plugar `dispatchAsync('combustivel_obra_20pct', ...)` em `expenseController` quando o campo existir.

### 3.3 Envio Automático de Ordens para Postos ✅
`services/orderNotifier.js`:
- Respeita `partners.envia_por_whatsapp` e `partners.envia_por_email`
- Usado por `refuelingController.createOrder` e `comboioTransactionController.createEntradaTransaction`

### 3.x Diagnóstico de e-mail (melhoria não planejada) ✅
`POST /admin/email-config/test` agora:
- Recusa se senha SMTP em branco
- Chama `transporter.verify()` antes do envio
- `logger: true, debug: true` no transporter
- Retorna `info.response`, `info.accepted`, `info.rejected`, `info.envelope`
- Detecta divergência entre `fromAddress` e `user` (causa comum de bloqueio em Gmail/Office365)
- Frontend (`CommunicationTab.js`) exibe diagnóstico completo no alerta

---

## FASE 4 — CONFIGURAÇÕES E SWEEP FINAL ✅

### 4.1 Contatos Internos ✅
**Migração**: `internal_contacts` (id, nome, cargo, setor, whatsapp, email, observacao, ativo, created_at + 2 índices)

**Endpoints (`adminOnly`)**:
- `GET    /admin/internal-contacts`
- `POST   /admin/internal-contacts`
- `PUT    /admin/internal-contacts/:id`
- `DELETE /admin/internal-contacts/:id`

**`apiClient`**: `adminListInternalContacts`, `adminCreateInternalContact`, `adminUpdateInternalContact`, `adminDeleteInternalContact`

**Aba "Contatos Internos"** em `AdminPage.js` (`components/admin/ContatosInternosTab.js`):
- Grid de cards
- Busca por nome/cargo/telefone/email
- Filtro por setor
- Links clicáveis para WhatsApp e e-mail
- Toggle ativo, edição, exclusão

### 4.2 Sweep de Ordenação Alfanumérica ✅
`ORDER BY` adicionado às listagens que faltavam:
- `obraController.getAllObras` → `ORDER BY nome ASC`
- `partnerController.getAllPartners` → `ORDER BY razaoSocial ASC`
- `obraSupervisorController.getDashboardData` → `ORDER BY nome ASC`
- `vehicleController.getAllVehicles` → `ORDER BY registroInterno ASC, placa ASC`

Já ordenados (verificados): `employeeController.getAllEmployees`, `inventoryController.getAllItems`, `inventoryController.getAllCategories`, `fineController.getAllFines`, `orderController.getAllOrders`, `notification_targets` (no endpoint), `internal_contacts` (no endpoint).

---

## TODAS AS MIGRAÇÕES APLICADAS

No `back_desenvolvimento/server.js`:

```javascript
// FASE 0
{ table: 'users',    column: 'page_permissions', def: 'JSON DEFAULT NULL' },
{ table: 'obras',    column: 'tipo_registro',    def: "ENUM('obra','centro_custo') DEFAULT 'obra'" },
{ table: 'obras',    column: 'orgao_contratante',def: 'VARCHAR(50) DEFAULT NULL' },
{ table: 'obras',    column: 'regiao',           def: "ENUM('Lajeado','Santa Maria') DEFAULT NULL" },
{ table: 'vehicles', column: 'sub_tipo',         def: 'VARCHAR(100) DEFAULT NULL' },
{ table: 'vehicles', column: 'is_terceiro',      def: 'TINYINT(1) DEFAULT 0' },
// FASE 1/2
{ table: 'employees',          column: 'data_vencimento_toxicologico', def: 'DATE DEFAULT NULL' },
{ table: 'partners',           column: 'envia_por_whatsapp',           def: 'TINYINT(1) DEFAULT 0' },
{ table: 'partners',           column: 'envia_por_email',              def: 'TINYINT(1) DEFAULT 0' },
{ table: 'comboio_transactions', column: 'obra_periodo_id',            def: 'VARCHAR(36) DEFAULT NULL' },
```

Tabelas novas (criadas via `CREATE TABLE IF NOT EXISTS` no boot do `server.js`):
- `vehicle_fuel_averages`
- `comboio_periodos_obra`
- `notification_targets`
- `internal_contacts`

---

## CATÁLOGO DE EVENTOS DE NOTIFICAÇÃO

Catalogados em `notificationDispatcher.js` (`TEMPLATES`) e refletidos no `EVENT_TYPES` do `NotificacoesAdminTab.js`:

| event_type | Descrição |
|---|---|
| `obra_criada` | Nova obra cadastrada |
| `funcionario_retornou_ferias` | Retorno de férias |
| `cnh_vencendo` | CNH vence em 30 dias |
| `cnh_vencida` | CNH vencida hoje |
| `toxicologico_vencendo` | Toxicológico vence em 30 dias |
| `combustivel_obra_20pct` | Obra atingiu 80% do orçamento (event hook pendente) |
| `obra_progresso` | Obra cruzou 30/50/70% |
| `revisao_veiculo_leve` | Revisão próxima (Km) |
| `revisao_veiculo_pesado` | Revisão próxima (Hr) |
| `ordem_gerada` | Ordem criada (com anexo opcional) |
| `multa_lancada` | Multa registrada |
| `documento_veiculo_vencido` | CRLV/Seguro venceu hoje |

---

## PADRÕES DO PROJETO

- **Componentes**: `.js` funcionais com hooks (sem TypeScript)
- **Estilo**: Tailwind exclusivamente
- **Paleta**: `yellow-500` (ação), `slate-900/800` (sidebar), `gray-50/100` (fundo); `green`/`red`/`yellow`/`gray` para status
- **API client**: métodos em `front_desenvolvimento/src/services/apiClient.js`
- **Nova página**: criar em `pages/`, importar lazy em `App.js`, adicionar em `renderPage()` e `Sidebar.js`, registrar em `DataContext.js` se tiver recurso, adicionar em `PAGE_RESOURCE_REQUIREMENTS`
- **Novo recurso no DataContext**: registrar em `RESOURCE_DEFS` e `TARGET_TO_RESOURCE`
- **Texto da UI**: pt-BR
- **Comentários**: apenas quando o "porquê" é não-óbvio
- **`vehicleRules.js`**: replicar TODA mudança em ambas as cópias (front e back)
- **Migrações**: padrão `{ table, column, def }` no `server.js`; tabelas novas via `CREATE TABLE IF NOT EXISTS`

---

## COMO TESTAR APÓS DEPLOY

1. Backend sobe → migrações idempotentes rodam, vê logs `✅ … : tabela ok.` ou `… períodos abertos (backfill).`
2. Admin → **Notificações** → cadastra um destino (ex.: e-mail por evento `obra_criada`)
3. Cria uma obra → e-mail chega
4. Admin → **Contatos Internos** → cadastra pessoas-chave
5. Admin → **Comunicação** → "Enviar teste" → resposta detalhada do SMTP no alerta
6. Página **Comboio** → seleciona um comboio → dropdown "Obras atendidas" filtra o histórico
7. Página **Veículos** → cards ordenados alfabeticamente
8. Página **Obras** → cards ordenados, com prefixo `[ÓRGÃO]`, borda amarela quando incompletos
9. Cron rodando: ajuste `HORA_EXECUCAO`/`MINUTO_EXECUCAO` no `cronService.js` para o próximo minuto e observe o log

---

## DEPLOY

**Easypanel observa o branch `main` no GitHub**. Workflow:

```bash
# Backend
cd back_desenvolvimento
git add -A
git commit -m "feat: descrição"
git push origin main

# Frontend
cd ../front_desenvolvimento
git add -A
git commit -m "feat: descrição"
git push origin main
```

Após o push, Easypanel detecta e rebuilda. Acompanhe os logs pelo painel.

**Variável de ambiente do frontend**:
- `REACT_APP_API_URL` injetada como `ARG` no Docker build do Easypanel

**Variáveis do backend** (em Easypanel):
- `WHATSAPP_SERVICE_URL`, `WHATSAPP_SERVICE_KEY`
- Conexão MySQL
- Demais conforme `.env`

---

## STATUS GERAL

| Fase | Status |
|---|---|
| 0.1 Timezone | ✅ |
| 0.2 Permissões | ✅ |
| 0.3 Obra vs CC | ✅ |
| 0.4 Sub-tipos | ✅ |
| 1.1 Base leituras | ✅ |
| 1.2 Médias combustível | ✅ |
| 1.3 Campos obras | ✅ |
| 2.1 Dashboard | ✅ |
| 2.2 Obras | ✅ |
| 2.3 Veículos | ✅ |
| 2.4 Alertas + tox | ✅ |
| 2.5 Abastecimento | ✅ |
| 2.6 Comboio | ✅ |
| 2.7 Ordens | ✅ |
| 2.8 Faturamento | ✅ |
| 2.9 Postos | ✅ |
| 2.10 Pneus/Manutenção | ✅ |
| 3.1 Tabela + tela | ✅ |
| 3.2 Cron + controllers | ✅ (combustivel_obra_20pct pendente — sem coluna de orçamento) |
| 3.3 Envio ordens | ✅ |
| 4.1 Contatos internos | ✅ |
| 4.2 Sweep ordenação | ✅ |

**Implantação completa.**
