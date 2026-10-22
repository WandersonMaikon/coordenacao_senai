// A fila de trabalho da coordenação (tela /contatar): quem está em risco e o robô
// do WhatsApp NÃO resolve — precisa de uma pessoa, por ligação, WhatsApp pessoal
// ou presencialmente. É a etapa 3 do funil (docs/visao/VISAO.md).
//
// Não é uma tabela: é calculado na hora a partir do risco, das mensagens
// automáticas, das respostas e dos contatos. Por isso o aluno sai da lista
// sozinho quando volta a ter presença (sai do risco) ou quando alguém registra
// um contato que resolve (RESOLVE_CASO) depois do motivo que o trouxe pra cá.

const prisma = require('../config/prisma');
const {
    calcularAlunosEmRiscoSemRecuperados,
    converterDataAula,
    diaNoFusoDaEscola
} = require('../controllers/alunoController');
const { STATUS_JA_RECEBEU } = require('./whatsappLote');

const DIA_MS = 24 * 60 * 60 * 1000;

// Mensagem automática sem resposta há este tempo vira caso de pessoa. Quando a
// 2ª mensagem existir (etapa 2), é a partir dela que se conta.
const DIAS_SEM_RESPOSTA = 7;

// Contato registrado depois do motivo com um destes status tira o aluno da lista.
// "Sem resposta" e "Não foi possível contatar" não tiram: tentaram e não deu, o
// aluno continua precisando — a linha só passa a mostrar a última tentativa.
const RESOLVE_CASO = ['respondido', 'acompanhar', 'recuperado'];

const MOTIVOS_DELICADOS = ['saude_mental', 'problema_familiar'];

// Por que o aluno está na lista, em ordem de prioridade (1 = primeiro).
const MOTIVOS_LISTA = {
    delicado: { prioridade: 1, rotulo: 'Assunto delicado na resposta' },
    promessa_quebrada: { prioridade: 2, rotulo: 'Prometeu voltar e faltou de novo' },
    respondeu: { prioridade: 3, rotulo: 'Respondeu e precisa de retorno' },
    sem_resposta: { prioridade: 4, rotulo: `Não respondeu a mensagem há ${DIAS_SEM_RESPOSTA} dias ou mais` },
    sair: { prioridade: 5, rotulo: 'Pediu para não receber WhatsApp (SAIR)' },
    sem_whatsapp: { prioridade: 5, rotulo: 'O número não tem WhatsApp' },
    sem_telefone: { prioridade: 5, rotulo: 'Sem telefone cadastrado' }
};

function textoCurto(texto, limite = 200) {
    if (!texto) return null;
    return texto.length > limite ? `${texto.slice(0, limite)}…` : texto;
}

// Classifica um (aluno, turma) em risco. Devolve { motivo, desde, detalhe } ou
// null (o robô ainda está cuidando, ou não há nada que o sistema saiba dizer).
function classificar(item, { aluno, mensagem, resposta, falhou }, agora) {
    if (aluno?.whatsappOptOut) {
        return { motivo: 'sair', desde: resposta?.interpretacao === 'sair' ? resposta.recebidaEm : new Date(converterDataAula(item.primeiraFalta)) };
    }

    if (resposta && resposta.interpretacao !== 'sair') {
        if (resposta.interpretacao === 'promessa') {
            const diaDaPromessa = converterDataAula(diaNoFusoDaEscola(resposta.recebidaEm));
            if (converterDataAula(item.ultimaFalta) <= diaDaPromessa) return null; // aguardando a próxima chamada
            return { motivo: 'promessa_quebrada', desde: resposta.recebidaEm, detalhe: textoCurto(resposta.texto) };
        }
        const motivo = MOTIVOS_DELICADOS.includes(resposta.motivoSugerido) ? 'delicado' : 'respondeu';
        return { motivo, desde: resposta.recebidaEm, detalhe: textoCurto(resposta.texto), motivoSugerido: resposta.motivoSugerido };
    }

    if (mensagem) {
        if (agora - mensagem.enviadaEm.getTime() < DIAS_SEM_RESPOSTA * DIA_MS) return null; // esperando resposta
        return { motivo: 'sem_resposta', desde: mensagem.enviadaEm };
    }

    const inicio = new Date(converterDataAula(item.primeiraFalta));
    if (falhou) return { motivo: 'sem_whatsapp', desde: inicio };
    if (!aluno?.telefone) return { motivo: 'sem_telefone', desde: inicio };
    return null;
}

async function listarPrecisamContato({ turma } = {}, agora = new Date()) {
    const { emRisco } = await calcularAlunosEmRiscoSemRecuperados();
    const candidatos = turma ? emRisco.filter((item) => item.codigoTurma === turma) : emRisco;
    const matriculas = [...new Set(candidatos.map((item) => item.matricula))];
    if (matriculas.length === 0) return [];

    const [alunos, mensagens, respostas, contatos] = await Promise.all([
        prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true, whatsappOptOut: true }
        }),
        prisma.mensagemWhatsapp.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, codigoTurma: true, primeiraFalta: true, status: true, falhaDefinitiva: true, contatoId: true, enviadaEm: true },
            orderBy: { enviadaEm: 'desc' }
        }),
        prisma.respostaWhatsapp.findMany({
            where: { matricula: { in: matriculas }, interpretacao: { notIn: ['ignorada', 'sem_vinculo'] } },
            select: { matricula: true, texto: true, interpretacao: true, motivoSugerido: true, recebidaEm: true },
            orderBy: { recebidaEm: 'desc' }
        }),
        prisma.contato.findMany({
            where: { matricula: { in: matriculas } },
            select: { id: true, matricula: true, status: true, canal: true, contatadoPor: true, criadoEm: true },
            orderBy: { criadoEm: 'desc' }
        })
    ]);

    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));
    // Contato criado pelo envio automático não é contato de uma pessoa: ele vira
    // "respondido" quando o aluno responde, e isso não pode tirar ninguém da lista.
    const contatosDoRobo = new Set(mensagens.map((m) => m.contatoId).filter(Boolean));
    const agoraMs = agora.getTime();

    const porMatricula = new Map();
    for (const item of candidatos) {
        const inicioEpisodio = converterDataAula(item.primeiraFalta);
        const doAluno = mensagens.filter((m) => m.matricula === item.matricula);
        // A mensagem automática mais recente deste sumiço (qualquer turma: o aluno
        // recebe uma por semana, não uma por turma).
        const mensagem = doAluno.find((m) => STATUS_JA_RECEBEU.includes(m.status) && m.enviadaEm && m.enviadaEm.getTime() >= inicioEpisodio) || null;
        const falhou = doAluno.some((m) => m.codigoTurma === item.codigoTurma && m.primeiraFalta === item.primeiraFalta && m.status === 'falhou' && m.falhaDefinitiva);
        const resposta = mensagem
            ? respostas.find((r) => r.matricula === item.matricula && r.recebidaEm.getTime() >= mensagem.enviadaEm.getTime()) || null
            : null;

        const caso = classificar(item, { aluno: alunoPorMatricula.get(item.matricula), mensagem, resposta, falhou }, agoraMs);
        if (!caso) continue;

        // Contato de uma pessoa depois do motivo: resolve ou é só uma tentativa.
        const contatoHumano = contatos.find((c) =>
            c.matricula === item.matricula && !contatosDoRobo.has(c.id) && c.criadoEm.getTime() >= new Date(caso.desde).getTime());
        if (contatoHumano && RESOLVE_CASO.includes(contatoHumano.status)) continue;

        const linha = {
            matricula: item.matricula,
            nomeAluno: item.nomeAluno,
            telefone: alunoPorMatricula.get(item.matricula)?.telefone || null,
            motivo: caso.motivo,
            prioridade: MOTIVOS_LISTA[caso.motivo].prioridade,
            rotulo: MOTIVOS_LISTA[caso.motivo].rotulo,
            desde: caso.desde,
            detalhe: caso.detalhe || null,
            motivoSugerido: caso.motivoSugerido || null,
            ultimaTentativa: contatoHumano
                ? { em: contatoHumano.criadoEm, por: contatoHumano.contatadoPor, status: contatoHumano.status, canal: contatoHumano.canal }
                : null,
            turmas: [{ codigoTurma: item.codigoTurma, nomeTurma: item.nomeTurma, diasSemVir: item.diasSemVir, primeiraFalta: item.primeiraFalta }]
        };

        // Uma linha por aluno: em risco em duas turmas, fica o motivo mais urgente
        // e as turmas juntas.
        const atual = porMatricula.get(item.matricula);
        if (!atual) porMatricula.set(item.matricula, linha);
        else {
            const turmas = [...atual.turmas, ...linha.turmas];
            porMatricula.set(item.matricula, { ...(linha.prioridade < atual.prioridade ? linha : atual), turmas });
        }
    }

    // Mais urgente primeiro; dentro da mesma prioridade, quem espera há mais tempo.
    return [...porMatricula.values()].sort((a, b) =>
        a.prioridade - b.prioridade || new Date(a.desde) - new Date(b.desde));
}

module.exports = { listarPrecisamContato, MOTIVOS_LISTA, DIAS_SEM_RESPOSTA, RESOLVE_CASO };
