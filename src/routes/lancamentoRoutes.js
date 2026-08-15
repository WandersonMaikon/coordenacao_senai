const express = require('express');
const { receberWebhook, listar, listarTurmas } = require('../controllers/lancamentoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

// Sem autenticação: chamado pelo userscript Tampermonkey, que não envia token
router.post('/webhook/frequencia', receberWebhook);

router.get('/lancamentos', autenticar, listar);
router.get('/turmas', autenticar, listarTurmas);

module.exports = router;
