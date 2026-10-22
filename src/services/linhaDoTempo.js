// Linha do tempo de um aluno (detalhe da tela /risco): o que o robô do WhatsApp
// fez, o que o aluno respondeu, o que a coordenação registrou e o que a chamada
// mostrou, tudo em ordem. É a etapa 5 do funil (docs/visao/VISAO.md) — quem abre
// o aluno vê a sequência inteira antes de ligar.
//
// Só leitura, montada na hora a partir das tabelas que já existem. O histórico
// de contatos editável continua sendo o de GET /contatos.

const prisma = require('../config/prisma');
const { converterDataAula } = require('../controllers/alunoController');
const { MOTIVOS } = require('../config/motivos');

const DIA_MS = 24 * 60 * 60 * 1000;

// Até onde olhar pra trás: o WhatsApp mais antigo dos últimos 60 dias (mesma
// janela em que uma resposta ainda é ligada à mensagem), com uma semana antes
// dele — é o que mostra as faltas que levaram à mensagem.
const DIAS_JANELA = 60;
const DIAS_ANTES_DA_MENSAGEM = 7;

const ROTULO_MOTIVO = Object.fromEntries(MOTIVOS.map((m) => [m.chave, m.rotulo]));

function descreverResposta(resposta) {
    switch (resposta.interpretacao) {
        case 'promessa': return 'Disse que vem na próxima aula — o robô respondeu "Combinado!"';
        case 'sair': return 'Pediu SAIR: não recebe mais mensagens automáticas';
        case 'nao_entendido': return 'O sistema não identificou o motivo';
        default: return resposta.motivoSugerido ? `Motivo sugerido: ${ROTULO_MOTIVO[resposta.motivoSugerido] || resposta.motivoSugerido}` : null;
    }
}

async function montarLinhaDoTempo(matricula, agora = new Date()) {
    const desde = new Date(agora.getTime() - DIAS_JANELA * DIA_MS);
    const mensagens = await prisma.mensagemWhatsapp.findMany({
        where: { matricula, OR: [{ enviadaEm: { gte: desde } }, { atualizadoEm: { gte: desde } }] },
        select: { id: true, codigoTurma: true, nomeTurma: true, tentativa: true, status: true, erro: true, contatoId: true, enviadaEm: true, criadoEm: true, atualizadoEm: true, usuarioId: true }
    });
    if (mensagens.length === 0) return { eventos: [] };

    const primeira = Math.min(...mensagens.map((m) => (m.enviadaEm || m.criadoEm).getTime()));
    const inicio = new Date(primeira - DIAS_ANTES_DA_MENSAGEM * DIA_MS);

    const [respostas, contatos, lancamentos, usuarios] = await Promise.all([
        prisma.respostaWhatsapp.findMany({
            where: { matricula, recebidaEm: { gte: inicio }, interpretacao: { notIn: ['ignorada', 'sem_vinculo'] } },
            select: { id: true, texto: true, interpretacao: true, motivoSugerido: true, recebidaEm: true }
        }),
        prisma.contato.findMany({
            where: { matricula, criadoEm: { gte: inicio } },
            select: { id: true, canal: true, status: true, motivo: true, observacao: true, contatadoPor: true, criadoEm: true }
        }),
        prisma.lancamento.findMany({
            where: { matricula },
            select: { dataAula: true, codigoTurma: true, nomeTurma: true, qtdFaltas: true }
        }),
        prisma.usuario.findMany({
            where: { id: { in: [...new Set(mensagens.map((m) => m.usuarioId))] } },
            select: { id: true, usuario: true, nome: true }
        })
    ]);

    const nomeUsuario = new Map(usuarios.map((u) => [u.id, u.nome || u.usuario]));
    // O contato criado pelo envio já está representado pela própria mensagem.
    const contatosDoRobo = new Set(mensagens.map((m) => m.contatoId).filter(Boolean));
    const eventos = [];

    for (const m of mensagens) {
        eventos.push({
            tipo: 'whatsapp',
            em: m.enviadaEm || m.atualizadoEm,
            tentativa: m.tentativa,
            status: m.status,
            erro: ['falhou', 'cancelada'].includes(m.status) ? m.erro : null,
            por: nomeUsuario.get(m.usuarioId) || null,
            codigoTurma: m.codigoTurma,
            nomeTurma: m.nomeTurma
        });
    }

    for (const r of respostas) {
        eventos.push({ tipo: 'resposta', em: r.recebidaEm, texto: r.texto, interpretacao: r.interpretacao, descricao: descreverResposta(r) });
    }

    for (const c of contatos) {
        if (contatosDoRobo.has(c.id)) continue;
        eventos.push({
            tipo: 'contato',
            em: c.criadoEm,
            canal: c.canal,
            status: c.status,
            motivo: c.motivo ? ROTULO_MOTIVO[c.motivo] || c.motivo : null,
            observacao: c.observacao,
            por: c.contatadoPor
        });
    }

    // Chamada: um evento por (dia, turma), com a mesma regra do risco — presença
    // em qualquer UC conta o dia inteiro como presença.
    const porDia = new Map();
    for (const l of lancamentos) {
        const ms = converterDataAula(l.dataAula);
        if (ms < inicio.getTime() - DIA_MS) continue;
        const chave = `${l.dataAula}|${l.codigoTurma}`;
        if (!porDia.has(chave)) porDia.set(chave, { ms, dataAula: l.dataAula, codigoTurma: l.codigoTurma, nomeTurma: l.nomeTurma, faltas: 0, presente: false });
        const dia = porDia.get(chave);
        dia.faltas += l.qtdFaltas || 0;
        if (!l.qtdFaltas) dia.presente = true;
    }
    for (const dia of porDia.values()) {
        // Meio-dia do dia de aula: a hora da aula não é conhecida, e assim a
        // chamada fica no meio dos eventos do mesmo dia.
        eventos.push({
            tipo: 'chamada',
            em: new Date(dia.ms + DIA_MS / 2),
            dataAula: dia.dataAula,
            presente: dia.presente,
            faltas: dia.faltas,
            codigoTurma: dia.codigoTurma,
            nomeTurma: dia.nomeTurma
        });
    }

    eventos.sort((a, b) => new Date(a.em) - new Date(b.em));
    const turmas = new Set(eventos.filter((e) => e.codigoTurma).map((e) => e.codigoTurma));
    return { eventos, variasTurmas: turmas.size > 1 };
}

module.exports = { montarLinhaDoTempo };
