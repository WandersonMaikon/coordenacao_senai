const express = require('express');
const { registrar, listarPorAluno, atualizar, remover, resumoMotivos } = require('../controllers/contatoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.post('/contatos', autenticar, registrar);
router.get('/contatos', autenticar, listarPorAluno);
router.get('/contatos/motivos', autenticar, resumoMotivos);
router.put('/contatos/:id', autenticar, atualizar);
router.delete('/contatos/:id', autenticar, remover);

module.exports = router;
