const prisma = require('../config/prisma');
const { MOTIVOS } = require('../config/motivos');

// Registra um contato feito pela coordenação com um aluno (em risco ou não).
// Faz upsert do Aluno antes, porque a FK exige que ele exista e nem todo aluno
// com falta lançada já teve o telefone importado (ver alunoController.importarTelefones).
async function registrar(req, res) {
    const { matricula, nomeAluno, canal, status, motivo, observacao } = req.body;

    if (!matricula || !canal || !status) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe matricula, canal e status' });
    }

    try {
        await prisma.aluno.upsert({
            where: { matricula },
            update: {},
            create: { matricula, nome: nomeAluno || null }
        });

        const contato = await prisma.contato.create({
            data: {
                matricula,
                canal,
                status,
                motivo: motivo || null,
                observacao: observacao || null,
                contatadoPor: req.usuario.usuario
            }
        });

        res.json({ status: 'ok', dados: contato });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Histórico de contatos de um aluno, mais recente primeiro
async function listarPorAluno(req, res) {
    const { matricula } = req.query;

    if (!matricula) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe matricula' });
    }

    try {
        const contatos = await prisma.contato.findMany({
            where: { matricula },
            orderBy: { criadoEm: 'desc' }
        });
        res.json({ status: 'ok', dados: contatos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Corrige um contato já registrado (a coordenação anota na hora da ligação e
// às vezes precisa ajustar o status ou o motivo depois). Só os campos do
// atendimento são editáveis: matricula, contatadoPor e criadoEm ficam como
// estão — quem registrou e quando são o histórico em si, não conteúdo.
// Só o autor do contato pode editar (ver checagem abaixo).
async function atualizar(req, res) {
    const id = Number(req.params.id);
    const { canal, status, motivo, observacao } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'erro', mensagem: 'Id de contato inválido' });
    }

    if (!canal || !status) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe canal e status' });
    }

    try {
        // Mesma regra do apagar: só quem registrou pode corrigir. Editar o
        // contato de outra pessoa mudaria o que ela anotou mantendo o nome dela
        // no registro.
        const existente = await prisma.contato.findUnique({ where: { id }, select: { contatadoPor: true } });

        if (!existente) {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }

        if (existente.contatadoPor !== req.usuario.usuario) {
            return res.status(403).json({ status: 'erro', mensagem: 'Só quem registrou o contato pode editá-lo' });
        }

        const contato = await prisma.contato.update({
            where: { id },
            data: {
                canal,
                status,
                motivo: motivo || null,
                observacao: observacao || null
            }
        });

        res.json({ status: 'ok', dados: contato });
    } catch (erro) {
        // P2025 = registro não encontrado (id que não existe ou já removido)
        if (erro.code === 'P2025') {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// POST /contatos/:id/confirmar-motivo — confirma (ou corrige) a sugestão de
// motivo que veio da resposta do aluno no WhatsApp. Grava em `motivo` e limpa
// `motivoSugerido`: a partir daí o contato passa a contar no gráfico do painel.
//
// Endpoint próprio, e não o PUT acima, por uma razão concreta: o PUT só deixa
// quem registrou editar, e nesses contatos `contatadoPor` é o dono do número de
// WhatsApp que disparou a mensagem. Sem isto, ninguém além dele conseguiria
// confirmar. Aqui vale a regra do POST /contatos: qualquer usuário logado — não
// se está editando a anotação de outra pessoa, se está completando uma sugestão
// da máquina. Quem confirmou fica na observação, pro histórico não se perder.
async function confirmarMotivo(req, res) {
    const id = Number(req.params.id);
    const { motivo } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'erro', mensagem: 'Id de contato inválido' });
    }
    if (!motivo) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe o motivo' });
    }
    if (!MOTIVOS.some((item) => item.chave === motivo)) {
        return res.status(400).json({ status: 'erro', mensagem: 'Motivo desconhecido' });
    }

    try {
        const existente = await prisma.contato.findUnique({ where: { id } });
        if (!existente) {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }
        if (!existente.motivoSugerido) {
            return res.status(409).json({ status: 'erro', mensagem: 'Este contato não tem motivo sugerido para confirmar' });
        }

        const confirmou = motivo === existente.motivoSugerido ? 'confirmado' : 'corrigido';
        const contato = await prisma.contato.update({
            where: { id },
            data: {
                motivo,
                motivoSugerido: null,
                sugeridoPor: null,
                observacao: `${existente.observacao || ''}\n[Motivo ${confirmou} por ${req.usuario.usuario}]`.trim()
            }
        });

        res.json({ status: 'ok', mensagem: `Motivo ${confirmou}.`, dados: contato });
    } catch (erro) {
        if (erro.code === 'P2025') {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Apaga um contato do histórico. Só quem registrou pode apagar — nem outro
// usuário, nem o admin: o histórico é o que mostra que a coordenação foi atrás
// do aluno, e apagar o registro de outra pessoa sumiria com esse rastro. A
// checagem é aqui no servidor (e não só escondendo o botão na tela), porque a
// API pode ser chamada direto.
async function remover(req, res) {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ status: 'erro', mensagem: 'Id de contato inválido' });
    }

    try {
        const contato = await prisma.contato.findUnique({ where: { id }, select: { contatadoPor: true } });

        if (!contato) {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }

        if (contato.contatadoPor !== req.usuario.usuario) {
            return res.status(403).json({ status: 'erro', mensagem: 'Só quem registrou o contato pode apagá-lo' });
        }

        await prisma.contato.delete({ where: { id } });
        res.json({ status: 'ok' });
    } catch (erro) {
        if (erro.code === 'P2025') {
            return res.status(404).json({ status: 'erro', mensagem: 'Contato não encontrado' });
        }
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Quantos contatos foram registrados com cada motivo de falta — alimenta o
// gráfico do painel. É o dado que responde "por que os alunos estão faltando",
// e não só "quantos faltaram": o motivo só existe porque alguém da coordenação
// falou com o aluno e anotou.
//
// De propósito, este é o único lugar que **não** esconde turma encerrada: o
// gráfico é o histórico acumulado de por que os alunos faltam, e descartar as
// turmas que acabaram reescreveria esse histórico a cada semestre.
async function resumoMotivos(req, res) {
    try {
        const { turma } = req.query;

        // A tabela `contatos` não guarda turma (nem `alunos`): o vínculo sai dos
        // lançamentos, mesma regra do /alunos/resumo — quem teve chamada lançada
        // naquela turma é aluno dela.
        let filtroMatricula;
        if (turma) {
            const matriculas = await prisma.lancamento.findMany({
                where: { codigoTurma: turma },
                select: { matricula: true },
                distinct: ['matricula']
            });
            filtroMatricula = { matricula: { in: matriculas.map((item) => item.matricula) } };
        }

        const grupos = await prisma.contato.groupBy({
            by: ['motivo'],
            _count: { _all: true },
            where: filtroMatricula
        });

        // Contato sem motivo preenchido vira "outro": a coordenação nem sempre
        // descobre o motivo (aluno não respondeu), e sumir com esses registros
        // faria o gráfico dizer que todo contato rendeu uma explicação.
        const totalPorMotivo = new Map();
        for (const grupo of grupos) {
            const motivo = grupo.motivo || 'outro';
            totalPorMotivo.set(motivo, (totalPorMotivo.get(motivo) || 0) + grupo._count._all);
        }

        const dados = [...totalPorMotivo.entries()]
            .map(([motivo, total]) => ({ motivo, total }))
            .sort((a, b) => b.total - a.total);

        res.json({
            status: 'ok',
            total: dados.reduce((soma, item) => soma + item.total, 0),
            dados
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { registrar, listarPorAluno, atualizar, confirmarMotivo, remover, resumoMotivos };
