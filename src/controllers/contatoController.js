const prisma = require('../config/prisma');

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

module.exports = { registrar, listarPorAluno, atualizar };
