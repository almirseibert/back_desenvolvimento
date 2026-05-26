// routes/uploadRoutes.js
// ============================================================================
// Rota de upload de arquivos (PDFs, imagens, documentos)
// Necessária para que o OrdersPage faça upload do PDF gerado antes de
// enviá-lo via WhatsApp ao fornecedor.
//
// DEPENDÊNCIAS:
//   npm install multer
//
// REGISTRO no app.js / server.js:
//   const uploadRoutes = require('./routes/uploadRoutes');
//   app.use('/api', uploadRoutes);
//
// Isso expõe:  POST /api/upload
// ============================================================================

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const authMiddleware = require('../middlewares/authMiddleware');

// ── Configuração do Multer ────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// Garante que a pasta existe
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext      = path.extname(file.originalname).toLowerCase();
        const baseName = path.basename(file.originalname, ext)
            .replace(/[^a-zA-Z0-9_-]/g, '_')   // sanitiza o nome
            .substring(0, 60);
        const unique   = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `${baseName}-${unique}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        const ALLOWED = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls', '.csv', '.xml'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED.includes(ext)) return cb(null, true);
        cb(new Error(`Tipo de arquivo não permitido: ${ext}`));
    },
});

// ── Helper: monta URL pública do arquivo ─────────────────────────────────────
const buildPublicUrl = (req, filename) => {
    // Se houver variável de ambiente definindo a URL base, usa ela
    // (evita problema de http vs https em produção)
    const base = process.env.PUBLIC_URL
        || process.env.BACKEND_URL
        || `${req.protocol}://${req.get('host')}`;
    return `${base}/uploads/${filename}`;
};

// ── POST /api/upload ──────────────────────────────────────────────────────────
router.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
    }

    const url = buildPublicUrl(req, req.file.filename);

    console.log(`[Upload] Arquivo salvo: ${req.file.filename} → ${url}`);

    return res.status(201).json({
        url,                          // URL pública acessível
        fileUrl: url,                 // alias (compatibilidade)
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
    });
});

// ── Tratamento de erro do Multer ──────────────────────────────────────────────
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.includes('não permitido')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

module.exports = router;
