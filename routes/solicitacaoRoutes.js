const express = require('express');
const router = express.Router();

// Importação dos DOIS controladores separados
const solicitacaoAppController = require('../controllers/solicitacaoAppController');
const solicitacaoAdminController = require('../controllers/solicitacaoAdminController');

const authMiddleware = require('../middlewares/authMiddleware');

// Multer do App (para fotos de painel e cupom)
const uploadApp = solicitacaoAppController.upload;
// Multer do Admin (para PDFs gerados) - Agora usa o corrigido
const uploadAdmin = solicitacaoAdminController.uploadPdf;

router.use(authMiddleware);

// --- ROTAS DE LISTAGEM ---
router.get('/', (req, res, next) => {
    const userRole = req.user.role;
    const isGestor = userRole === 'admin' || userRole === 'gestor' || req.user.canAccessRefueling;

    if (isGestor) {
        return solicitacaoAdminController.listarTodasSolicitacoes(req, res, next);
    } else {
        return solicitacaoAppController.listarMinhasSolicitacoes(req, res, next);
    }
});

// NOVA ROTA: Upload de PDF Gerado (usando o controller Admin atualizado)
// A rota permanece a mesma, mas agora o controller para onde ela aponta está corrigido
router.post('/upload-pdf', uploadAdmin.single('file'), solicitacaoAdminController.uploadPdfGerado);

// --- ROTAS DO APP (MOTORISTA) ---
router.post('/', uploadApp.single('foto_painel'), solicitacaoAppController.criarSolicitacao);
router.put('/:id/comprovante', uploadApp.single('foto_cupom'), solicitacaoAppController.enviarComprovante);
router.get('/meus-status', solicitacaoAppController.verificarStatusUsuario);

// --- ROTAS DO ADMIN (GESTOR) ---
router.put('/:id/avaliar', solicitacaoAdminController.avaliarSolicitacao);
router.put('/:id/confirmar-baixa', solicitacaoAdminController.confirmarBaixa);
router.put('/:id/rejeitar-comprovante', solicitacaoAdminController.rejeitarComprovante);

module.exports = router;