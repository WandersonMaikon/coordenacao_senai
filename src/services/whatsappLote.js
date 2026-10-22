// Regras do envio de WhatsApp: configuração (mensagem e limites) e o texto que o
// aluno recebe. Quem recebe é decidido em whatsappAutomatico.js; o envio em si é
// o worker de whatsappEnvio.js.

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

// Texto da 2ª mensagem (7 dias depois da 1ª, sem resposta). Fixo por enquanto —
// só a 1ª é editável na aba "Mensagem e limites". Deixa claro que é a última
// automática: depois dela, quem procura o aluno é uma pessoa.
const MENSAGEM_SEGUNDA =
    'Oi, {primeiro_nome}! É {responsavel} de novo, da coordenação do SENAI Ji-Paraná. ' +
    'Ainda não te vimos nas aulas da turma {turma} e queremos muito que você continue no curso. ' +
    'Esta é a última mensagem automática: se preferir, responda aqui e alguém da coordenação fala com você.';

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
//
// A pergunta fechada ("consegue vir? responda SIM") existe pro robô reconhecer a
// promessa de voltar, o único caso que ele resolve sozinho (classificarResposta.js).
function blocoMenu() {
    return 'Você consegue vir na próxima aula? Responda *SIM*, ou conte o que aconteceu — em poucas palavras já ajuda.\n\nSe não quiser mais receber mensagens, responda SAIR.';
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

// Status de mensagem que contam como "o aluno já recebeu".
const STATUS_JA_RECEBEU = ['enviada', 'entregue', 'lida'];

function nomeResponsavel(usuario) {
    return primeiroNome(usuario.nome) || usuario.usuario;
}

module.exports = {
    STATUS_JA_RECEBEU,
    TETOS,
    AQUECIMENTO,
    MENSAGEM_PADRAO,
    MENSAGEM_SEGUNDA,
    VARIAVEIS,
    blocoMenu,
    renderizarMensagem,
    validarConfig,
    limiteDiaEfetivo,
    nomeResponsavel,
    nomeTurmaLimpo
};
