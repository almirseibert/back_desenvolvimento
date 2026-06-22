# MAK Frotas — Backend

API REST + WebSocket que serve o frontend e o app mobile do sistema de gestão de frotas.

## Stack

- **Node.js** + **Express 5** (CommonJS, `"type": "commonjs"`)
- **MySQL 8** via `mysql2/promise` (pool de 10 conexões em [database.js](database.js))
- **Socket.io 4** para eventos em tempo real (`server:sync` invalida caches no frontend)
- **JWT** (`jsonwebtoken`) para autenticação, **bcrypt** para hash de senhas
- **Multer** para upload (10MB, JPEG/PNG/WEBP/PDF) em `public/uploads/`
- **node-cron** para tarefas agendadas (`services/cronService.js`)
- **nodemailer** (email), **@anthropic-ai/sdk** (chatbot WhatsApp), **pdfkit** (PDFs)
- **helmet**, **compression**, **express-rate-limit**, **cors**

## Comandos

```bash
npm start              # node server.js (porta 3001 por padrão)
npm run start:prod     # NODE_ENV=production node server.js
npm run test:db        # smoke test da conexão MySQL
```

### Docker

`Dockerfile` na raiz. Build de produção via Easypanel.

## Variáveis de Ambiente

`.env` carregado primeiro, `.env.local` em seguida com `override: true` (banco de testes local).

| Variável | Uso |
|----------|-----|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PORT` | MySQL |
| `JWT_SECRET` | Assinatura dos tokens JWT |
| `ALLOWED_ORIGINS` | CSV de origens CORS adicionais — somadas ao default (localhost + domínios Easypanel + frotamak.com) |
| `PORT` | Porta HTTP (default 3001) |
| `NODE_ENV` | `production` esconde `err.message` em respostas 500 |

## Arquitetura

### Camadas

```
server.js          → bootstrap, migrações inline, CORS, registro de rotas
├── routes/        → express.Router por recurso, monta endpoints
├── controllers/   → handlers (validação + chamadas ao db)
├── services/      → lógica que roda fora do request (cron, notificações, PDFs, sincronização externa)
├── middlewares/   → authMiddleware (único, global após rotas públicas)
├── utils/         → regras de domínio reutilizáveis (vehicleRules, comboioPeriodo, recalcFuelAverage…)
├── migrations/    → SQL avulso (mas a maioria das migrações está inline no server.js)
└── whatsapp/      → integração com WhatsApp Business / chatbot
```

Rotas seguem o padrão `routes → controller → db.query`. Não há ORM — SQL cru via `db.query(...)` que retorna `[rows, fields]` (mysql2 promise).

### Autenticação

[`middlewares/authMiddleware.js`](middlewares/authMiddleware.js):
- Lê `Authorization: Bearer <token>`, verifica com `JWT_SECRET`
- **Revalida no banco a cada request** (busca `users.id` → role, flags `canAccessRefueling`, `canAccessAnaliseGerencial`, `bloqueado_abastecimento`). Caro, mas garante revogação em tempo real.
- Popula `req.user` com `{ id, email, role, user_type, canAccessRefueling, canAccessAnaliseGerencial, bloqueado_abastecimento }`
- Rotas com `/supervisor` na URL exigem role `admin` ou `supervisor`.

### Rotas públicas (sem auth)

`/api/auth/*`, `/api/registrationRequests`, `/api/operationalRequests`, `POST /api/whatsapp/webhook` (chatbot).

Tudo o mais passa por `authMiddleware`.

### Migrações inline (server.js)

[server.js:13-618](server.js) tem dezenas de IIFE rodando `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` e `CREATE TABLE IF NOT EXISTS` no boot. **Idempotentes** — toleram `ER_DUP_FIELDNAME` / `ER_DUP_KEYNAME`. Quando adicionar coluna/tabela nova:

1. Adicione a migração no bloco apropriado de `server.js` (não na pasta `migrations/`).
2. Use `IF NOT EXISTS` ou trate `ER_DUP_FIELDNAME` no catch.
3. Pode incluir seed/backfill idempotente no mesmo IIFE.

A pasta `migrations/` existe mas não é executada automaticamente — é histórico/manual.

### Socket.io

`global.io` exposto, `req.io` injetado em todo request. Padrão para notificar o frontend:

```js
req.io.emit('server:sync', { resource: 'vehicles' });
```

O frontend (`DataContext.js`) invalida só os recursos JÁ cacheados — não força refetch de tudo.

### CORS

Whitelist hard-coded (`defaultOrigins` em [server.js:641](server.js)) unida com `ALLOWED_ORIGINS` do env. Origens sem header `Origin` (preflight, same-origin) são permitidas. Bloqueio retorna `callback(null, false)` — **não** `new Error()`, isso quebrava o preflight.

### Uploads

`POST /api/upload` (autenticado) salva em `public/uploads/`, retorna `{ url, filename, size }`. Servido estático em `/uploads/*` com cache de 1 dia.

## Convenções

### SQL

- Sempre `mysql2/promise`: `const [rows] = await db.query(sql, params)`.
- **Sempre placeholders `?`** — nunca interpolar valores na string SQL (SQL injection).
- IDs novos: `VARCHAR(36)` com `require('crypto').randomUUID()`. IDs antigos (`users`, `employees` em parte) são `INT AUTO_INCREMENT` — não converter.
- Timezone do pool é `-03:00`. Datas vindas do banco já estão em horário de Brasília.

### Endpoints

- Prefixo `/api/`, plural em camelCase: `/api/vehicles`, `/api/comboioTransactions`, `/api/operationalRequests`.
- Verbo HTTP padrão REST. Erros: status correto + `{ error: 'mensagem' }`.
- `req.user.role` em minúsculas: `admin`, `editor`, `operador`, `supervisor`, `viewer`/`visualizador`.

### Logs

Emojis nos logs são intencionais (`✅`, `❌`, `⚠️`, `📨`, `🚨`) — facilitam o scan visual em produção. Não remover.

### Erros

- Validação → 400 com `{ error }`
- Auth → 401 / 403
- Recurso não achado → 404
- Genérico → middleware final em [server.js:913](server.js) responde 500 com `err.message` só em dev.

## Adicionando um novo módulo

1. Criar `routes/novoRoutes.js` e `controllers/novoController.js`.
2. Registrar no `server.js` na seção de imports e em `apiRouter.use('/novo', novoRoutes)`.
3. Decidir se é rota pública (acima do `authMiddleware`) ou protegida (abaixo).
4. Se tiver tabela nova: adicionar migração inline em `server.js` com `CREATE TABLE IF NOT EXISTS`.
5. Se o frontend precisa reagir em tempo real, emitir `req.io.emit('server:sync', { resource: '<nome>' })` nos handlers de POST/PUT/DELETE.
6. Espelhar o endpoint em `front_desenvolvimento/src/services/apiClient.js`.

## Domínio (vocabulário)

- **Obra** — local de trabalho onde veículos são alocados. Tem `tipo_registro` (`obra` ou `centro_custo`) e `regiao` (`Lajeado` ou `Santa Maria`).
- **Veículo** — leve, caminhão (trecho ou pesado), máquina, comboio. Leitura em Km ou Hr conforme grupo (`utils/vehicleRules.js`).
- **Comboio** — veículo-tanque que abastece outros veículos na obra. Tem `partner` espelho e `comboio_periodos_obra` para rastrear estadias.
- **Solicitação de abastecimento** — operador na obra solicita combustível; admin aprova e gera ordem (`orders`).
- **Diário de bordo / Daily work log** — registro diário de uso do veículo.
- **Funcionário placeholder** (`isPlaceholder=1`) — operador temporário (`COLABORADOR`, `TESTE`, `MAK SERVIÇOS`) usado em alocações antes do operador real.
- **Siga Sul** — sistema externo de rastreamento; sincronizamos posições/jornadas em `sigasul_*`.
