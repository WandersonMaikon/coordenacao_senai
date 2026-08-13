const prisma = require('../config/prisma');

// Limiar de faltas acumuladas para considerar o aluno em risco (decisão do usuário: mínimo 4)
const LIMITE_FALTAS_RISCO = 4;

// Agrupa lançamentos por aluno e filtra quem já atingiu o limite de faltas
async function listarEmRisco(req, res) {
    try {
        const resultado = await prisma.lancamento.groupBy({
            by: ['matricula', 'nomeAluno'],
            _sum: { qtdFaltas: true },
            having: {
                qtdFaltas: { _sum: { gte: LIMITE_FALTAS_RISCO } }
            },
            orderBy: { _sum: { qtdFaltas: 'desc' } }
        });
        res.json({ status: 'ok', total: resultado.length, dados: resultado });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { listarEmRisco, LIMITE_FALTAS_RISCO };
