const express = require('express');
const { listarTurmas, listarEncerradas, encerrarTurma, reabrirTurma } = require('../controllers/turmaController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();

router.get('/turmas', autenticar, listarTurmas);

// Encerrar/reabrir é rotina da coordenação, como registrar contato: qualquer
// usuário logado pode, e fica gravado quem fez.
router.get('/turmas-encerradas', autenticar, listarEncerradas);
router.post('/turmas-encerradas', autenticar, encerrarTurma);
router.delete('/turmas-encerradas/:codigoTurma', autenticar, reabrirTurma);

module.exports = router;
