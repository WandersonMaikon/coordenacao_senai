const express = require('express');
const {
    obterMeuNumero,
    salvarMeuNumero,
    conectarSessao,
    obterSessao,
    desconectarSessao,
    listarTurmas,
    assumirTurma,
    liberarTurma,
    obterConfig,
    salvarConfig,
    previaMensagem,
    previaLote
} = require('../controllers/whatsappController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

// Cada usuário só enxerga e mexe no próprio número e na própria configuração — o
// usuário sai do token, não de parâmetro na URL.
router.get('/whatsapp/meu-numero', autenticar, obterMeuNumero);
router.put('/whatsapp/meu-numero', autenticar, salvarMeuNumero);
router.get('/whatsapp/sessao', autenticar, obterSessao);
router.post('/whatsapp/sessao/conectar', autenticar, conectarSessao);
router.post('/whatsapp/sessao/desconectar', autenticar, desconectarSessao);

// Turmas: todos veem quem assumiu o quê; liberar a turma de outra pessoa só o admin.
router.get('/whatsapp/turmas', autenticar, listarTurmas);
router.post('/whatsapp/turmas/:codigoTurma', autenticar, assumirTurma);
router.delete('/whatsapp/turmas/:codigoTurma', autenticar, liberarTurma);

router.get('/whatsapp/config', autenticar, obterConfig);
router.put('/whatsapp/config', autenticar, salvarConfig);
router.post('/whatsapp/config/previa', autenticar, previaMensagem);

router.get('/whatsapp/lote/previa', autenticar, previaLote);

module.exports = router;
