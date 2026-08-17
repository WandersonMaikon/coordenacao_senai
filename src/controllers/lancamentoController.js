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

// dataAula é gravada como string "dd/mm/aaaa" (formato do SGE), então um
// intervalo não dá pra filtrar com gte/lte direto — geramos a lista de todas
// as datas do intervalo nesse formato e filtramos com "in".
function gerarDatasIntervalo(dataInicioIso, dataFimIso) {
    const datas = [];
    const atual = new Date(dataInicioIso + 'T00:00:00');
    const fim = new Date(dataFimIso + 'T00:00:00');

    while (atual <= fim) {
        const dia = String(atual.getDate()).padStart(2, '0');
        const mes = String(atual.getMonth() + 1).padStart(2, '0');
        const ano = atual.getFullYear();
        datas.push(`${dia}/${mes}/${ano}`);
        atual.setDate(atual.getDate() + 1);
    }

    return datas;
}

// Lista os lançamentos mais recentes (debug/conferência), ou os de um
// intervalo de datas quando ?dataInicio=AAAA-MM-DD&dataFim=AAAA-MM-DD é
// informado, e/ou de uma turma específica quando ?turma=<codigoTurma> é
// informado (filtros usados na tela de faltas)
async function listar(req, res) {
    try {
        const { dataInicio, dataFim, turma } = req.query;
        const where = {};

        if (dataInicio || dataFim) {
            if (!dataInicio || !dataFim) {
                return res.status(400).json({ status: 'erro', mensagem: 'Informe dataInicio e dataFim juntas, no formato AAAA-MM-DD' });
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim)) {
                return res.status(400).json({ status: 'erro', mensagem: 'Data inválida, use o formato AAAA-MM-DD' });
            }
            where.dataAula = { in: gerarDatasIntervalo(dataInicio, dataFim) };
        }

        if (turma) {
            where.codigoTurma = turma;
        }

        const lancamentos = await prisma.lancamento.findMany({
            where,
            orderBy: { criadoEm: 'desc' },
            take: (dataInicio || turma) ? undefined : 100
        });
        res.json({ status: 'ok', total: lancamentos.length, dados: lancamentos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Lista as turmas distintas já lançadas (código + nome), pra popular o
// dropdown de filtro na tela de faltas
async function listarTurmas(req, res) {
    try {
        const turmas = await prisma.lancamento.findMany({
            where: { codigoTurma: { not: null } },
            distinct: ['codigoTurma'],
            select: { codigoTurma: true, nomeTurma: true },
            orderBy: { codigoTurma: 'asc' }
        });
        res.json({ status: 'ok', dados: turmas });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { receberWebhook, listar, listarTurmas };
