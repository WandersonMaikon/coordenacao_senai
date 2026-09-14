const express = require('express');
const multer = require('multer');
const { listarEmRisco, listarRecuperados, importarTelefones, resumoAlunos, atencaoPainel } = require('../controllers/alunoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/alunos-risco', autenticar, listarEmRisco);
router.get('/alunos-recuperados', autenticar, listarRecuperados);
router.get('/alunos/resumo', autenticar, resumoAlunos);
router.get('/alunos/atencao', autenticar, atencaoPainel);
router.post('/alunos/importar-telefones', autenticar, upload.single('arquivo'), importarTelefones);

module.exports = router;
