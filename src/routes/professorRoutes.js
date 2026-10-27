const express = require('express');
const { listar, receberSinal, corrigirNome } = require('../controllers/professorController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

// Sem autenticação: chamado pelo userscript Tampermonkey, que não envia token
router.post('/webhook/sinal-script', receberSinal);

// /professores (sem /lista) é a view, em viewRoutes.
router.get('/professores/lista', autenticar, listar);
router.post('/professores/corrigir-nome', autenticar, corrigirNome);

module.exports = router;
