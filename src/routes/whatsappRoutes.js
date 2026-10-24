const express = require('express');
const {
    obterMeuNumero,
    salvarMeuNumero,
    conectarSessao,
    obterSessao,
    desconectarSessao,
    obterConfig,
    salvarConfig,
    previaMensagem,
    obterAutomatico,
    salvarAutomatico,
    turmasParaEnvio,
    decidirFaltaColetiva,
    retomarSessao,
    historico
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

router.get('/whatsapp/config', autenticar, obterConfig);
router.put('/whatsapp/config', autenticar, salvarConfig);
router.post('/whatsapp/config/previa', autenticar, previaMensagem);

// Envio automático: todos veem a cobertura; só o dono do número do sistema ou o
// admin ligam, desligam e escolhem as turmas.
router.get('/whatsapp/automatico', autenticar, obterAutomatico);
router.put('/whatsapp/automatico', autenticar, salvarAutomatico);
router.get('/whatsapp/turmas-envio', autenticar, turmasParaEnvio);
// Falta coletiva: qualquer usuário logado decide (é decisão da coordenação).
router.post('/whatsapp/falta-coletiva', autenticar, decidirFaltaColetiva);
router.post('/whatsapp/sessao/retomar', autenticar, retomarSessao);

// Histórico de envios: todos os usuários veem todos os envios.
router.get('/whatsapp/mensagens', autenticar, historico);

module.exports = router;
