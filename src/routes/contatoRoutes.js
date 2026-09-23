const express = require('express');
const { registrar, listarPorAluno, atualizar, confirmarMotivo, remover, resumoMotivos } = require('../controllers/contatoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.post('/contatos', autenticar, registrar);
router.get('/contatos', autenticar, listarPorAluno);
router.get('/contatos/motivos', autenticar, resumoMotivos);
router.put('/contatos/:id', autenticar, atualizar);
// Confirmar a sugestão de motivo é rotina de qualquer usuário logado — diferente
// do PUT acima, que só o autor do contato pode usar (ver o controller).
router.post('/contatos/:id/confirmar-motivo', autenticar, confirmarMotivo);
router.delete('/contatos/:id', autenticar, remover);

module.exports = router;
