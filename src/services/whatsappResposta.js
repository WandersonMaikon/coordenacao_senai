// A volta do WhatsApp: o que fazer com a mensagem que o aluno mandou.
//
// O envio (whatsappEnvio.js) cria um `Contato` com status "sem_resposta" e guarda
// `chatId`/`contatoId` na `MensagemWhatsapp`. Este arquivo fecha o laço: acha de
// quem é a resposta, interpreta, atualiza aquele mesmo `Contato` e segue o
// roteiro de conversa (whatsappConversa.js) para responder ao aluno.
//
// Não há corrida com o worker de envio: ele só escreve em mensagem `pendente` ou
// `enviando`, e aqui só se mexe em mensagem que já está `enviada` (inclusive nos
// campos `conversa*`, que o worker nunca toca). Se alguém mudar o worker, é essa
// invariante que precisa continuar valendo.

const prisma = require('../config/prisma');
const openwa = require('./openwa');
const { removerMensagemCitada, respostaSimNao } = require('./classificarResposta');
const { interpretar } = require('./iaLocal');
const { decidir, renderizar, ehTextoDoRobo, juntarMensagens } = require('./whatsappConversa');
const { agendarAnalise } = require('./whatsappAnalise');
const { normalizarTelefone, mesmoTelefone } = require('./telefone');
const { STATUS_JA_RECEBEU, primeiroNome } = require('./whatsappLote');

// Uma resposta que chega muito depois não deve ser colada num episódio de risco
// antigo — o aluno já voltou, faltou de novo, mudou de turma. Fora da janela a
// resposta é registrada sem vínculo, pra alguém olhar.
const DIAS_JANELA_RESPOSTA = 60;

// O que o robô responde (e quando fica quieto) está em whatsappConversa.js — o
// roteiro, com todos os textos fixos. Aqui só se grava e se envia.

// Tipos de mensagem que não são texto. Não são descartados: áudio é justamente o
// que mais chega, e a coordenação precisa saber que tem algo pra ouvir.
const RESUMO_POR_TIPO = {
    audio: '[áudio]', voice: '[áudio]', ptt: '[áudio]',
    image: '[imagem]', video: '[vídeo]', document: '[documento]',
    sticker: '[figurinha]', location: '[localização]', contact: '[contato]',
    // Os tipos restantes da lista do OpenWA. Sem eles, uma chamada perdida ou uma
    // mensagem apagada chegava com texto vazio e virava um contato "respondido"
    // sem nada escrito — a coordenação via "o aluno respondeu" e abria o nada.
    poll: '[enquete]', call: '[chamada]', revoked: '[mensagem apagada]',
    masked: '[mensagem protegida]', unknown: '[mensagem não reconhecida]'
};

// ───────────── Normalização do evento ─────────────

// O OpenWA entrega o payload ora na raiz, ora aninhado — e o shape exato só se
// confirma vendo um evento real (ver o passo de descoberta no plano). Em vez de
// apostar num formato, procuramos os campos nos lugares plausíveis. Se um evento
// real chegar com outro nome, é aqui (e só aqui) que se ajusta.
function corpoDoEvento(corpo) {
    return corpo?.data ?? corpo?.payload ?? corpo?.message ?? corpo ?? {};
}

function nomeDoEvento(corpo) {
    return corpo?.event ?? corpo?.type ?? corpo?.eventType ?? null;
}

function normalizarEntrada(corpo) {
    const dados = corpoDoEvento(corpo);
    const mensagem = dados.message ?? dados;
    // Na mensagem que sai do nosso número, `from` somos nós e o aluno é o `to`.
    const chatId = mensagem.chatId ?? (mensagem.fromMe ? mensagem.to : null) ?? mensagem.from ?? mensagem.chat?.id ?? null;
    const timestamp = mensagem.timestamp ?? mensagem.t ?? null;

    return {
        messageId: String(mensagem.id?._serialized ?? mensagem.id ?? mensagem.messageId ?? ''),
        chatId: chatId ? String(chatId) : '',
        texto: typeof mensagem.body === 'string' ? mensagem.body : (mensagem.text ?? ''),
        // `kind` NÃO serve de reserva pro tipo: ele descreve o chat (individual,
        // group, status), não o conteúdo da mensagem.
        tipo: mensagem.type ?? 'text',
        fromMe: Boolean(mensagem.fromMe),
        isGroup: mensagem.kind === 'group' || Boolean(mensagem.isGroup) || String(chatId || '').endsWith('@g.us'),
        // `kind` é o campo atual do OpenWA (individual|group|channel|status|
        // broadcast); `isStatusBroadcast` continua sendo mandado por compatibilidade.
        isStatus: mensagem.kind === 'status' || Boolean(mensagem.isStatusBroadcast) || String(chatId || '').startsWith('status@'),
        // timestamp do WhatsApp vem em segundos; Date espera milissegundos.
        recebidaEm: timestamp ? new Date(Number(timestamp) * (String(timestamp).length > 11 ? 1 : 1000)) : new Date()
    };
}

// ───────────── message.ack ─────────────

const STATUS_POR_ACK = {
    delivered: 'entregue', read: 'lida', played: 'lida', failed: 'falhou',
    // `ack` é o inteiro legado que o OpenWA ainda manda junto do `status`
    // canônico: 2 = entregue, 3 = lida, 4 = tocada, -1 = falhou.
    2: 'entregue', 3: 'lida', 4: 'lida', '-1': 'falhou'
};

// De onde só se avança. Um ack de "entregue" atrasado não pode rebaixar uma
// mensagem já marcada como lida, e nada ressuscita uma cancelada.
const ORIGEM_PERMITIDA = {
    entregue: ['enviada'],
    lida: ['enviada', 'entregue'],
    falhou: ['enviada', 'entregue', 'lida']
};

// Atualiza a MensagemWhatsapp para entregue/lida/falhou. Trata `message.ack` e
// `message.failed`, que o OpenWA dispara juntos quando o WhatsApp reporta erro.
async function processarAck(corpo) {
    const dados = corpoDoEvento(corpo);
    const mensagem = dados.message ?? dados;

    // O payload traz `id` E `messageId`, e a documentação do OpenWA não diz qual
    // dos dois é o id do WhatsApp (em outro endpoint dela, `messageId` é o id
    // interno da linha e `waMessageId` é o do WhatsApp). Guardamos o `messageId`
    // devolvido pelo send-text, então procuramos pelos dois em vez de apostar num:
    // errar a escolha deixa toda mensagem parada em "enviada" para sempre.
    const candidatos = [
        mensagem.id?._serialized, mensagem.id, mensagem.messageId, mensagem.waMessageId
    ].filter((valor) => typeof valor === 'string' && valor !== '');

    // `status` é o canônico segundo a documentação; `ack` é o legado depreciado.
    const bruto = dados.status ?? mensagem.status ?? dados.ack ?? mensagem.ack;
    const novo = STATUS_POR_ACK[bruto] ?? STATUS_POR_ACK[String(bruto).toLowerCase()];
    if (candidatos.length === 0 || !novo) return { tratado: false };

    const dadosNovos = { status: novo };
    if (novo === 'falhou') {
        // Falha vinda do WhatsApp é definitiva: a mensagem não chegou e o
        // `Contato` do envio já existe. Mesmo critério do worker — na dúvida não
        // reenvia, porque mensagem duplicada pro aluno é pior.
        dadosNovos.falhaDefinitiva = true;
        dadosNovos.erro = 'O WhatsApp reportou falha na entrega desta mensagem.';
    }

    const { count } = await prisma.mensagemWhatsapp.updateMany({
        where: { messageId: { in: candidatos }, status: { in: ORIGEM_PERMITIDA[novo] } },
        data: dadosNovos
    });
    return { tratado: true, atualizadas: count, status: novo };
}

// ───────────── message.received ─────────────

// De quem é esta resposta. `chatId` é o caminho normal; o telefone é o plano B,
// porque o WhatsApp às vezes reporta celular antigo sem o 9º dígito (é o mesmo
// motivo de `mesmoTelefone` existir).
async function acharMensagemOriginal(chatId, telefone) {
    const desde = new Date(Date.now() - DIAS_JANELA_RESPOSTA * 24 * 60 * 60 * 1000);
    const porChat = await prisma.mensagemWhatsapp.findFirst({
        where: { chatId, status: { in: STATUS_JA_RECEBEU }, enviadaEm: { gte: desde } },
        orderBy: { enviadaEm: 'desc' }
    });
    if (porChat) return porChat;
    if (!telefone) return null;

    const candidatas = await prisma.mensagemWhatsapp.findMany({
        where: { status: { in: STATUS_JA_RECEBEU }, enviadaEm: { gte: desde } },
        orderBy: { enviadaEm: 'desc' },
        take: 300
    });
    return candidatas.find((item) => mesmoTelefone(item.telefone, telefone)) || null;
}

// A resposta do robô sai direto, fora do worker de lote, e NÃO conta contra
// limiteDia/limiteMes: esses tetos existem contra banimento por disparo frio, e
// responder quem escreveu pra você é o sinal oposto — o número ficaria pior mudo.
// Falha aqui nunca desfaz a gravação: o registro do contato é o que importa, a
// confirmação é cortesia.
async function responderAluno(sessaoId, chatId, texto) {
    try {
        const sessao = await prisma.whatsappSessao.findUnique({ where: { id: sessaoId } });
        if (!sessao?.sessionId || sessao.status !== 'ready' || sessao.pausadoMotivo) return false;
        await openwa.enviarTexto(sessao.sessionId, chatId, texto);
        return true;
    } catch (erro) {
        console.error('[whatsapp] não foi possível enviar a confirmação de recebimento:', erro.message);
        return false;
    }
}

function fraseDaResposta(interpretacao, texto) {
    switch (interpretacao.tipo) {
        case 'sair': return 'O aluno pediu para não receber mais mensagens (respondeu "SAIR").';
        case 'promessa': return `O aluno disse pelo WhatsApp que vem na próxima aula: "${texto}"`;
        case 'desistencia': return `O aluno disse pelo WhatsApp que vai sair do curso: "${texto}"`;
        case 'pediu_ajuda': return `O aluno pediu pelo WhatsApp para a coordenação falar com ele: "${texto}"`;
        case 'recusou_ajuda': return `O aluno disse pelo WhatsApp que não precisa que a coordenação fale com ele: "${texto}"`;
        default: return `Resposta do aluno pelo WhatsApp: "${texto}"`;
    }
}

// O que gravar no `Contato` do envio. SAIR é o único que NÃO marca "respondido":
// quem pediu pra não receber mais mensagem não engajou com a pergunta e continua
// precisando de contato humano por outro canal — marcar respondido o tiraria da
// lista de quem a coordenação precisa procurar, o oposto do que o pedido diz.
// `atual` é o contato como está agora: numa conversa de várias mensagens, cada
// resposta entra embaixo da anterior em vez de apagá-la.
function dadosDoContato(interpretacao, texto, atual) {
    const frase = fraseDaResposta(interpretacao, texto);
    // Na primeira resposta, a observação do envio ("Mensagem automática...") é trocada.
    const jaRespondeu = /^(O aluno|Resposta do aluno)/.test(atual?.observacao || '');
    const dados = { observacao: jaRespondeu ? `${atual.observacao}\n${frase}` : frase };
    if (interpretacao.tipo !== 'sair') dados.status = 'respondido';

    // Sugestão só enquanto ninguém confirmou um motivo; resposta sem motivo
    // ("sim", um áudio) não apaga a sugestão que veio de uma resposta anterior.
    if (interpretacao.motivo && !atual?.motivo) {
        dados.motivoSugerido = interpretacao.motivo;
        // "ia" = deduzido pelo modelo local; a tela mostra igual a palavras_chave
        // ("deduzido do que o aluno escreveu — confira"), mas fica registrado.
        dados.sugeridoPor = interpretacao.fonte === 'ia'
            ? 'ia'
            : interpretacao.tipo === 'menu' ? 'menu' : 'palavras_chave';
    }
    return dados;
}

// A mesma frase muda de sentido conforme a pergunta que o robô acabou de fazer:
// "sim" depois de "quer que a coordenação fale com você?" é pedido de ajuda, não
// promessa de voltar; e "ok" depois de "o que está dificultando?" não diz nada —
// responder "Combinado! Te esperamos" ali seria o mesmo erro de 22/10/2026.
async function interpretarNoContexto({ etapa, texto, simNao, midia }) {
    if (midia) return { tipo: 'nao_entendido', fonte: 'dicionario' };
    if (etapa === 'ajuda' && simNao) return { tipo: simNao === 'sim' ? 'pediu_ajuda' : 'recusou_ajuda', fonte: 'dicionario' };
    if (['desistencia', 'detalhe'].includes(etapa) && simNao) return { tipo: 'nao_entendido', fonte: 'dicionario' };
    // IA local quando disponível, dicionário como reserva (iaLocal.js).
    return interpretar(texto);
}

// Alguém da coordenação escreveu à mão pelo número do sistema (no celular ou no
// WhatsApp Web): o robô sai da conversa, senão os dois falariam ao mesmo tempo
// com o aluno. Visto em 22/10/2026 — a coordenação perguntou "Aconteceu alguma
// coisa?" logo depois da resposta automática.
// Depende de o OpenWA avisar as mensagens que saem do nosso número; ainda não foi
// confirmado com um evento real. Se não avisar, nada acontece aqui.
async function marcarSeFoiPessoa(entrada, telefone) {
    const original = await acharMensagemOriginal(entrada.chatId, telefone);
    if (!original || original.conversaEtapa === 'humano') return false;
    // O robô nunca manda áudio, foto ou documento.
    const midia = !entrada.texto && !['text', 'chat'].includes(entrada.tipo);
    if (!midia && ehTextoDoRobo(entrada.texto, { mensagemEnviada: original.texto, primeiroNome: primeiroNome(original.nomeAluno) })) return false;
    await prisma.mensagemWhatsapp.update({ where: { id: original.id }, data: { conversaEtapa: 'humano' } });
    return true;
}

// Processa uma mensagem recebida. Devolve um resumo (sem o texto do aluno) pro
// log. Nunca lança: o webhook precisa responder 200 mesmo quando não entende.
async function processarMensagemRecebida(corpo) {
    const entrada = normalizarEntrada(corpo);
    if (!entrada.messageId) return { ignorada: true, motivo: 'evento sem id de mensagem' };

    // Idempotência: o gateway reentrega. A trava real é o unique de message_id —
    // esta consulta só evita trabalho à toa no caminho comum.
    const jaProcessada = await prisma.respostaWhatsapp.findUnique({ where: { messageId: entrada.messageId } });
    if (jaProcessada) return { repetida: true, id: jaProcessada.id };

    const texto = entrada.texto || RESUMO_POR_TIPO[entrada.tipo] || '';
    const telefone = normalizarTelefone(String(entrada.chatId).split('@')[0]);

    const registrar = (dados) => prisma.respostaWhatsapp.create({
        data: {
            messageId: entrada.messageId,
            chatId: entrada.chatId,
            telefone: telefone || null,
            texto,
            recebidaEm: entrada.recebidaEm,
            ...dados
        }
    });

    // Mensagem nossa, de grupo ou de status não é resposta de aluno. Fica
    // registrada como ignorada pra não parecer que o webhook perdeu evento.
    if (entrada.fromMe || entrada.isGroup || entrada.isStatus) {
        const linha = await registrar({ interpretacao: 'ignorada' });
        const pessoaAssumiu = entrada.fromMe && !entrada.isGroup && !entrada.isStatus && await marcarSeFoiPessoa(entrada, telefone);
        return { ignorada: true, id: linha.id, ...(pessoaAssumiu ? { pessoaAssumiu: true } : {}) };
    }

    const original = await acharMensagemOriginal(entrada.chatId, telefone);
    if (!original) {
        // Alguém escreveu pro número por outro motivo, ou a resposta veio fora da
        // janela. Registra e para: não há contato pra atualizar.
        const linha = await registrar({ interpretacao: 'sem_vinculo' });
        return { semVinculo: true, id: linha.id };
    }

    // Sem a nossa mensagem citada: é o texto do aluno que interessa, tanto para
    // interpretar quanto para a coordenação ler. Áudio, foto, figurinha ficam
    // com o resumo ("[áudio]").
    const textoAluno = entrada.texto ? removerMensagemCitada(texto, original.texto) : texto;

    // Aqui só se registra. A leitura e a resposta do robô vêm depois de
    // JANELA_RESPOSTA_MS sem mensagem nova (responderConversa): o aluno costuma
    // mandar duas ou três seguidas, e o robô responde uma vez, ao conjunto.
    const linha = await prisma.respostaWhatsapp.create({
        data: {
            messageId: entrada.messageId,
            chatId: entrada.chatId,
            telefone: telefone || null,
            matricula: original.matricula,
            mensagemId: original.id,
            contatoId: original.contatoId,
            texto: textoAluno,
            interpretacao: 'aguardando',
            recebidaEm: entrada.recebidaEm
        }
    });
    agendarResposta(original.id, entrada.chatId);

    // Log sem o conteúdo da mensagem: o CLAUDE.md proíbe jogar dado pessoal de
    // aluno em texto plano sem necessidade, e pra depurar basta o id.
    return { id: linha.id, matricula: original.matricula, aguardando: true };
}

// Quanto o robô espera, depois da última mensagem do aluno, antes de responder.
// Curto o bastante para a conversa não parecer parada; longo o bastante para
// pegar o "não estava na cidade" + "consigo ir sim" mandados em sequência.
const JANELA_RESPOSTA_MS = 20 * 1000;
const respostasAgendadas = new Map();

// Tipo da mensagem a partir do texto gravado (mídia é gravada como o resumo).
const TIPO_POR_RESUMO = Object.fromEntries(Object.entries(RESUMO_POR_TIPO).map(([tipo, resumo]) => [resumo, tipo]));

function agendarResposta(mensagemId, chatId, esperaMs = JANELA_RESPOSTA_MS) {
    clearTimeout(respostasAgendadas.get(mensagemId));
    const timer = setTimeout(() => {
        respostasAgendadas.delete(mensagemId);
        emFilaDoChat(chatId, () => responderConversa(mensagemId, chatId)).catch((erro) => {
            console.error('[whatsapp] erro ao responder a conversa', mensagemId, erro.message);
        });
    }, esperaMs);
    timer.unref();
    respostasAgendadas.set(mensagemId, timer);
}

// Lê as mensagens do aluno que ainda esperam ("aguardando"), decide a fala do
// robô para o conjunto, grava tudo e responde. Devolve o resumo para o log.
async function responderConversa(mensagemId, chatId) {
    const original = await prisma.mensagemWhatsapp.findUnique({ where: { id: mensagemId } });
    if (!original) return null;
    const pendentes = await prisma.respostaWhatsapp.findMany({
        where: { mensagemId, interpretacao: 'aguardando' },
        orderBy: [{ recebidaEm: 'asc' }, { id: 'asc' }]
    });
    if (pendentes.length === 0) return null;

    // Cada mensagem é lida no contexto da pergunta que o robô tinha feito antes
    // de o aluno começar a escrever — a mesma para todas as do conjunto.
    const etapa = original.conversaEtapa;
    const lidas = [];
    for (const r of pendentes) {
        const tipo = TIPO_POR_RESUMO[r.texto] || 'chat';
        const midia = tipo !== 'chat';
        const simNao = midia ? null : respostaSimNao(r.texto);
        const interp = await interpretarNoContexto({ etapa, texto: r.texto, simNao, midia });
        lidas.push({ r, tipo, simNao, interp });
    }

    // O próximo passo do roteiro (whatsappConversa.js), uma vez para o conjunto.
    const decisao = decidir({
        conversa: { etapa, turnos: original.conversaTurnos, pediuTexto: original.conversaPediuTexto },
        ...juntarMensagens(lidas)
    });
    const textoRobo = decisao.chave ? renderizar(decisao.chave, primeiroNome(original.nomeAluno)) : null;

    // Transação: as respostas e o efeito delas (contato, opt-out, etapa da
    // conversa) entram juntos ou não entram. Sem isso, uma falha no meio deixaria
    // o aluno desinscrito sem registro de por quê.
    await prisma.$transaction(async (tx) => {
        let contato = original.contatoId
            ? await tx.contato.findUnique({ where: { id: original.contatoId }, select: { observacao: true, motivo: true } })
            : null;
        for (const { r, interp } of lidas) {
            await tx.respostaWhatsapp.update({
                where: { id: r.id },
                data: { interpretacao: interp.tipo, motivoSugerido: interp.motivo || null }
            });
            if (contato) {
                const dados = dadosDoContato(interp, r.texto, contato);
                await tx.contato.update({ where: { id: original.contatoId }, data: dados });
                contato = { ...contato, observacao: dados.observacao };
            }
        }
        if (lidas.some(({ interp }) => interp.tipo === 'sair')) {
            await tx.aluno.update({ where: { matricula: original.matricula }, data: { whatsappOptOut: true } });
        }
        await tx.mensagemWhatsapp.update({
            where: { id: original.id },
            data: {
                conversaEtapa: decisao.etapa,
                conversaPediuTexto: decisao.pediuTexto,
                ...(textoRobo ? { conversaTurnos: { increment: 1 } } : {})
            }
        });
    });

    // Guardado só se saiu de fato, na última mensagem do conjunto: é o que a linha
    // do tempo da /risco mostra como fala do robô.
    const ultima = pendentes[pendentes.length - 1];
    if (textoRobo && await responderAluno(original.sessaoId, chatId, textoRobo)) {
        await prisma.respostaWhatsapp.update({ where: { id: ultima.id }, data: { respostaRobo: textoRobo } });
    }
    // Resumo e motivo da conversa inteira para a /contatar, quando o aluno parar
    // de escrever (whatsappAnalise.js).
    agendarAnalise(original.id);

    const resumo = {
        mensagemId,
        matricula: original.matricula,
        mensagens: lidas.length,
        interpretacoes: lidas.map(({ interp }) => interp.tipo),
        fontes: lidas.map(({ interp }) => interp.fonte),
        robo: decisao.chave,
        etapa: decisao.etapa
    };
    console.log('[whatsapp] conversa respondida:', JSON.stringify(resumo));
    return resumo;
}

// Na subida do servidor: respostas que ficaram "aguardando" porque o servidor
// reiniciou no meio da janela são respondidas agora (com um tempo, para o resto
// do sistema subir antes).
async function retomarConversasPendentes() {
    const pendentes = await prisma.respostaWhatsapp.findMany({
        where: { interpretacao: 'aguardando', mensagemId: { not: null } },
        select: { mensagemId: true, chatId: true },
        distinct: ['mensagemId']
    });
    pendentes.forEach((p, i) => agendarResposta(p.mensagemId, p.chatId, 15000 + i * 2000));
    if (pendentes.length) console.log(`[whatsapp] ${pendentes.length} conversa(s) com resposta pendente retomada(s).`);
}


// Uma mensagem por vez de cada conversa. O aluno costuma mandar duas ou três
// seguidas ("oi" / "to doente" / "[áudio]") e a IA leva segundos em cada uma:
// em paralelo, todas leriam a mesma etapa e o robô responderia duas vezes.
const filaPorChat = new Map();

function emFilaDoChat(chave, tarefa) {
    const anterior = filaPorChat.get(chave) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(tarefa);
    filaPorChat.set(chave, atual);
    atual.catch(() => {}).finally(() => {
        if (filaPorChat.get(chave) === atual) filaPorChat.delete(chave);
    });
    return atual;
}

// Porta de entrada do webhook: decide se o evento é resposta, ack ou nada.
async function processarEvento(corpo) {
    const evento = String(nomeDoEvento(corpo) || '');
    if (evento === 'message.ack' || evento === 'message.failed') return processarAck(corpo);
    // Sem nome de evento, assumimos mensagem recebida: é o caso que importa, e
    // `processarMensagemRecebida` já descarta sozinho o que não for resposta.
    if (!evento || evento === 'message.received') {
        return emFilaDoChat(normalizarEntrada(corpo).chatId || '-', () => processarMensagemRecebida(corpo));
    }
    // Os nomes são conferidos inteiros, não por `includes`: `message.sent` e
    // `message.revoked` também casariam com "message" e seriam gravados como se
    // fossem resposta de aluno — inclusive a nossa própria mensagem saindo.
    // session.status, call.received e o que mais vier: registrado no log e só.
    return { ignorada: true, motivo: `evento não tratado: ${evento}` };
}

module.exports = {
    processarEvento,
    processarMensagemRecebida,
    processarAck,
    normalizarEntrada,
    responderConversa,
    retomarConversasPendentes,
    DIAS_JANELA_RESPOSTA,
    JANELA_RESPOSTA_MS
};
