const express = require('express');
const { paginaLogin, paginaPainel, paginaFaltas, paginaRisco, paginaImportarTelefones } = require('../controllers/viewController');

const router = express.Router();

router.get('/login', paginaLogin);
router.get('/painel', paginaPainel);
router.get('/faltas', paginaFaltas);
router.get('/risco', paginaRisco);
router.get('/importar-telefones', paginaImportarTelefones);

module.exports = router;