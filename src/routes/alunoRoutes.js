const express = require('express');
const multer = require('multer');
const { listarEmRisco, listarRecuperados, importarTelefones, buscarAlunos, atualizarTelefone, resumoAlunos, atencaoPainel, resolverCaso, listarCasosResolvidosRota, reabrirCaso } = require('../controllers/alunoController');
const { autenticar } = require('../middlewares/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/alunos-risco', autenticar, listarEmRisco);
router.get('/alunos-recuperados', autenticar, listarRecuperados);

// Casos encerrados pela coordenação (tela /recuperado): o aluno sai do risco até
// alguém reabrir.
router.get('/casos-resolvidos', autenticar, listarCasosResolvidosRota);
router.post('/casos-resolvidos', autenticar, resolverCaso);
router.delete('/casos-resolvidos/:matricula/:codigoTurma', autenticar, reabrirCaso);
router.get('/alunos/resumo', autenticar, resumoAlunos);
router.get('/alunos/atencao', autenticar, atencaoPainel);
// Antes de qualquer rota com parâmetro em /alunos, senão "buscar" viraria matrícula
router.get('/alunos/buscar', autenticar, buscarAlunos);
router.post('/alunos/importar-telefones', autenticar, upload.single('arquivo'), importarTelefones);
// Aluno que trocou de número no meio do semestre (tela /telefones)
router.put('/alunos/:matricula/telefone', autenticar, atualizarTelefone);

module.exports = router;
