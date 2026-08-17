const express = require('express');
const { paginaLogin, paginaPainel, paginaFaltas, paginaImportarTelefones } = require('../controllers/viewController');

const router = express.Router();

router.get('/login', paginaLogin);
router.get('/painel', paginaPainel);
router.get('/faltas', paginaFaltas);
router.get('/importar-telefones', paginaImportarTelefones);

module.exports = router;