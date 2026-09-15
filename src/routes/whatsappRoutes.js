const express = require('express');
const { obterMeuNumero, salvarMeuNumero, conectarSessao, obterSessao, desconectarSessao } = require('../controllers/whatsappController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

// Cada usuário só enxerga e mexe no próprio número — o usuário sai do token, não
// de parâmetro na URL.
router.get('/whatsapp/meu-numero', autenticar, obterMeuNumero);
router.put('/whatsapp/meu-numero', autenticar, salvarMeuNumero);
router.get('/whatsapp/sessao', autenticar, obterSessao);
router.post('/whatsapp/sessao/conectar', autenticar, conectarSessao);
router.post('/whatsapp/sessao/desconectar', autenticar, desconectarSessao);

module.exports = router;
