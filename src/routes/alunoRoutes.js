const express = require('express');
const multer = require('multer');
const { listarEmRisco, importarTelefones, resumoAlunos } = require('../controllers/alunoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/alunos-risco', autenticar, listarEmRisco);
router.get('/alunos/resumo', autenticar, resumoAlunos);
router.post('/alunos/importar-telefones', autenticar, upload.single('arquivo'), importarTelefones);

module.exports = router;
