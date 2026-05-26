const express = require('express');
const router = express.Router();
const checklistController = require('../controllers/checklistController');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.resolve(process.cwd(), 'public/uploads/checklists');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.pdf';
        cb(null, `checklist-${uniqueSuffix}${ext}`);
    }
});

// --- CORREÇÃO DE SEGURANÇA: FILE FILTER RESTRITO A PDF ---
const fileFilterChecklist = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Arquivo inválido. Apenas arquivos PDF são permitidos para checklists.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilterChecklist,
    limits: { fileSize: 15 * 1024 * 1024 } 
});


// --- ROTAS ---

// POST /api/checklists -> Recebe o PDF e salva
router.post('/', upload.single('file'), checklistController.uploadChecklist);

// GET /api/checklists/vehicle/:vehicleId -> Lista histórico
router.get('/vehicle/:vehicleId', checklistController.getChecklistsByVehicle);

module.exports = router;