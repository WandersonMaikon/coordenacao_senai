// Regras do envio de WhatsApp em lote: configuração (mensagem e limites), texto
// que o aluno recebe e quem entraria num lote agora (prévia). O envio em si
// (worker, Iniciar/Parar) vem na etapa 3 — ver roadmap item 7 no CLAUDE.md.

const prisma = require('../config/prisma');
const { MOTIVOS } = require('../config/motivos');
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

// Anexado pelo sistema, fora do campo editável: é o que o robô da etapa 4 lê
// quando o aluno responde. Se ficasse no campo, apagar uma linha sem querer
// quebraria a leitura das respostas.
function blocoMenu() {
    const opcoes = MOTIVOS.map((motivo, i) => `${i + 1} - ${motivo.rotuloAluno}`).join('\n');
    return `Para nos ajudar, responda com o número do motivo:\n${opcoes}\n\nSe não quiser receber mais mensagens, responda SAIR.`;
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

function nomeResponsavel(usuario) {
    return primeiroNome(usuario.nome) || usuario.usuario;
}

// Quem receberia mensagem agora se o usuário iniciasse um lote: alunos em risco
// (fora dos recuperados em acompanhamento) das turmas que ele assumiu. Os que
// ficam de fora voltam com o motivo, pra tela explicar — "por que a Maria não
// está na lista?" é a primeira pergunta de quem confere.
//
// Ainda falta (etapa 3): pular quem já recebeu mensagem neste episódio de risco.
async function montarPrevia(usuario, sessao) {
    const turmasDoUsuario = await prisma.usuarioTurma.findMany({
        where: { usuarioId: usuario.id },
        select: { codigoTurma: true }
    });
    const codigos = new Set(turmasDoUsuario.map((t) => t.codigoTurma));
    if (codigos.size === 0) return { receberiam: [], naoReceberiam: [], turmas: 0 };

    const { emRisco } = await calcularAlunosEmRiscoSemRecuperados();
    const candidatos = emRisco.filter((item) => codigos.has(item.codigoTurma));
    const matriculas = [...new Set(candidatos.map((item) => item.matricula))];

    const [alunos, contatos] = await Promise.all([
        prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true, situacao: true, whatsappOptOut: true }
        }),
        prisma.contato.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, criadoEm: true, contatadoPor: true },
            orderBy: { criadoEm: 'desc' }
        })
    ]);
    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));
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

        let motivo = null;
        if (!aluno || !aluno.telefone) motivo = 'Sem telefone cadastrado';
        else if (!ehSituacaoAtiva(aluno.situacao)) motivo = `Situação na planilha: ${aluno.situacao}`;
        else if (aluno.whatsappOptOut) motivo = 'Pediu para não receber mensagens (SAIR)';
        // Se a coordenação já falou com o aluno depois que ele começou a faltar,
        // mensagem automática agora seria repetida e soaria descuidada.
        else if (ultimoContato && ultimoContato.criadoEm.getTime() >= converterDataAula(item.primeiraFalta)) {
            motivo = `Já contatado em ${ultimoContato.criadoEm.toLocaleDateString('pt-BR', { timeZone: 'America/Porto_Velho' })}${ultimoContato.contatadoPor ? ` por ${ultimoContato.contatadoPor}` : ''}`;
        }

        if (motivo) {
            naoReceberiam.push({ ...base, motivo });
        } else {
            receberiam.push({
                ...base,
                telefone: aluno.telefone,
                mensagem: renderizarMensagem(sessao.mensagemModelo, { ...item, responsavel })
            });
        }
    }

    const porNome = (a, b) => (a.nomeAluno || '').localeCompare(b.nomeAluno || '', 'pt-BR');
    receberiam.sort(porNome);
    naoReceberiam.sort(porNome);

    return { receberiam, naoReceberiam, turmas: codigos.size };
}

module.exports = {
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
