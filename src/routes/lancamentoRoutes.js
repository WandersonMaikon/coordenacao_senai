const express = require('express');
const { receberWebhook, listar } = require('../controllers/lancamentoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

// Sem autenticação: chamado pelo userscript Tampermonkey, que não envia token
router.post('/webhook/frequencia', receberWebhook);

router.get('/lancamentos', autenticar, listar);
// GET /turmas mora no turmaRoutes, junto com o encerramento de turma.

module.exports = router;
