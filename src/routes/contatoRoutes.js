const express = require('express');
const { registrar, listarPorAluno, atualizar } = require('../controllers/contatoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.post('/contatos', autenticar, registrar);
router.get('/contatos', autenticar, listarPorAluno);
router.put('/contatos/:id', autenticar, atualizar);

module.exports = router;
