require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const app = express();
const PORT = process.env.PORT || 3000;

// Limiar de faltas acumuladas para considerar o aluno em risco (decisão do usuário: mínimo 4)
const LIMITE_FALTAS_RISCO = 4;

const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
});
const prisma = new PrismaClient({ adapter });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─────────────────────────────────────────
// Rota de teste
// ─────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', mensagem: 'Backend SENAI Ji-Paraná ativo (Node + Prisma + MySQL)' });
});

// ─────────────────────────────────────────
// Rota principal — recebe os lançamentos do Tampermonkey
// ─────────────────────────────────────────
app.post('/webhook/frequencia', async (req, res) => {
    const { lancamentos } = req.body;

    if (!lancamentos || !Array.isArray(lancamentos)) {
        return res.status(400).json({
            status: 'erro',
            mensagem: 'Formato inválido: esperado campo "lancamentos" como array'
        });
    }

    if (lancamentos.length === 0) {
        return res.json({ status: 'ok', mensagem: 'Nenhum lançamento para processar' });
    }

    let inseridos = 0;
    let corrigidos = 0;

    try {
        for (const item of lancamentos) {
            const chave = {
                matricula: item.matricula || '',
                dataAula: item.data_aula || '',
                codigoTurma: item.codigo_turma || ''
            };

            // upsert: se o professor corrigir um lançamento (ex: desmarcar uma falta
            // indevida e salvar de novo), a chave já existe e o registro é atualizado
            // em vez de ignorado como duplicata.
            const resultado = await prisma.lancamento.upsert({
                where: { chave_idempotencia: chave },
                update: {
                    nomeAluno: item.nome_aluno || '',
                    idAula: item.id_aula || '',
                    nomeTurma: item.nome_turma || '',
                    uc: item.uc || '',
                    periodoLetivo: item.periodo_letivo || '',
                    professor: item.professor || '',
                    qtdFaltas: item.qtd_faltas ?? 0
                },
                create: {
                    ...chave,
                    nomeAluno: item.nome_aluno || '',
                    idAula: item.id_aula || '',
                    nomeTurma: item.nome_turma || '',
                    uc: item.uc || '',
                    periodoLetivo: item.periodo_letivo || '',
                    professor: item.professor || '',
                    qtdFaltas: item.qtd_faltas ?? 1
                }
            });

            // criadoEm === atualizadoEm só na criação (ambos recebem o mesmo timestamp)
            if (resultado.criadoEm.getTime() === resultado.atualizadoEm.getTime()) {
                inseridos++;
            } else {
                corrigidos++;
                console.log(`[Webhook] Corrigido: ${item.matricula} / ${item.data_aula} -> qtd_faltas=${resultado.qtdFaltas}`);
            }
        }

        console.log(`[Webhook] ${inseridos} novo(s), ${corrigidos} corrigido(s)`);

        return res.json({
            status: 'ok',
            mensagem: `${inseridos} lançamento(s) registrado(s)${corrigidos > 0 ? `, ${corrigidos} corrigido(s)` : ''}`
        });

    } catch (erro) {
        console.error('[Webhook] Erro ao processar lançamentos:', erro);
        return res.status(500).json({
            status: 'erro',
            mensagem: 'Erro interno ao salvar no banco: ' + erro.message
        });
    }
});

// ─────────────────────────────────────────
// Rota auxiliar — listar lançamentos (útil para conferir se está salvando)
// ─────────────────────────────────────────
app.get('/lancamentos', async (req, res) => {
    try {
        const lancamentos = await prisma.lancamento.findMany({
            orderBy: { criadoEm: 'desc' },
            take: 100
        });
        res.json({ status: 'ok', total: lancamentos.length, dados: lancamentos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
});

// ─────────────────────────────────────────
// Rota auxiliar — listar alunos em risco (LIMITE_FALTAS_RISCO+ faltas), já pensando no futuro
// ─────────────────────────────────────────
app.get('/alunos-risco', async (req, res) => {
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
});

// ─────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Teste a conexão em: http://localhost:${PORT}/`);
    console.log(`📋 Veja os lançamentos em: http://localhost:${PORT}/lancamentos`);
    console.log(`⚠️  Veja alunos em risco em: http://localhost:${PORT}/alunos-risco`);
});

// Encerra a conexão do Prisma corretamente quando o servidor for finalizado
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});