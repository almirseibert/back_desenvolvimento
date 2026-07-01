// routes/vehicleRoutes.js
const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicleController');
const vehicleDocumentsController = require('../controllers/vehicleDocumentsController');
const authMiddleware = require('../middlewares/authMiddleware');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadDir = 'public/uploads';
const absoluteUploadDir = path.resolve(process.cwd(), uploadDir);

if (!fs.existsSync(absoluteUploadDir)) {
    fs.mkdirSync(absoluteUploadDir, { recursive: true });
    console.log(`[Multer] Diretório de upload criado em: ${absoluteUploadDir}`);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, absoluteUploadDir); 
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'vehicle-' + uniqueSuffix + ext);
    }
});

// --- CORREÇÃO DE SEGURANÇA: FILE FILTER RIGOROSO PARA IMAGENS ---
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não suportado! Apenas imagens (JPEG/PNG/WEBP) são permitidas.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// Multer para documentos PDF
const docStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, absoluteUploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'doc-' + uniqueSuffix + ext);
    }
});

const docFileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Apenas arquivos PDF são permitidos.'), false);
    }
};

const uploadDoc = multer({
    storage: docStorage,
    fileFilter: docFileFilter,
    limits: { fileSize: 20 * 1024 * 1024 }
});

// --- Rotas ---
router.use(authMiddleware);

// Rotas CRUD padrão
router.get('/', vehicleController.getAllVehicles);
router.get('/:id', vehicleController.getVehicleById);
router.post('/', vehicleController.createVehicle);
router.put('/:id', vehicleController.updateVehicle);
router.delete('/:id', vehicleController.deleteVehicle);

// --- Rota de Upload de Imagem ---
// O frontend chamará esta rota *após* criar/salvar o veículo
router.post(
    '/:id/upload-image', 
    upload.single('fotoFile'), // 'fotoFile' deve ser o nome do campo no FormData
    vehicleController.uploadVehicleImage
);


// --- Rotas de Alocação (sem mudança) ---
router.post('/:id/allocate-obra', vehicleController.allocateToObra);
router.post('/:id/deallocate-obra', vehicleController.deallocateFromObra);
router.post('/:id/assign-operational', vehicleController.assignToOperational);
router.post('/:id/unassign-operational', vehicleController.unassignFromOperational);
router.post('/:id/start-maintenance', vehicleController.startMaintenance);
router.post('/:id/end-maintenance', vehicleController.endMaintenance);


// --- Rotas de Documentos do Veículo ---
router.get('/:id/documents', vehicleDocumentsController.listDocuments);
router.post('/:id/documents', uploadDoc.single('documentFile'), vehicleDocumentsController.uploadDocument);
router.delete('/:id/documents/:docId', vehicleDocumentsController.deleteDocument);

module.exports = router;