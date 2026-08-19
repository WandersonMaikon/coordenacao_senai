const express = require('express');
const { listar, criar } = require('../controllers/usuarioController');
const { autenticar, exigirAdmin } = require('../middlewares/auth');

const router = express.Router();

// Montado sob o prefixo /auth em server.js — evita colidir com a rota de
// view GET /usuarios (viewRoutes), que serve a página HTML no mesmo caminho.
// exigirAdmin: só o admin pode ver/cadastrar usuários do painel.
router.get('/usuarios', autenticar, exigirAdmin, listar);
router.post('/usuarios', autenticar, exigirAdmin, criar);

module.exports = router;
