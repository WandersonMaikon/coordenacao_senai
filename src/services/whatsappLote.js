// Regras do envio de WhatsApp em lote: configuração (mensagem e limites), texto
// que o aluno recebe e quem entraria num lote agora (prévia). O envio em si
// (worker, Iniciar/Parar) vem na etapa 3 — ver roadmap item 7 no CLAUDE.md.

const prisma = require('../config/prisma');
const {
    calcularAlunosEmRiscoSemRecuperados,
    ehSituacaoAtiva,
    converterDataAula
} = require('../controllers/alunoController');

// Tetos que a configuração do usuário não consegue ultrapassar. Existem pra
// proteger o número de bloqueio: o WhatsApp restringe conta que manda muita
// mensagem pra desconhecidos em pouco tempo.
const TETOS = {
    intervaloMinSeg: 60,       // nunca menos de 1 min entre mensagens
    intervaloMaxSeg: 3600,
    limiteDiaMax: 40,
    limiteMesMax: 800,
    janelaMaisCedo: '07:00',   // ninguém recebe mensagem da escola de madrugada
    janelaMaisTarde: '21:00',
    mensagemMaxCaracteres: 1000
};

// Número recém-conectado manda pouco nos primeiros dias ("aquecimento"): conta
// nova disparando dezenas de mensagens é o padrão clássico de spam pro WhatsApp.
const AQUECIMENTO = { dias: 7, limiteDia: 10 };

const MENSAGEM_PADRAO =
    'Olá, {primeiro_nome}! Aqui é {responsavel}, da coordenação do SENAI Ji-Paraná. ' +
    'Sentimos sua falta nas últimas {dias} aulas da turma {turma}. Está tudo bem? ' +
    'Queremos entender o que aconteceu para ajudar você a continuar o curso.';

const VARIAVEIS = ['{primeiro_nome}', '{turma}', '{dias}', '{responsavel}'];

// Anexado pelo sistema, fora do campo editável — o "SAIR" é a saída do aluno e
// não pode depender de alguém lembrar de escrevê-lo no modelo.
//
// Já foi um menu com as 9 opções numeradas. Saiu quando a leitura por contexto
// entrou (src/services/whatsappResposta.js): a lista ocupava o dobro da
// mensagem, e muito aluno não responde nada quando recebe um paredão de texto.
// Agora o convite é pra ele escrever com as palavras dele, que é o que ele já
// faria de qualquer jeito.
//
// O classificador continua aceitando um número solto de propósito: aluno que
// recebeu a mensagem antiga ainda pode responder "3" dias depois.
function blocoMenu() {
    return 'Pode responder por aqui contando o que aconteceu — em poucas palavras já ajuda.\n\nSe não quiser mais receber mensagens, responda SAIR.';
}

function primeiroNome(nome) {
    const primeiro = String(nome || '').trim().split(/\s+/)[0] || '';
    return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

// Mesmo tratamento do nomeTurmaLimpo (public/js/turmas.js): o SGE repete o curso.
function nomeTurmaLimpo(nome) {
    if (!nome) return nome;
    const partes = nome.split(' - ').map((parte) => parte.trim()).filter(Boolean);
    return partes
        .filter((parte, i) => i === 0 || parte.toLowerCase() !== partes[i - 1].toLowerCase())
        .join(' - ');
}

function renderizarMensagem(modelo, { nomeAluno, nomeTurma, diasSemVir, responsavel }) {
    const corpo = (modelo || MENSAGEM_PADRAO)
        .replaceAll('{primeiro_nome}', primeiroNome(nomeAluno) || 'aluno(a)')
        .replaceAll('{turma}', nomeTurmaLimpo(nomeTurma) || '')
        .replaceAll('{dias}', String(diasSemVir ?? ''))
        .replaceAll('{responsavel}', responsavel || 'a coordenação');
    return `${corpo.trim()}\n\n${blocoMenu()}`;
}

function horaValida(hora) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(hora || '');
}

// Valida e normaliza o que vem da tela. Devolve { dados } ou { erro }.
function validarConfig(corpo) {
    const intervaloMinSeg = Number(corpo.intervaloMinSeg);
    const intervaloMaxSeg = Number(corpo.intervaloMaxSeg);
    const limiteDia = Number(corpo.limiteDia);
    const limiteMes = Number(corpo.limiteMes);
    const { janelaInicio, janelaFim } = corpo;
    const mensagemModelo = String(corpo.mensagemModelo ?? '').trim();

    if (![intervaloMinSeg, intervaloMaxSeg, limiteDia, limiteMes].every(Number.isInteger)) {
        return { erro: 'Intervalos e limites precisam ser números inteiros.' };
    }
    if (intervaloMinSeg < TETOS.intervaloMinSeg) {
        return { erro: `O intervalo mínimo entre mensagens é de ${TETOS.intervaloMinSeg} segundos.` };
    }
    if (intervaloMaxSeg < intervaloMinSeg || intervaloMaxSeg > TETOS.intervaloMaxSeg) {
        return { erro: `O intervalo máximo precisa ser maior que o mínimo e até ${TETOS.intervaloMaxSeg} segundos.` };
    }
    if (limiteDia < 1 || limiteDia > TETOS.limiteDiaMax) {
        return { erro: `O limite por dia precisa ficar entre 1 e ${TETOS.limiteDiaMax}.` };
    }
    if (limiteMes < limiteDia || limiteMes > TETOS.limiteMesMax) {
        return { erro: `O limite por mês precisa ser maior que o limite por dia e até ${TETOS.limiteMesMax}.` };
    }
    if (!horaValida(janelaInicio) || !horaValida(janelaFim) || janelaInicio >= janelaFim) {
        return { erro: 'Informe o horário de envio no formato HH:MM, com o início antes do fim.' };
    }
    if (janelaInicio < TETOS.janelaMaisCedo || janelaFim > TETOS.janelaMaisTarde) {
        return { erro: `O horário de envio precisa ficar entre ${TETOS.janelaMaisCedo} e ${TETOS.janelaMaisTarde}.` };
    }
    if (!mensagemModelo) {
        return { erro: 'Escreva a mensagem.' };
    }
    if (mensagemModelo.length > TETOS.mensagemMaxCaracteres) {
        return { erro: `A mensagem pode ter até ${TETOS.mensagemMaxCaracteres} caracteres.` };
    }

    return { dados: { intervaloMinSeg, intervaloMaxSeg, limiteDia, limiteMes, janelaInicio, janelaFim, mensagemModelo } };
}

// Limite diário que vale hoje, já considerando o aquecimento de número novo.
function limiteDiaEfetivo(sessao, agora = new Date()) {
    if (!sessao.conectadoEm) return Math.min(sessao.limiteDia, AQUECIMENTO.limiteDia);
    const dias = (agora - new Date(sessao.conectadoEm)) / (24 * 60 * 60 * 1000);
    return dias < AQUECIMENTO.dias ? Math.min(sessao.limiteDia, AQUECIMENTO.limiteDia) : sessao.limiteDia;
}

// Rótulos dos status de contato (mesmos da tela /risco).
const ROTULO_STATUS = {
    respondido: 'Respondido',
    sem_resposta: 'Sem resposta',
    acompanhar: 'Acompanhar',
    nunca_contato: 'Não foi possível contatar',
    recuperado: 'Recuperado'
};

// Quais status do último contato (feito durante o episódio de risco atual) ainda
// permitem mandar a mensagem — só se o usuário marcar a opção. Respondido e
// Acompanhar nunca entram: alguém já está conversando com o aluno, e mensagem
// automática por cima soaria como se ninguém tivesse lido o que ele contou.
const STATUS_REENVIO_OPCIONAL = {
    sem_resposta: 'incluirSemResposta',
    nunca_contato: 'incluirNaoContatado'
};

// Status de mensagem que contam como "o aluno já recebeu".
const STATUS_JA_RECEBEU = ['enviada', 'entregue', 'lida'];

function chaveEpisodio(item) {
    return `${item.matricula}|${item.codigoTurma}|${item.primeiraFalta}`;
}

function nomeResponsavel(usuario) {
    return primeiroNome(usuario.nome) || usuario.usuario;
}

// Quem receberia mensagem agora se o usuário iniciasse um lote: alunos em risco
// (fora dos recuperados em acompanhamento) das turmas que ele assumiu. Os que
// ficam de fora voltam com o motivo, pra tela explicar — "por que a Maria não
// está na lista?" é a primeira pergunta de quem confere.
//
// `opcoes.incluirSemResposta` / `opcoes.incluirNaoContatado`: incluir também quem
// já foi contatado neste episódio, mas cujo último contato ficou "Sem resposta" /
// "Não foi possível contatar" — o WhatsApp vira uma nova tentativa por outro canal.
//
// Independente das opções: quem já recebeu a mensagem automática neste episódio
// de risco (ou já está na fila) nunca entra de novo.
async function montarPrevia(usuario, sessao, opcoes = {}) {
    const turmasDoUsuario = await prisma.usuarioTurma.findMany({
        where: { usuarioId: usuario.id },
        select: { codigoTurma: true }
    });
    const codigos = new Set(turmasDoUsuario.map((t) => t.codigoTurma));
    if (codigos.size === 0) return { receberiam: [], naoReceberiam: [], turmas: 0 };

    const { emRisco } = await calcularAlunosEmRiscoSemRecuperados();
    const candidatos = emRisco.filter((item) => codigos.has(item.codigoTurma));
    const matriculas = [...new Set(candidatos.map((item) => item.matricula))];

    const [alunos, contatos, mensagens] = await Promise.all([
        prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true, situacao: true, whatsappOptOut: true }
        }),
        prisma.contato.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, criadoEm: true, contatadoPor: true, status: true },
            orderBy: { criadoEm: 'desc' }
        }),
        prisma.mensagemWhatsapp.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, codigoTurma: true, primeiraFalta: true, status: true, falhaDefinitiva: true, erro: true, enviadaEm: true, atualizadoEm: true }
        })
    ]);
    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));
    const mensagemPorEpisodio = new Map(mensagens.map((m) => [chaveEpisodio(m), m]));
    const ultimoContatoPorMatricula = new Map();
    for (const contato of contatos) {
        if (!ultimoContatoPorMatricula.has(contato.matricula)) ultimoContatoPorMatricula.set(contato.matricula, contato);
    }

    const responsavel = nomeResponsavel(usuario);
    const receberiam = [];
    const naoReceberiam = [];

    for (const item of candidatos) {
        const aluno = alunoPorMatricula.get(item.matricula);
        const ultimoContato = ultimoContatoPorMatricula.get(item.matricula);
        const base = {
            matricula: item.matricula,
            nomeAluno: item.nomeAluno,
            codigoTurma: item.codigoTurma,
            nomeTurma: item.nomeTurma,
            diasSemVir: item.diasSemVir,
            primeiraFalta: item.primeiraFalta
        };

        // Contato de um episódio anterior (antes de começar a faltar desta vez) não
        // conta: aquele sumiço já foi resolvido, este é outro.
        const contatoNoEpisodio = ultimoContato && ultimoContato.criadoEm.getTime() >= converterDataAula(item.primeiraFalta)
            ? {
                status: ultimoContato.status,
                rotuloStatus: ROTULO_STATUS[ultimoContato.status] || ultimoContato.status || 'Sem status',
                em: ultimoContato.criadoEm,
                por: ultimoContato.contatadoPor
            }
            : null;

        const mensagem = mensagemPorEpisodio.get(chaveEpisodio(item));
        const dataCurta = (data) => new Date(data).toLocaleDateString('pt-BR', { timeZone: 'America/Porto_Velho' });

        let motivo = null;
        if (mensagem && STATUS_JA_RECEBEU.includes(mensagem.status)) {
            motivo = `Já recebeu a mensagem automática em ${dataCurta(mensagem.enviadaEm || mensagem.atualizadoEm)}`;
        } else if (mensagem && ['pendente', 'enviando'].includes(mensagem.status)) {
            motivo = 'Já está na fila de envio';
        } else if (mensagem && mensagem.status === 'falhou' && mensagem.falhaDefinitiva) {
            motivo = `Envio anterior falhou: ${mensagem.erro || 'erro desconhecido'}`;
        } else if (!aluno || !aluno.telefone) motivo = 'Sem telefone cadastrado';
        else if (!ehSituacaoAtiva(aluno.situacao)) motivo = `Situação na planilha: ${aluno.situacao}`;
        else if (aluno.whatsappOptOut) motivo = 'Pediu para não receber mensagens (SAIR)';
        else if (contatoNoEpisodio && !opcoes[STATUS_REENVIO_OPCIONAL[contatoNoEpisodio.status]]) {
            const quando = contatoNoEpisodio.em.toLocaleDateString('pt-BR', { timeZone: 'America/Porto_Velho' });
            motivo = `Já contatado em ${quando}${contatoNoEpisodio.por ? ` por ${contatoNoEpisodio.por}` : ''} — ${contatoNoEpisodio.rotuloStatus}`;
        }

        if (motivo) {
            naoReceberiam.push({ ...base, motivo, contatoNoEpisodio });
        } else {
            receberiam.push({
                ...base,
                telefone: aluno.telefone,
                contatoNoEpisodio,
                mensagem: renderizarMensagem(sessao.mensagemModelo, { ...item, responsavel })
            });
        }
    }

    const porNome = (a, b) => (a.nomeAluno || '').localeCompare(b.nomeAluno || '', 'pt-BR');
    receberiam.sort(porNome);
    naoReceberiam.sort(porNome);

    return { receberiam, naoReceberiam, turmas: codigos.size };
}

class ErroLote extends Error {
    constructor(mensagem, status = 400) {
        super(mensagem);
        this.status = status;
    }
}

// Cria o lote a partir da prévia recalculada AQUI, no servidor — a tela só manda
// quem desmarcou. Assim ninguém entra na fila por uma lista velha aberta no
// navegador (um aluno que voltou a vir, ou que outra pessoa acabou de contatar).
async function iniciarLote(usuario, sessao, opcoes, excluidos) {
    const ativo = await prisma.loteWhatsapp.findFirst({ where: { sessaoId: sessao.id, status: 'em_andamento' } });
    if (ativo) throw new ErroLote('Já existe um envio em andamento. Pare o envio atual antes de iniciar outro.', 409);

    const previa = await montarPrevia(usuario, sessao, opcoes);
    const chavesExcluidas = new Set(excluidos || []);
    const lista = previa.receberiam.filter((a) => !chavesExcluidas.has(`${a.matricula}|${a.codigoTurma}`));
    if (lista.length === 0) throw new ErroLote('Nenhum aluno selecionado para receber a mensagem.');

    // O primeiro envio respeita o intervalo mínimo desde a última mensagem deste
    // número — parar e iniciar de novo não pode virar um jeito de pular o intervalo.
    const ultima = await prisma.mensagemWhatsapp.findFirst({
        where: { sessaoId: sessao.id, enviadaEm: { not: null } },
        orderBy: { enviadaEm: 'desc' },
        select: { enviadaEm: true }
    });
    const agora = Date.now();
    const liberadoEm = ultima ? ultima.enviadaEm.getTime() + sessao.intervaloMinSeg * 1000 : agora;

    return prisma.$transaction(async (tx) => {
        const lote = await tx.loteWhatsapp.create({
            data: { sessaoId: sessao.id, usuarioId: usuario.id, total: lista.length, proximoEnvioEm: new Date(Math.max(agora, liberadoEm)) }
        });
        for (const aluno of lista) {
            const dados = {
                loteId: lote.id,
                sessaoId: sessao.id,
                usuarioId: usuario.id,
                nomeAluno: aluno.nomeAluno,
                nomeTurma: aluno.nomeTurma,
                telefone: aluno.telefone,
                texto: aluno.mensagem,
                status: 'pendente',
                erro: null,
                falhaDefinitiva: false,
                chatId: null,
                messageId: null,
                contatoId: null,
                enviadaEm: null
            };
            // Linha cancelada (ou com falha temporária) de um lote anterior do mesmo
            // episódio é reaproveitada — a chave única não deixa criar outra.
            await tx.mensagemWhatsapp.upsert({
                where: { matricula_codigoTurma_primeiraFalta: { matricula: aluno.matricula, codigoTurma: aluno.codigoTurma, primeiraFalta: aluno.primeiraFalta } },
                update: dados,
                create: { ...dados, matricula: aluno.matricula, codigoTurma: aluno.codigoTurma, primeiraFalta: aluno.primeiraFalta }
            });
        }
        return lote;
    });
}

module.exports = {
    ErroLote,
    STATUS_JA_RECEBEU,
    ROTULO_STATUS,
    iniciarLote,
    TETOS,
    AQUECIMENTO,
    MENSAGEM_PADRAO,
    VARIAVEIS,
    blocoMenu,
    renderizarMensagem,
    validarConfig,
    limiteDiaEfetivo,
    nomeResponsavel,
    nomeTurmaLimpo,
    montarPrevia
};
