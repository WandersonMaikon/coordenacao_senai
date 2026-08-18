const express = require('express');
const { registrar, listarPorAluno } = require('../controllers/contatoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.post('/contatos', autenticar, registrar);
router.get('/contatos', autenticar, listarPorAluno);

module.exports = router;
