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
            // A UC faz parte da chave: uma turma pode ter dois professores lançando
            // no mesmo dia, e sem a UC o segundo envio sobrescreveria a falta do
            // primeiro. Com ela, cada UC vira uma linha e as faltas do dia somam.
            const chave = {
                matricula: item.matricula || '',
                dataAula: item.data_aula || '',
                codigoTurma: item.codigo_turma || '',
                uc: item.uc || ''
            };

            // upsert: se o professor corrigir um lançamento (ex: desmarcar uma falta
            // indevida e salvar de novo), a chave já existe e o registro é atualizado
            // em vez de ignorado como duplicata. Só o lançamento daquela UC é tocado —
            // o do outro professor no mesmo dia fica intacto.
            const resultado = await prisma.lancamento.upsert({
                where: { chave_idempotencia: chave },
                update: {
                    nomeAluno: item.nome_aluno || '',
                    idAula: item.id_aula || '',
                    nomeTurma: item.nome_turma || '',
                    periodoLetivo: item.periodo_letivo || '',
                    professor: item.professor || '',
                    qtdFaltas: item.qtd_faltas ?? 0,
                    // Userscript anterior à v4.1 não manda qtd_aulas. `null` mantém o
                    // dia fora do cálculo de frequência em vez de fingir que houve
                    // zero aula — e um envio antigo não apaga o valor de um dia que
                    // já tinha sido gravado por um script atualizado.
                    ...(item.qtd_aulas != null ? { qtdAulas: item.qtd_aulas } : {})
                },
                create: {
                    ...chave,
                    nomeAluno: item.nome_aluno || '',
                    idAula: item.id_aula || '',
                    nomeTurma: item.nome_turma || '',
                    periodoLetivo: item.periodo_letivo || '',
                    professor: item.professor || '',
                    qtdFaltas: item.qtd_faltas ?? 1,
                    qtdAulas: item.qtd_aulas ?? null
                }
            });

            // criadoEm === atualizadoEm só na criação (ambos recebem o mesmo timestamp)
            if (resultado.criadoEm.getTime() === resultado.atualizadoEm.getTime()) {
                inseridos++;
            } else {
                corrigidos++;
                console.log(`[Webhook] Corrigido: ${item.matricula} / ${item.data_aula} / ${item.uc || '(sem UC)'} -> qtd_faltas=${resultado.qtdFaltas}`);
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
            take: (dataInicio || turma) ? undefined : 100,
            include: { aluno: { select: { telefone: true } } }
        });
        res.json({ status: 'ok', total: lancamentos.length, dados: lancamentos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Frequência mínima para aprovação. Abaixo disso o aluno reprova por falta,
// mesmo com nota — é a régua que a tela de Frequência usa pra destacar quem
// está no limite. Confirmar com a coordenação se o SENAI usa outro percentual.
const FREQUENCIA_MINIMA = 75;

// Relatório consolidado de frequência por turma no período — o que o SGE não
// entrega. Complementa a tela de Alunos em risco, que enxerga só abandono
// (faltas seguidas): aqui aparece o faltante crônico, o que perde uma aula por
// semana o semestre inteiro, nunca acumula dias seguidos e reprova por falta
// sem nunca ter entrado na lista de risco.
async function frequencia(req, res) {
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
            select: {
                matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true,
                dataAula: true, uc: true, professor: true, qtdFaltas: true, qtdAulas: true
            }
        });

        const turmas = new Map();
        // Lançamentos anteriores à v4.1 do userscript não têm qtdAulas. Ficam fora
        // do cálculo (não dá pra inventar o denominador) e são contados à parte,
        // pra tela poder avisar que o período não está coberto por inteiro.
        let diasSemTotalDeAulas = 0;

        for (const item of lancamentos) {
            const codigo = item.codigoTurma || '—';
            if (!turmas.has(codigo)) {
                turmas.set(codigo, {
                    codigoTurma: codigo,
                    nomeTurma: item.nomeTurma || codigo,
                    professores: new Set(),
                    // Cada (dia + UC) é uma aula lançada. O total de aulas do período
                    // é somado sobre essas chaves, não sobre os lançamentos: cada
                    // aluno gera uma linha do mesmo dia, e somar linha por linha
                    // multiplicaria o total de aulas pelo tamanho da turma.
                    aulasPorChave: new Map(),
                    alunos: new Map()
                });
            }
            const dadosTurma = turmas.get(codigo);
            if (item.professor) dadosTurma.professores.add(item.professor);

            if (item.qtdAulas == null) {
                diasSemTotalDeAulas++;
                continue;
            }

            dadosTurma.aulasPorChave.set(`${item.dataAula}|${item.uc}`, item.qtdAulas);

            const matricula = item.matricula || '—';
            if (!dadosTurma.alunos.has(matricula)) {
                dadosTurma.alunos.set(matricula, { matricula, nomeAluno: item.nomeAluno || '—', faltas: 0, aulas: 0 });
            }
            const aluno = dadosTurma.alunos.get(matricula);
            aluno.faltas += item.qtdFaltas || 0;
            aluno.aulas += item.qtdAulas;
        }

        const matriculas = [...turmas.values()].flatMap((dadosTurma) => [...dadosTurma.alunos.keys()]);
        const alunosCadastrados = await prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true }
        });
        const telefonePorMatricula = new Map(alunosCadastrados.map((aluno) => [aluno.matricula, aluno.telefone]));

        const dados = [...turmas.values()].map((dadosTurma) => {
            const totalAulas = [...dadosTurma.aulasPorChave.values()].reduce((soma, aulas) => soma + aulas, 0);

            const alunos = [...dadosTurma.alunos.values()]
                .map((aluno) => ({
                    ...aluno,
                    telefone: telefonePorMatricula.get(aluno.matricula) || null,
                    // A frequência é sobre as aulas em que o aluno aparece lançado,
                    // não sobre o total da turma: quem entrou na turma depois não
                    // pode ser penalizado pelas aulas anteriores à matrícula dele.
                    frequencia: aluno.aulas > 0 ? Math.round(((aluno.aulas - aluno.faltas) / aluno.aulas) * 1000) / 10 : null
                }))
                .sort((a, b) => (a.frequencia ?? 101) - (b.frequencia ?? 101));

            const somaAulas = alunos.reduce((soma, aluno) => soma + aluno.aulas, 0);
            const somaFaltas = alunos.reduce((soma, aluno) => soma + aluno.faltas, 0);

            return {
                codigoTurma: dadosTurma.codigoTurma,
                nomeTurma: dadosTurma.nomeTurma,
                professores: [...dadosTurma.professores],
                totalAulas,
                totalAlunos: alunos.length,
                abaixoDoMinimo: alunos.filter((aluno) => aluno.frequencia !== null && aluno.frequencia < FREQUENCIA_MINIMA).length,
                frequenciaTurma: somaAulas > 0 ? Math.round(((somaAulas - somaFaltas) / somaAulas) * 1000) / 10 : null,
                alunos
            };
        })
            .filter((dadosTurma) => dadosTurma.totalAulas > 0)
            .sort((a, b) => (a.frequenciaTurma ?? 101) - (b.frequenciaTurma ?? 101));

        res.json({
            status: 'ok',
            total: dados.length,
            frequenciaMinima: FREQUENCIA_MINIMA,
            diasSemTotalDeAulas,
            dados
        });
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

module.exports = { receberWebhook, listar, listarTurmas, frequencia, FREQUENCIA_MINIMA };
