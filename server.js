require('dotenv').config();
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
        { table: 'comboio_transactions',   column: 'authNumber',                      def: 'INT UNSIGNED DEFAULT NULL' },
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

    console.log('✅ Migração de schema concluída.');
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
const adminRoutes = require('./routes/adminRoutes');
const expensesRoutes = require('./routes/expenseRoutes');
const userRoutes = require('./routes/userRoutes');
const updateRoutes = require('./routes/updateRoutes');
const tireRoutes = require('./routes/tireRoutes');
const obraSupervisorRoutes = require('./routes/obraSupervisorRoutes');
const solicitacaoRoutes = require('./routes/solicitacaoRoutes');
const billingRoutes = require('./routes/billingRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');
const washingRoutes = require('./routes/washingRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const sigasulRoutes = require('./routes/sigasulRoutes');

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
apiRouter.use('/solicitacoes', solicitacaoRoutes);
apiRouter.use('/maintenances', maintenanceRoutes);
apiRouter.use('/washings', washingRoutes);
apiRouter.use('/agenda', agendaRoutes);
apiRouter.use('/inventory', inventoryRoutes);
apiRouter.use('/whatsapp', whatsappRoutes);
apiRouter.use('/sigasul', sigasulRoutes);

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