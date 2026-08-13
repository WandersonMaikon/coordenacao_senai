const express = require('express');
const { paginaLogin, paginaPainel, paginaFaltas } = require('../controllers/viewController');

const router = express.Router();

router.get('/login', paginaLogin);
router.get('/painel', paginaPainel);
router.get('/faltas', paginaFaltas);

module.exports = router;