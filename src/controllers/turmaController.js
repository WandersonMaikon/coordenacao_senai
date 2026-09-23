const prisma = require('../config/prisma');

// Não existe tabela de turma: turma é o par (codigoTurma, nomeTurma) que o
// userscript grava em `lancamentos`. Este controller concentra o que o sistema
// sabe sobre turma — listar as que existem e marcar as que acabaram.

// Códigos das turmas encerradas pela coordenação. Devolve um Set porque quem
// consome só pergunta "esta turma está encerrada?" — mesmo padrão de
// listarCasosResolvidos() no alunoController.
async function carregarTurmasEncerradas() {
    const encerradas = await prisma.turmaEncerrada.findMany({ select: { codigoTurma: true } });
    return new Set(encerradas.map((item) => item.codigoTurma));
}

// GET /turmas — turmas distintas já lançadas (código + nome), pra popular os
// dropdowns de filtro das telas. Turma encerrada fica de fora por padrão; a tela
// pede ?incluirEncerradas=1 quando o usuário marca "incluir turmas encerradas"
// (o histórico continua consultável, só não atrapalha o dia a dia).
async function listarTurmas(req, res) {
    try {
        const incluirEncerradas = req.query.incluirEncerradas === '1';
        const [turmas, encerradas] = await Promise.all([
            prisma.lancamento.findMany({
                where: { codigoTurma: { not: null } },
                distinct: ['codigoTurma'],
                select: { codigoTurma: true, nomeTurma: true },
                orderBy: { codigoTurma: 'asc' }
            }),
            carregarTurmasEncerradas()
        ]);

        const dados = turmas
            .map((turma) => ({ ...turma, encerrada: encerradas.has(turma.codigoTurma) }))
            .filter((turma) => incluirEncerradas || !turma.encerrada);

        res.json({ status: 'ok', dados });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// GET /turmas-encerradas — as encerradas, com quem encerrou e quando (a tela do
// painel lista pra permitir reabrir).
async function listarEncerradas(req, res) {
    try {
        const turmas = await prisma.turmaEncerrada.findMany({ orderBy: { criadoEm: 'desc' } });
        res.json({ status: 'ok', total: turmas.length, dados: turmas });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// POST /turmas-encerradas — encerra a turma. Nada é apagado: os lançamentos e os
// contatos continuam no banco. A turma sai do risco, do painel, da lista de
// faltas e do WhatsApp até alguém reabrir.
async function encerrarTurma(req, res) {
    try {
        const { codigoTurma, nomeTurma, motivo, observacao } = req.body;
        if (!codigoTurma) {
            return res.status(400).json({ status: 'erro', mensagem: 'Informe a turma' });
        }

        // Mesma checagem de whatsappController.assumirTurma: turma só existe se
        // tem lançamento. Código digitado errado vira 404, não uma linha órfã.
        const existe = await prisma.lancamento.findFirst({ where: { codigoTurma }, select: { nomeTurma: true } });
        if (!existe) return res.status(404).json({ status: 'erro', mensagem: 'Turma não encontrada' });

        const turma = await prisma.turmaEncerrada.upsert({
            where: { codigoTurma },
            update: {
                nomeTurma: nomeTurma || existe.nomeTurma || null,
                motivo: motivo || null,
                observacao: observacao || null,
                encerradaPor: req.usuario.usuario
            },
            create: {
                codigoTurma,
                nomeTurma: nomeTurma || existe.nomeTurma || null,
                motivo: motivo || null,
                observacao: observacao || null,
                encerradaPor: req.usuario.usuario
            }
        });

        // A turma sai do WhatsApp junto: quem estava na fila por causa dela não
        // deve receber cobrança de falta de um curso que acabou. Mesmas escritas
        // de whatsappController.liberarTurma, feitas direto aqui pra não criar
        // dependência entre os dois controllers.
        const canceladas = await prisma.mensagemWhatsapp.updateMany({
            where: { codigoTurma, status: 'pendente' },
            data: { status: 'cancelada', erro: `Turma encerrada por ${req.usuario.usuario}` }
        });
        await prisma.usuarioTurma.deleteMany({ where: { codigoTurma } });

        res.json({
            status: 'ok',
            mensagem: canceladas.count
                ? `Turma encerrada. ${canceladas.count} mensagem(ns) na fila do WhatsApp foram canceladas.`
                : 'Turma encerrada. O histórico continua guardado.',
            dados: turma
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// DELETE /turmas-encerradas/:codigoTurma — reabre. A turma volta a ser avaliada
// normalmente: quem estiver com sequência de faltas em aberto reaparece sozinho
// na /risco. O responsável no WhatsApp não volta — quem quiser assume de novo.
async function reabrirTurma(req, res) {
    try {
        const { codigoTurma } = req.params;
        const turma = await prisma.turmaEncerrada.findUnique({ where: { codigoTurma } });
        if (!turma) return res.status(404).json({ status: 'erro', mensagem: 'Esta turma não está encerrada.' });

        await prisma.turmaEncerrada.delete({ where: { id: turma.id } });
        res.json({ status: 'ok', mensagem: 'Turma reaberta. Ela volta a aparecer no risco e nas faltas.' });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { carregarTurmasEncerradas, listarTurmas, listarEncerradas, encerrarTurma, reabrirTurma };
