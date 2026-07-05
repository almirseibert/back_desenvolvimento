// routes/suggestionRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('../middlewares/authMiddleware');
const suggestionController = require('../controllers/suggestionController');

const absoluteUploadDir = path.resolve(process.cwd(), 'public/uploads');
if (!fs.existsSync(absoluteUploadDir)) fs.mkdirSync(absoluteUploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, absoluteUploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, 'suggestion-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Apenas imagens (prints) são permitidas.'), allowed.includes(file.mimetype));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authMiddleware);

const adminOnly = (req, res, next) => {
    if (req.user.user_type !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
    next();
};

// Qualquer usuário autenticado pode enviar sugestão (com até 5 prints)
router.post('/', upload.array('anexos', 5), suggestionController.createSuggestion);

// Admin: listar e atualizar status
router.get('/', adminOnly, suggestionController.listSuggestions);
router.patch('/:id', adminOnly, suggestionController.updateSuggestionStatus);

module.exports = router;
