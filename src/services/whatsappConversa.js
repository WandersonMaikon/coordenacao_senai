// O roteiro de conversa do robô com o aluno depois da mensagem automática.
//
// Até 24/10/2026 o robô respondia uma vez só ("obrigado, a coordenação vai
// falar com você") e parava. Agora ele conduz algumas trocas curtas — pede texto
// quando chega áudio, pergunta o que está dificultando quando o aluno fala em
// desistir, pede o atestado quando fala em doença — e só então entrega para a
// coordenação.
//
// Regras que não mudam:
// - TODOS os textos estão aqui e são fixos. A IA (iaLocal.js) e o dicionário só
//   decidem qual caminho seguir; nunca escrevem para o aluno.
// - Assunto delicado (saúde mental, problema familiar) não tem pergunta: o robô
//   acolhe e entrega para uma pessoa.
// - No máximo MAX_RESPOSTAS_ROBO respostas por mensagem enviada, e nunca a mesma
//   pergunta duas vezes seguidas — o aluno não pode ficar preso num robô.
// - Se alguém da coordenação escreve à mão na conversa, o robô fica quieto
//   (etapa "humano") até a próxima mensagem automática.
//
// `decidir` é uma função pura (sem banco, sem WhatsApp) para dar para testar o
// roteiro inteiro sem enviar nada. Quem grava e envia é whatsappResposta.js.

const { normalizar, MOTIVOS_DELICADOS } = require('./classificarResposta');

const MAX_RESPOSTAS_ROBO = 4;

const TEXTOS = {
    promessa: 'Combinado! Te esperamos na próxima aula. Se acontecer algum imprevisto, é só escrever aqui.',
    sair: 'Tudo bem, você não vai mais receber mensagens automáticas. Poderia descrever em poucas palavras o que aconteceu? Assim a coordenação consegue ajudar.',
    pedirTexto: 'Desculpe, {primeiro_nome}, por aqui não consigo ouvir áudio. Pode escrever em poucas palavras o que aconteceu?',
    desistencia: 'Poxa, {primeiro_nome}, que pena! Antes de decidir, pode contar o que está dificultando? Muitas vezes a coordenação consegue ajudar — com horário, reposição de aulas ou outra coisa.',
    saude: 'Melhoras, {primeiro_nome}! Se você tiver atestado, pode mandar a foto dele aqui mesmo. E quando acha que consegue voltar às aulas?',
    atestadoRecebido: 'Recebido, obrigado! Vou passar para a coordenação. Quando acha que consegue voltar às aulas?',
    ajudaTransporte: 'Entendi, transporte é uma dificuldade que muitos alunos têm. Quer que alguém da coordenação converse com você para ver alguma alternativa? Responda SIM ou NÃO.',
    ajudaTrabalho: 'Entendi, conciliar trabalho e curso não é fácil. Quer que alguém da coordenação converse com você para ver alguma alternativa? Responda SIM ou NÃO.',
    ajudaFinanceiro: 'Entendi, obrigado por contar. Quer que alguém da coordenação converse com você para ver alguma alternativa? Responda SIM ou NÃO.',
    ajudaSim: 'Certo! Vou pedir para a coordenação falar com você. Se precisar de algo antes disso, é só escrever aqui.',
    ajudaNao: 'Tudo bem! Se mudar de ideia ou precisar de alguma coisa, é só escrever aqui.',
    desmotivacao: 'Obrigado pela sinceridade, {primeiro_nome}! O que está te desanimando: o conteúdo, a turma, o horário ou outra coisa? Pode contar em poucas palavras.',
    viagem: 'Entendi, obrigado por avisar, {primeiro_nome}! Você já voltou? Consegue vir na próxima aula? Responda SIM ou NÃO.',
    naoVem: 'Entendi. Pode contar o que está acontecendo? Assim a coordenação consegue te ajudar.',
    delicado: 'Sinto muito que você esteja passando por isso, {primeiro_nome}. Alguém da coordenação vai falar com você com calma. Se precisar de alguma coisa antes, é só escrever aqui.',
    naoEntendi: 'Desculpe, não entendi bem. Você consegue vir na próxima aula? Responda SIM ou NÃO, ou conte em poucas palavras o que aconteceu.',
    final: 'Obrigado por contar! Vou passar para a coordenação, que vai falar com você. Se precisar de algo antes, é só escrever aqui.'
};

const AJUDA_POR_MOTIVO = {
    transporte: 'ajudaTransporte',
    trabalho: 'ajudaTrabalho',
    financeiro: 'ajudaFinanceiro'
};

const TIPOS_AUDIO = ['audio', 'voice', 'ptt'];
const TIPOS_ARQUIVO = ['image', 'document'];

// Etapas em que o robô já disse tudo o que tinha para dizer: daqui em diante só
// SAIR, promessa e desistência ainda recebem resposta.
const ETAPAS_ENCERRADAS = ['encerrada', 'combinado'];

// Sem nome cadastrado, o vocativo sai inteiro ("Poxa, que pena!").
function renderizar(chave, primeiroNome) {
    const texto = TEXTOS[chave];
    return primeiroNome ? texto.replaceAll('{primeiro_nome}', primeiroNome) : texto.replaceAll(', {primeiro_nome}', '');
}

// Decide a próxima fala do robô.
//   conversa:      { etapa, turnos, pediuTexto } — o estado salvo na MensagemWhatsapp
//   interpretacao: { tipo, motivo? } — de iaLocal.interpretar (ignorada se for mídia)
//   simNao:        'sim' | 'nao' | null — de classificarResposta.respostaSimNao
//   tipoMensagem:  'text', 'audio', 'image'...
// Devolve { chave, etapa, pediuTexto } — chave null = não responder.
function decidir({ conversa, interpretacao, simNao, tipoMensagem }) {
    const etapa = conversa.etapa || null;
    const manter = { chave: null, etapa, pediuTexto: conversa.pediuTexto };
    const responder = (chave, novaEtapa) => ({ chave, etapa: novaEtapa, pediuTexto: conversa.pediuTexto || chave === 'pedirTexto' });

    // SAIR é atendido sempre, até com uma pessoa na conversa: é o único pedido
    // do aluno que o sistema cumpre sozinho, e ele precisa da confirmação.
    if (interpretacao?.tipo === 'sair') return etapa === 'saiu' || etapa === 'saiu_fim' ? manter : responder('sair', 'saiu');
    if (etapa === 'humano' || etapa === 'saiu_fim') return manter;
    // O texto do SAIR pede para o aluno contar o que aconteceu: a explicação
    // recebe um "obrigado" e nada mais — ele pediu para não receber mensagens.
    if (etapa === 'saiu') return responder('final', 'saiu_fim');
    // O "Combinado!" passa do limite: é a única fala que fecha o caso sem
    // ninguém precisar ligar, e só sai uma vez por conversa.
    const promessaNova = interpretacao?.tipo === 'promessa' && etapa !== 'combinado' && !TIPOS_AUDIO.includes(tipoMensagem);
    if (conversa.turnos >= MAX_RESPOSTAS_ROBO && !promessaNova) return manter;

    // ── Áudio, foto, documento ──
    if (TIPOS_AUDIO.includes(tipoMensagem)) {
        if (!conversa.pediuTexto) return responder('pedirTexto', etapa);
        return ETAPAS_ENCERRADAS.includes(etapa) ? manter : responder('final', 'encerrada');
    }
    if (TIPOS_ARQUIVO.includes(tipoMensagem)) {
        if (etapa === 'saude') return responder('atestadoRecebido', 'volta');
        return ETAPAS_ENCERRADAS.includes(etapa) ? manter : responder('final', 'encerrada');
    }
    if (tipoMensagem && tipoMensagem !== 'text' && tipoMensagem !== 'chat') {
        // Figurinha, localização, chamada... não dá para conversar sobre isso.
        return manter;
    }

    let proxima = escolher({ etapa, interpretacao, simNao });
    if (!proxima) return manter;

    // Nunca a mesma pergunta duas vezes seguidas: se o aluno respondeu a uma
    // pergunta com algo que levaria a ela de novo, a conversa vai para a pessoa.
    if (proxima.etapa === etapa && proxima.chave !== 'promessa' && !ETAPAS_ENCERRADAS.includes(etapa)) {
        proxima = { chave: 'final', etapa: 'encerrada' };
    }
    // Depois de encerrada, o robô não repete a despedida nem pede de novo para
    // explicar: quem escreve mais fica registrado para a coordenação ler.
    if (ETAPAS_ENCERRADAS.includes(etapa) && ['final', 'naoEntendi', 'naoVem'].includes(proxima.chave)) return manter;

    return responder(proxima.chave, proxima.etapa);
}

function escolher({ etapa, interpretacao, simNao }) {
    const tipo = interpretacao?.tipo || 'nao_entendido';
    const motivo = interpretacao?.motivo || null;

    // Pergunta de SIM/NÃO do próprio roteiro: aqui "sim" é resposta à pergunta,
    // não promessa de voltar.
    if (etapa === 'ajuda' && simNao) {
        return simNao === 'sim' ? { chave: 'ajudaSim', etapa: 'encerrada' } : { chave: 'ajudaNao', etapa: 'encerrada' };
    }

    if (tipo === 'desistencia') {
        return etapa === 'desistencia' ? { chave: 'final', etapa: 'encerrada' } : { chave: 'desistencia', etapa: 'desistencia' };
    }
    if (tipo === 'promessa') {
        return etapa === 'combinado' ? null : { chave: 'promessa', etapa: 'combinado' };
    }

    if (motivo && MOTIVOS_DELICADOS.includes(motivo)) return { chave: 'delicado', etapa: 'encerrada' };
    if (motivo && motivo.startsWith('saude_')) {
        // Já falou de saúde e agora disse outra coisa: hora de passar adiante.
        return ['saude', 'volta'].includes(etapa) ? { chave: 'final', etapa: 'encerrada' } : { chave: 'saude', etapa: 'saude' };
    }
    if (motivo && AJUDA_POR_MOTIVO[motivo]) return { chave: AJUDA_POR_MOTIVO[motivo], etapa: 'ajuda' };
    if (motivo === 'desmotivacao_curso') return { chave: 'desmotivacao', etapa: 'detalhe' };
    // Quem viajou costuma voltar sozinho: a pergunta é só se já voltou — "sim"
    // na etapa "volta" vira o "Combinado!", "não" pede para contar mais.
    if (motivo === 'viagem') return { chave: 'viagem', etapa: 'volta' };

    // "Não" à pergunta da mensagem ("Você consegue vir na próxima aula?").
    if (simNao === 'nao' && [null, 'pergunta', 'volta'].includes(etapa)) return { chave: 'naoVem', etapa: 'detalhe' };

    // Não entendido (ou motivo que o roteiro não trata): na primeira vez o robô
    // pergunta de novo, mais simples; depois disso, entrega para a coordenação.
    if (etapa === null) return { chave: 'naoEntendi', etapa: 'pergunta' };
    return { chave: 'final', etapa: 'encerrada' };
}

// A mensagem que saiu do nosso número foi escrita pelo robô ou por uma pessoa?
// Comparação pelo texto: o robô só manda textos fixos (a mensagem automática e
// os de TEXTOS), então qualquer outra coisa foi digitada à mão.
function ehTextoDoRobo(texto, { mensagemEnviada, primeiroNome }) {
    const alvo = normalizar(texto);
    if (!alvo) return true;
    if (normalizar(mensagemEnviada) === alvo) return true;
    return Object.keys(TEXTOS).some((chave) => normalizar(renderizar(chave, primeiroNome)) === alvo);
}

// Várias mensagens seguidas do aluno viram UMA leitura para o robô responder uma
// vez só. Visto em 26/10/2026: "não estava na cidade" + "consigo ir sim" — o robô
// respondeu às duas em separado, perguntou de transporte a quem já tinha dito
// que vinha, e o "Combinado!" chegou depois.
//   lidas: [{ tipo ('chat' | 'audio' | 'image'...), simNao, interp: { tipo, motivo? } }],
//          na ordem em que chegaram.
// Devolve { interpretacao, simNao, tipoMensagem } no formato que `decidir` espera.
// Prioridade: SAIR > desistência > resposta à pergunta de ajuda > promessa (com o
// motivo que veio junto) > motivo (o mais recente) > não entendido. Áudio ou foto
// junto de texto não mudam a leitura — o texto diz mais.
function juntarMensagens(lidas) {
    const textos = lidas.filter((l) => ['chat', 'text'].includes(l.tipo));
    if (textos.length === 0) {
        const ultima = lidas[lidas.length - 1];
        return { interpretacao: { tipo: 'nao_entendido' }, simNao: null, tipoMensagem: ultima.tipo };
    }
    if (textos.length === 1) return { interpretacao: textos[0].interp, simNao: textos[0].simNao, tipoMensagem: textos[0].tipo };

    const interps = textos.map((l) => l.interp);
    const achar = (tipo) => interps.find((i) => i.tipo === tipo);
    const motivo = [...interps].reverse().find((i) => i.motivo)?.motivo || null;
    const comMotivo = (tipo) => (motivo ? { tipo, motivo } : { tipo });

    let interpretacao;
    if (achar('sair')) interpretacao = { tipo: 'sair' };
    else if (achar('desistencia')) interpretacao = comMotivo('desistencia');
    else if (achar('pediu_ajuda') || achar('recusou_ajuda')) interpretacao = [...interps].reverse().find((i) => ['pediu_ajuda', 'recusou_ajuda'].includes(i.tipo));
    else if (achar('promessa') && !MOTIVOS_DELICADOS.includes(motivo)) interpretacao = comMotivo('promessa');
    else if (motivo) interpretacao = { tipo: 'palavras_chave', motivo };
    else interpretacao = { tipo: 'nao_entendido' };

    return { interpretacao, simNao: textos[textos.length - 1].simNao, tipoMensagem: 'chat' };
}

module.exports = { decidir, renderizar, ehTextoDoRobo, juntarMensagens, TEXTOS, MAX_RESPOSTAS_ROBO };
