const prisma = require('../config/prisma');

// Recebe os lançamentos capturados pelo userscript Tampermonkey
async function receberWebhook(req, res) {
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
}

// Lista os lançamentos mais recentes (debug/conferência), ou os de uma data
// específica quando ?data=AAAA-MM-DD é informado (filtro usado na tela de faltas)
async function listar(req, res) {
    try {
        const { data } = req.query;
        const where = {};

        if (data) {
            const [ano, mes, dia] = data.split('-');
            if (!ano || !mes || !dia) {
                return res.status(400).json({ status: 'erro', mensagem: 'Data inválida, use o formato AAAA-MM-DD' });
            }
            where.dataAula = `${dia}/${mes}/${ano}`;
        }

        const lancamentos = await prisma.lancamento.findMany({
            where,
            orderBy: { criadoEm: 'desc' },
            take: data ? undefined : 100
        });
        res.json({ status: 'ok', total: lancamentos.length, dados: lancamentos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { receberWebhook, listar };
