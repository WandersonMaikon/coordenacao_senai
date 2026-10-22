// Envio automático: o "número do sistema" (um chip da escola) manda a mensagem
// sozinho para os alunos que entram em risco, sem ninguém assumir turma nem
// clicar em "Iniciar envio" — é o funil de docs/visao/VISAO.md.
//
// Como funciona: o número marcado com `envioAutomatico` tem um lote permanente
// (`LoteWhatsapp.automatico`). A cada ABASTECER_MS o worker chama `abastecer`,
// que recalcula quem está em risco e coloca na fila quem ainda não recebeu. O
// envio em si continua sendo o do worker (whatsappEnvio.js), com os mesmos
// limites contra bloqueio — esta peça só decide QUEM entra na fila.
//
// `avaliar` também alimenta a tela de acompanhamento: cada aluno em risco sai com
// a sua situação (enviada, na fila, por que não recebe), e é dela que vêm os
// números "X% já receberam".

const prisma = require('../config/prisma');
const {
    calcularAlunosEmRiscoSemRecuperados,
    ehSituacaoAtiva,
    converterDataAula,
    diaNoFusoDaEscola
} = require('../controllers/alunoController');
const { renderizarMensagem, nomeResponsavel, STATUS_JA_RECEBEU, MENSAGEM_SEGUNDA } = require('./whatsappLote');

const DIA_MS = 24 * 60 * 60 * 1000;

// No máximo uma mensagem automática por aluno a cada 7 dias, mesmo que ele esteja
// em risco em duas turmas.
const DIAS_ENTRE_MENSAGENS = 7;

// A 2ª (e última) mensagem automática sai este tempo depois da 1ª, se o aluno não
// respondeu nada e continua faltando. Depois dela o robô para: o caso vai para
// "Precisam de contato" (precisamContato.js).
const DIAS_PARA_SEGUNDA = 7;

// Contato da coordenação (respondido/acompanhar) nos últimos 7 dias impede o
// WhatsApp: alguém está falando com o aluno. Passados 7 dias e ele continua
// faltando, o WhatsApp volta a valer — decidido em 22/10/2026. Também não há
// mais corte por "entrou em risco há muito tempo": quem já estava em risco
// quando a chave foi ligada recebe, e o limite diário espalha o acúmulo.
const DIAS_DESDE_CONTATO = 7;

// Contato com um destes status não impede o WhatsApp em momento nenhum: tentaram
// ligar e não conseguiram, então a mensagem é uma tentativa por outro canal.
const STATUS_CONTATO_NOVA_TENTATIVA = ['sem_resposta', 'nunca_contato'];

// Situação de cada aluno em risco, do ponto de vista do envio automático. A ordem
// importa: aluno em risco em duas turmas é contado uma vez, pela situação que
// aparecer primeiro aqui.
const SITUACOES = {
    enviada: 'Mensagem enviada',
    fila: 'Na fila de envio',
    receber: 'Entra na fila na próxima conferência',
    contato_humano: `A coordenação falou com o aluno nos últimos ${DIAS_DESDE_CONTATO} dias`,
    sair: 'Pediu para não receber mensagens (SAIR)',
    sem_whatsapp: 'O envio falhou (número sem WhatsApp ou envio interrompido)',
    sem_telefone: 'Sem telefone cadastrado',
    situacao: 'Situação na planilha não é ativa',
    semana: 'Já recebeu mensagem por outra turma nesta semana'
};
const ORDEM_SITUACAO = Object.keys(SITUACOES);

// Turmas do piloto (null = todas). Guardado como JSON no próprio número.
function lerTurmas(sessao) {
    try {
        const lista = JSON.parse(sessao.turmasAutomatico || 'null');
        return Array.isArray(lista) && lista.length ? lista : null;
    } catch (erro) {
        return null;
    }
}

async function sessaoDoSistema() {
    return prisma.whatsappSessao.findFirst({ where: { envioAutomatico: true }, include: { usuario: true } });
}

async function loteAutomatico(sessaoId) {
    return prisma.loteWhatsapp.findFirst({ where: { sessaoId, automatico: true, status: 'em_andamento' } });
}

function chaveEpisodio(item) {
    return `${item.matricula}|${item.codigoTurma}|${item.primeiraFalta}`;
}

// Uma linha por (aluno, turma) em risco nas turmas do envio, com a `situacao`.
async function avaliar(sessao, agora = new Date()) {
    const turmas = lerTurmas(sessao);
    const { emRisco } = await calcularAlunosEmRiscoSemRecuperados();
    const candidatos = turmas ? emRisco.filter((item) => turmas.includes(item.codigoTurma)) : emRisco;
    const matriculas = [...new Set(candidatos.map((item) => item.matricula))];

    const [alunos, contatos, mensagens] = await Promise.all([
        prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true, situacao: true, whatsappOptOut: true }
        }),
        prisma.contato.findMany({
            where: { matricula: { in: matriculas } },
            select: { id: true, matricula: true, criadoEm: true, status: true },
            orderBy: { criadoEm: 'desc' }
        }),
        prisma.mensagemWhatsapp.findMany({
            where: { matricula: { in: matriculas } },
            select: { id: true, matricula: true, codigoTurma: true, primeiraFalta: true, tentativa: true, status: true, falhaDefinitiva: true, contatoId: true, enviadaEm: true }
        })
    ]);

    // A última resposta de cada mensagem: se for promessa de voltar, a chamada
    // seguinte diz se ele cumpriu. Vale a ÚLTIMA — quem escreveu "amanhã vou" e
    // depois "não vai dar" não prometeu nada.
    const respostas = await prisma.respostaWhatsapp.findMany({
        where: { mensagemId: { in: mensagens.map((m) => m.id) }, interpretacao: { not: 'ignorada' } },
        select: { mensagemId: true, interpretacao: true, recebidaEm: true },
        orderBy: { recebidaEm: 'desc' }
    });
    const ultimaRespostaPorMensagem = new Map();
    for (const resposta of respostas) {
        if (!ultimaRespostaPorMensagem.has(resposta.mensagemId)) ultimaRespostaPorMensagem.set(resposta.mensagemId, resposta);
    }

    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));
    const statusContatoPorId = new Map(contatos.map((c) => [c.id, c.status]));
    const ultimoContatoPorMatricula = new Map();
    for (const contato of contatos) {
        if (!ultimoContatoPorMatricula.has(contato.matricula)) ultimoContatoPorMatricula.set(contato.matricula, contato);
    }
    const mensagemPorEpisodio = new Map(mensagens.map((m) => [`${chaveEpisodio(m)}|${m.tentativa}`, m]));

    // Quem já recebeu (ou está na fila) nos últimos 7 dias, por qualquer turma.
    const desdeMs = agora.getTime() - DIAS_ENTRE_MENSAGENS * DIA_MS;
    const recebeuNaSemana = new Set(mensagens
        .filter((m) => ['pendente', 'enviando'].includes(m.status) || (STATUS_JA_RECEBEU.includes(m.status) && m.enviadaEm?.getTime() >= desdeMs))
        .map((m) => m.matricula));

    const contatoDesdeMs = agora.getTime() - DIAS_DESDE_CONTATO * DIA_MS;

    // Quem está há mais dias sem vir é avaliado (e entra na fila) primeiro.
    const ordenados = [...candidatos].sort((a, b) => b.diasSemVir - a.diasSemVir);
    return ordenados.map((item) => {
        const aluno = alunoPorMatricula.get(item.matricula);
        const ultimoContato = ultimoContatoPorMatricula.get(item.matricula);
        const contatoRecente = ultimoContato && ultimoContato.criadoEm.getTime() >= contatoDesdeMs ? ultimoContato : null;
        const primeira = mensagemPorEpisodio.get(`${chaveEpisodio(item)}|1`);
        const segunda = mensagemPorEpisodio.get(`${chaveEpisodio(item)}|2`);
        const recebeu = (m) => Boolean(m) && STATUS_JA_RECEBEU.includes(m.status);
        const naFila = (m) => Boolean(m) && ['pendente', 'enviando'].includes(m.status);
        // A resposta mais recente a qualquer uma das duas mensagens.
        const resposta = [segunda, primeira]
            .map((m) => m && ultimaRespostaPorMensagem.get(m.id))
            .filter(Boolean)
            .sort((a, b) => b.recebidaEm - a.recebidaEm)[0] || null;
        // O que impede uma mensagem (1ª ou 2ª) de sair, na ordem em que a tela explica.
        const impedimento = () => {
            if (!aluno || !aluno.telefone) return 'sem_telefone';
            if (!ehSituacaoAtiva(aluno.situacao)) return 'situacao';
            if (aluno.whatsappOptOut) return 'sair';
            if (contatoRecente && !STATUS_CONTATO_NOVA_TENTATIVA.includes(contatoRecente.status)) return 'contato_humano';
            if (recebeuNaSemana.has(item.matricula)) return 'semana';
            return null;
        };

        let situacao;
        let tentativa = 1;
        if (naFila(primeira) || naFila(segunda)) situacao = 'fila';
        else if (recebeu(segunda) || (segunda?.status === 'falhou' && segunda.falhaDefinitiva)) situacao = 'enviada';
        else if (recebeu(primeira)) {
            // Só a 1ª saiu. A 2ª entra se ele não respondeu nada, já passou o prazo
            // e nada mais impede (inclusive alguém da coordenação ter falado com ele).
            const prazo = agora.getTime() - primeira.enviadaEm.getTime() >= DIAS_PARA_SEGUNDA * DIA_MS;
            situacao = !resposta && prazo && !impedimento() ? 'receber' : 'enviada';
            if (situacao === 'receber') tentativa = 2;
        } else if (primeira?.status === 'falhou' && primeira.falhaDefinitiva) situacao = 'sem_whatsapp';
        else situacao = impedimento() || 'receber';
        if (situacao === 'receber') recebeuNaSemana.add(item.matricula);

        // Promessa quebrada = ele continua em risco e faltou num dia de aula
        // DEPOIS do dia em que prometeu. Faltar no próprio dia não conta: a
        // promessa costuma ser "amanhã eu vou", feita à noite.
        let promessa = null;
        if (resposta?.interpretacao === 'promessa') {
            const diaDaPromessa = converterDataAula(diaNoFusoDaEscola(resposta.recebidaEm));
            promessa = { em: resposta.recebidaEm, quebrou: converterDataAula(item.ultimaFalta) > diaDaPromessa };
        }

        return {
            ...item,
            situacao,
            tentativa,
            promessa,
            recebeuSegunda: recebeu(segunda),
            telefone: aluno?.telefone || null,
            // O contato criado no envio vira "respondido" quando a resposta do
            // aluno chega pelo webhook (SAIR não marca: não é resposta à pergunta).
            respondeu: [primeira, segunda].some((m) => recebeu(m) && statusContatoPorId.get(m.contatoId) === 'respondido')
        };
    });
}

// Números da tela de acompanhamento, por ALUNO (matrícula), não por turma.
function resumir(itens) {
    const porMatricula = new Map();
    for (const item of itens) {
        const atual = porMatricula.get(item.matricula);
        if (!atual || ORDEM_SITUACAO.indexOf(item.situacao) < ORDEM_SITUACAO.indexOf(atual.situacao)) {
            porMatricula.set(item.matricula, item);
        }
    }
    const porSituacao = Object.fromEntries(ORDEM_SITUACAO.map((s) => [s, 0]));
    let responderam = 0;
    let prometeram = 0;
    let quebraram = 0;
    let segundas = 0;
    for (const item of porMatricula.values()) {
        porSituacao[item.situacao]++;
        if (item.respondeu) responderam++;
        if (item.recebeuSegunda) segundas++;
        if (item.promessa) prometeram++;
        if (item.promessa?.quebrou) quebraram++;
    }
    return { emRisco: porMatricula.size, porSituacao, responderam, prometeram, quebraram, segundas };
}

// Coloca na fila do lote automático quem está como "receber". Cria o lote se a
// chave acabou de ser ligada. Devolve quantos entraram.
async function abastecer(sessao, agora = new Date()) {
    let lote = await loteAutomatico(sessao.id);
    if (!lote) {
        // O primeiro envio respeita o intervalo desde a última mensagem do número.
        const ultima = await prisma.mensagemWhatsapp.findFirst({
            where: { sessaoId: sessao.id, enviadaEm: { not: null } },
            orderBy: { enviadaEm: 'desc' },
            select: { enviadaEm: true }
        });
        const liberadoEm = ultima ? ultima.enviadaEm.getTime() + sessao.intervaloMinSeg * 1000 : 0;
        lote = await prisma.loteWhatsapp.create({
            data: { sessaoId: sessao.id, usuarioId: sessao.usuarioId, automatico: true, total: 0, proximoEnvioEm: new Date(Math.max(agora.getTime(), liberadoEm)) }
        });
    }

    const lista = (await avaliar(sessao, agora)).filter((item) => item.situacao === 'receber');
    if (lista.length === 0) return 0;

    const responsavel = nomeResponsavel(sessao.usuario);
    await prisma.$transaction(async (tx) => {
        for (const aluno of lista) {
            const dados = {
                loteId: lote.id,
                sessaoId: sessao.id,
                usuarioId: sessao.usuarioId,
                nomeAluno: aluno.nomeAluno,
                nomeTurma: aluno.nomeTurma,
                telefone: aluno.telefone,
                // A 2ª tem texto próprio: repetir a 1ª palavra por palavra soa a
                // robô e é exatamente o padrão que o WhatsApp vigia.
                texto: renderizarMensagem(aluno.tentativa === 2 ? MENSAGEM_SEGUNDA : sessao.mensagemModelo, { ...aluno, responsavel }),
                status: 'pendente',
                erro: null,
                falhaDefinitiva: false,
                chatId: null,
                messageId: null,
                contatoId: null,
                enviadaEm: null
            };
            // Linha cancelada (ou com falha temporária) do mesmo episódio e mesma
            // tentativa é reaproveitada — a chave única não deixa criar outra.
            const chave = { matricula: aluno.matricula, codigoTurma: aluno.codigoTurma, primeiraFalta: aluno.primeiraFalta, tentativa: aluno.tentativa };
            await tx.mensagemWhatsapp.upsert({
                where: { matricula_codigoTurma_primeiraFalta_tentativa: chave },
                update: dados,
                create: { ...dados, ...chave }
            });
        }
        await tx.loteWhatsapp.update({ where: { id: lote.id }, data: { total: { increment: lista.length } } });
    });
    console.log(`[whatsapp] envio automático: ${lista.length} aluno(s) entraram na fila.`);
    return lista.length;
}

module.exports = {
    DIAS_ENTRE_MENSAGENS,
    DIAS_PARA_SEGUNDA,
    DIAS_DESDE_CONTATO,
    SITUACOES,
    lerTurmas,
    sessaoDoSistema,
    loteAutomatico,
    avaliar,
    resumir,
    abastecer
};
