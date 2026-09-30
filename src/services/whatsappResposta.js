// A volta do WhatsApp: o que fazer com a mensagem que o aluno mandou.
//
// O envio (whatsappEnvio.js) cria um `Contato` com status "sem_resposta" e guarda
// `chatId`/`contatoId` na `MensagemWhatsapp`. Este arquivo fecha o laço: acha de
// quem é a resposta, interpreta, atualiza aquele mesmo `Contato` e responde uma
// confirmação curta ao aluno.
//
// Não há corrida com o worker de envio: ele só escreve em mensagem `pendente` ou
// `enviando`, e aqui só se mexe em mensagem que já está `enviada`. Se alguém
// mudar o worker, é essa invariante que precisa continuar valendo.

const prisma = require('../config/prisma');
const openwa = require('./openwa');
const { interpretarResposta } = require('./classificarResposta');
const { normalizarTelefone, mesmoTelefone } = require('./telefone');
const { STATUS_JA_RECEBEU } = require('./whatsappLote');

// Uma resposta que chega muito depois não deve ser colada num episódio de risco
// antigo — o aluno já voltou, faltou de novo, mudou de turma. Fora da janela a
// resposta é registrada sem vínculo, pra alguém olhar.
const DIAS_JANELA_RESPOSTA = 60;

// Uma auto-resposta por aluno a cada 24h: sem isso, aluno que manda três
// mensagens seguidas recebe três "obrigado" e a conversa vira ping-pong de robô.
const HORAS_ENTRE_AUTO_RESPOSTAS = 24;

// Texto fixo, nunca gerado. Se o aluno responder algo grave (violência, saúde
// mental — `saude_mental` está na lista de motivos), um robô improvisando seria
// pior que o silêncio: a confirmação só diz que chegou e que uma PESSOA vai
// falar com ele.
const RESPOSTA_RECEBIDA = 'Obrigado por responder! Recebemos sua mensagem e a coordenação vai falar com você. Se precisar de algo antes disso, é só escrever aqui.';
const RESPOSTA_SAIR = 'Tudo bem, você não vai mais receber mensagens automáticas. Se precisar de alguma coisa, pode escrever aqui a qualquer momento.';

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
    const chatId = mensagem.chatId ?? mensagem.from ?? mensagem.chat?.id ?? null;
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

async function podeAutoResponder(matricula) {
    if (!matricula) return false;
    const desde = new Date(Date.now() - HORAS_ENTRE_AUTO_RESPOSTAS * 60 * 60 * 1000);
    const recente = await prisma.respostaWhatsapp.findFirst({
        where: { matricula, criadoEm: { gte: desde }, interpretacao: { not: 'ignorada' } },
        select: { id: true }
    });
    return !recente;
}

// A confirmação sai direto, fora do worker de lote, e NÃO conta contra
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

// O que gravar em cada caso. SAIR é o único que NÃO marca "respondido": quem
// pediu pra não receber mais mensagem não engajou com a pergunta e continua
// precisando de contato humano por outro canal — marcar respondido o tiraria da
// lista de quem a coordenação precisa procurar, o oposto do que o pedido diz.
function dadosDoContato(interpretacao, texto) {
    if (interpretacao.tipo === 'sair') {
        return { observacao: `O aluno pediu para não receber mais mensagens (respondeu "SAIR").` };
    }
    const base = { status: 'respondido', observacao: `Resposta do aluno pelo WhatsApp: "${texto}"` };
    if (!interpretacao.motivo) return base;
    return { ...base, motivoSugerido: interpretacao.motivo, sugeridoPor: interpretacao.tipo };
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
        return { ignorada: true, id: linha.id };
    }

    const original = await acharMensagemOriginal(entrada.chatId, telefone);
    if (!original) {
        // Alguém escreveu pro número por outro motivo, ou a resposta veio fora da
        // janela. Registra e para: não há contato pra atualizar.
        const linha = await registrar({ interpretacao: 'sem_vinculo' });
        return { semVinculo: true, id: linha.id };
    }

    const interpretacao = interpretarResposta(texto);
    const atualizacao = dadosDoContato(interpretacao, texto);

    // Transação: a linha de resposta e o efeito dela (contato, opt-out) entram
    // juntos ou não entram. Sem isso, uma falha no meio deixaria o aluno
    // desinscrito sem registro de por quê.
    const linha = await prisma.$transaction(async (tx) => {
        if (original.contatoId) {
            await tx.contato.update({ where: { id: original.contatoId }, data: atualizacao });
        }
        if (interpretacao.tipo === 'sair') {
            await tx.aluno.update({ where: { matricula: original.matricula }, data: { whatsappOptOut: true } });
        }
        return tx.respostaWhatsapp.create({
            data: {
                messageId: entrada.messageId,
                chatId: entrada.chatId,
                telefone: telefone || null,
                matricula: original.matricula,
                mensagemId: original.id,
                contatoId: original.contatoId,
                texto,
                interpretacao: interpretacao.tipo,
                motivoSugerido: interpretacao.motivo || null,
                recebidaEm: entrada.recebidaEm
            }
        });
    });

    if (await podeAutoResponder(original.matricula)) {
        await responderAluno(
            original.sessaoId,
            entrada.chatId,
            interpretacao.tipo === 'sair' ? RESPOSTA_SAIR : RESPOSTA_RECEBIDA
        );
    }

    // Log sem o conteúdo da mensagem: o CLAUDE.md proíbe jogar dado pessoal de
    // aluno em texto plano sem necessidade, e pra depurar basta o id.
    return { id: linha.id, matricula: original.matricula, interpretacao: interpretacao.tipo, motivo: interpretacao.motivo || null };
}

// Porta de entrada do webhook: decide se o evento é resposta, ack ou nada.
async function processarEvento(corpo) {
    const evento = String(nomeDoEvento(corpo) || '');
    if (evento === 'message.ack' || evento === 'message.failed') return processarAck(corpo);
    // Sem nome de evento, assumimos mensagem recebida: é o caso que importa, e
    // `processarMensagemRecebida` já descarta sozinho o que não for resposta.
    if (!evento || evento === 'message.received') return processarMensagemRecebida(corpo);
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
    DIAS_JANELA_RESPOSTA,
    HORAS_ENTRE_AUTO_RESPOSTAS,
    RESPOSTA_RECEBIDA,
    RESPOSTA_SAIR
};
