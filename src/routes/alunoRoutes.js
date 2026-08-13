const express = require('express');
const { listarEmRisco } = require('../controllers/alunoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.get('/alunos-risco', autenticar, listarEmRisco);

module.exports = router;
