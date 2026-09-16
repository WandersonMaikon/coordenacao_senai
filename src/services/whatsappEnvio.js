// Worker do envio de WhatsApp. Roda dentro do próprio processo do Node (um
// container só — por isso uma flag em memória basta pra não sobrepor rodadas).
// A cada TICK_MS, pra cada lote em andamento, decide se já pode mandar a próxima
// mensagem e manda NO MÁXIMO UMA por número. Tudo o que faz o lote esperar
// (fora do horário, limite atingido, número desconectado) vira um texto em
// `lote.aguardando`, que a tela mostra.

const prisma = require('../config/prisma');
const openwa = require('./openwa');
const { mesmoTelefone } = require('./telefone');
const { limiteDiaEfetivo, STATUS_JA_RECEBEU } = require('./whatsappLote');
const { calcularAlunosEmRiscoSemRecuperados } = require('../controllers/alunoController');

const TICK_MS = 15 * 1000;
const FALHAS_PARA_PAUSAR = 3;
const ESPERA_FALHA_TEMPORARIA_MS = 60 * 1000;

// Status do OpenWA em que o número não consegue enviar e alguém precisa agir
// (ler o QR de novo, abrir o WhatsApp no celular).
const STATUS_PRECISA_ACAO = ['disconnected', 'action_required', 'failed'];
const MOTIVO_NUMERO_DIFERENTE = 'O número conectado é diferente do número cadastrado.';

// Contato registrado pela coordenação depois que o lote começou com um destes
// status tira o aluno da fila: alguém já está conversando com ele.
const STATUS_CONTATO_CANCELA = ['respondido', 'acompanhar', 'recuperado'];

// ───────────── Horário da escola ─────────────
// Porto Velho/Ji-Paraná é UTC-4 o ano todo (sem horário de verão), então um
// deslocamento fixo é mais previsível que depender do fuso instalado no container.
const DESLOCAMENTO_MS = -4 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

const doisDigitos = (n) => String(n).padStart(2, '0');

function partesLocais(data) {
    const local = new Date(data.getTime() + DESLOCAMENTO_MS);
    return {
        ano: local.getUTCFullYear(),
        mes: local.getUTCMonth(),
        dia: local.getUTCDate(),
        diaSemana: local.getUTCDay(),
        hhmm: `${doisDigitos(local.getUTCHours())}:${doisDigitos(local.getUTCMinutes())}`
    };
}

function instanteLocal(ano, mes, dia, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(ano, mes, dia, h, m) - DESLOCAMENTO_MS);
}

function inicioDoDia(agora) {
    const p = partesLocais(agora);
    return instanteLocal(p.ano, p.mes, p.dia, '00:00');
}

function inicioDoMes(agora) {
    const p = partesLocais(agora);
    return instanteLocal(p.ano, p.mes, 1, '00:00');
}

// Próximo início de janela (seg–sáb) a partir de `desde`, pulando `pularDias` dias.
function proximaAbertura(sessao, desde, pularDias = 0) {
    for (let i = pularDias; i < pularDias + 10; i++) {
        const p = partesLocais(new Date(desde.getTime() + i * DIA_MS));
        if (p.diaSemana === 0) continue;
        const abertura = instanteLocal(p.ano, p.mes, p.dia, sessao.janelaInicio);
        if (abertura > desde) return abertura;
    }
    return new Date(desde.getTime() + DIA_MS);
}

function janelaAberta(sessao, agora) {
    const p = partesLocais(agora);
    return p.diaSemana !== 0 && p.hhmm >= sessao.janelaInicio && p.hhmm < sessao.janelaFim;
}

// "hoje às 08:00", "amanhã às 08:00", "seg, 21/09 às 08:00"
function descreverQuando(data, agora = new Date()) {
    const p = partesLocais(data);
    const diasDeDistancia = Math.round((inicioDoDia(data) - inicioDoDia(agora)) / DIA_MS);
    const dia = diasDeDistancia === 0 ? 'hoje' : diasDeDistancia === 1 ? 'amanhã' : `${DIAS_SEMANA[p.diaSemana]}, ${doisDigitos(p.dia)}/${doisDigitos(p.mes + 1)}`;
    return `${dia} às ${p.hhmm}`;
}

// ───────────── Estado do lote e do número ─────────────

async function loteEmAndamento(sessaoId) {
    return prisma.loteWhatsapp.findFirst({ where: { sessaoId, status: 'em_andamento' } });
}

async function atualizarLote(lote, dados) {
    // Só grava o que mudou — o worker passa por aqui a cada 15s por lote.
    const mudou = Object.entries(dados).some(([campo, valor]) => {
        const atual = lote[campo];
        if (valor instanceof Date || atual instanceof Date) return new Date(atual || 0).getTime() !== new Date(valor || 0).getTime();
        return atual !== valor;
    });
    if (!mudou) return lote;
    const atualizado = await prisma.loteWhatsapp.update({ where: { id: lote.id }, data: dados });
    Object.assign(lote, atualizado);
    return lote;
}

async function pausarSessao(sessao, lote, motivo) {
    if (sessao.pausadoMotivo !== motivo) {
        await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { pausadoMotivo: motivo } });
        sessao.pausadoMotivo = motivo;
    }
    await atualizarLote(lote, { aguardando: `Pausado: ${motivo}` });
}

async function contarEnvios(sessaoId, agora) {
    const [hoje, mes] = await Promise.all([
        prisma.mensagemWhatsapp.count({ where: { sessaoId, enviadaEm: { gte: inicioDoDia(agora) } } }),
        prisma.mensagemWhatsapp.count({ where: { sessaoId, enviadaEm: { gte: inicioDoMes(agora) } } })
    ]);
    return { hoje, mes };
}

// Motivo pra tirar a mensagem da fila na hora de enviar, ou null. A situação pode
// ter mudado desde que o lote foi montado (às vezes dias antes, por causa do
// limite diário).
async function motivoParaCancelar(mensagem, sessao, lote) {
    const [aluno, turma, contatoRecente, { emRisco }] = await Promise.all([
        prisma.aluno.findUnique({ where: { matricula: mensagem.matricula }, select: { whatsappOptOut: true } }),
        prisma.usuarioTurma.findUnique({ where: { codigoTurma: mensagem.codigoTurma } }),
        prisma.contato.findFirst({
            where: { matricula: mensagem.matricula, criadoEm: { gte: lote.iniciadoEm }, status: { in: STATUS_CONTATO_CANCELA } },
            select: { id: true }
        }),
        calcularAlunosEmRiscoSemRecuperados()
    ]);

    if (aluno?.whatsappOptOut) return 'O aluno pediu para não receber mensagens (SAIR)';
    if (!turma || turma.usuarioId !== sessao.usuarioId) return 'A turma foi liberada';
    if (contatoRecente) return 'A coordenação já falou com o aluno';

    const risco = emRisco.find((item) => item.matricula === mensagem.matricula && item.codigoTurma === mensagem.codigoTurma);
    if (!risco) return 'O aluno voltou a ter presença (ou está em acompanhamento de recuperado)';
    if (risco.primeiraFalta !== mensagem.primeiraFalta) return 'O aluno voltou e começou a faltar de novo — inicie um novo envio';
    return null;
}

// ───────────── Uma rodada pra um lote ─────────────

async function processarLote(lote, agora = new Date()) {
    const sessao = await prisma.whatsappSessao.findUnique({ where: { id: lote.sessaoId }, include: { usuario: true } });
    if (!sessao) {
        await atualizarLote(lote, { status: 'parado', paradoPor: 'Número removido', finalizadoEm: agora });
        return;
    }

    if (sessao.pausadoMotivo) return atualizarLote(lote, { aguardando: `Pausado: ${sessao.pausadoMotivo}` });
    if (!sessao.sessionId) return pausarSessao(sessao, lote, 'O WhatsApp não está conectado.');

    // 1. O número está pronto? (consulta o OpenWA a cada rodada: é o único jeito de
    //    perceber que o celular desconectou antes de tentar mandar)
    let remota;
    try {
        remota = await openwa.obterSessao(sessao.sessionId);
    } catch (erro) {
        if (erro.status === 404) return pausarSessao(sessao, lote, 'A conexão do WhatsApp foi perdida. Conecte o número de novo.');
        if (erro.fatal) return pausarSessao(sessao, lote, 'O servidor do WhatsApp recusou a chave de acesso. Fale com o administrador.');
        return atualizarLote(lote, { aguardando: 'Sem comunicação com o servidor do WhatsApp — tentando de novo.' });
    }
    if (remota.status !== sessao.status || (remota.phone && String(remota.phone) !== sessao.telefoneConectado)) {
        await prisma.whatsappSessao.update({
            where: { id: sessao.id },
            data: { status: remota.status, ...(remota.phone ? { telefoneConectado: String(remota.phone) } : {}) }
        });
    }
    if (STATUS_PRECISA_ACAO.includes(remota.status)) return pausarSessao(sessao, lote, 'O WhatsApp foi desconectado. Conecte o número de novo.');
    if (remota.status !== 'ready') return atualizarLote(lote, { aguardando: 'Aguardando o WhatsApp terminar de conectar…' });
    if (remota.phone && !mesmoTelefone(sessao.telefone, remota.phone)) return pausarSessao(sessao, lote, MOTIVO_NUMERO_DIFERENTE);

    // 2. Horário e limites
    if (!janelaAberta(sessao, agora)) {
        const abre = proximaAbertura(sessao, agora);
        return atualizarLote(lote, { aguardando: `Fora do horário de envio — retoma ${descreverQuando(abre, agora)}.`, proximoEnvioEm: abre });
    }
    const { hoje, mes } = await contarEnvios(sessao.id, agora);
    if (mes >= sessao.limiteMes) {
        const p = partesLocais(agora);
        const abre = proximaAbertura(sessao, instanteLocal(p.ano, p.mes + 1, 1, '00:00'));
        return atualizarLote(lote, { aguardando: `Limite do mês atingido (${sessao.limiteMes}) — retoma ${descreverQuando(abre, agora)}.`, proximoEnvioEm: abre });
    }
    const limiteHoje = limiteDiaEfetivo(sessao, agora);
    if (hoje >= limiteHoje) {
        const abre = proximaAbertura(sessao, inicioDoDia(agora), 1);
        return atualizarLote(lote, { aguardando: `Limite do dia atingido (${limiteHoje}) — retoma ${descreverQuando(abre, agora)}.`, proximoEnvioEm: abre });
    }

    // 3. Intervalo desde a última mensagem
    if (lote.proximoEnvioEm && agora < lote.proximoEnvioEm) {
        return atualizarLote(lote, { aguardando: null });
    }

    // 4. Próxima da fila. Chegou aqui = nada impede o envio; limpa qualquer aviso
    //    de espera antigo ("Pausado", "Limite do dia"), mesmo que a mensagem acabe
    //    cancelada logo abaixo.
    await atualizarLote(lote, { aguardando: null });
    const mensagem = await prisma.mensagemWhatsapp.findFirst({ where: { loteId: lote.id, status: 'pendente' }, orderBy: { id: 'asc' } });
    if (!mensagem) {
        return atualizarLote(lote, { status: 'concluido', aguardando: null, proximoEnvioEm: null, finalizadoEm: agora });
    }

    const motivoCancelar = await motivoParaCancelar(mensagem, sessao, lote);
    if (motivoCancelar) {
        // Cancelar não consome intervalo: a próxima da fila sai na rodada seguinte.
        await prisma.mensagemWhatsapp.update({ where: { id: mensagem.id }, data: { status: 'cancelada', erro: motivoCancelar } });
        return;
    }

    await prisma.mensagemWhatsapp.update({ where: { id: mensagem.id }, data: { status: 'enviando' } });
    await atualizarLote(lote, { aguardando: null });

    let etapa = 'ao verificar se o número tem WhatsApp';
    try {
        // Se esta verificação falhar, NÃO envia "mesmo assim": em produção o erro
        // "[comms] sendIq called before startComms" mostrou que a conexão interna do
        // WhatsApp Web inteira não subiu — o send-text respondia 201 e a mensagem
        // nunca saía. Verificar é o que prova que o número consegue falar com o
        // WhatsApp antes de marcar algo como enviado.
        const verificacao = await openwa.verificarNumero(sessao.sessionId, `55${mensagem.telefone}`);

        if (!verificacao?.exists) {
            await prisma.mensagemWhatsapp.update({
                where: { id: mensagem.id },
                data: { status: 'falhou', falhaDefinitiva: true, erro: 'Este número não tem WhatsApp' }
            });
            return;
        }

        const chatId = verificacao.whatsappId || `55${mensagem.telefone}@c.us`;
        etapa = 'ao enviar a mensagem';
        const envio = await openwa.enviarTexto(sessao.sessionId, chatId, mensagem.texto);
        etapa = 'ao registrar o contato';
        const enviadaEm = new Date();

        // O envio vira contato no histórico do aluno: some do "sem contato" do
        // painel e aparece na /risco. "Sem resposta" até ele responder.
        const contato = await prisma.contato.create({
            data: {
                matricula: mensagem.matricula,
                canal: 'whatsapp',
                status: 'sem_resposta',
                observacao: 'Mensagem automática enviada pelo WhatsApp.',
                contatadoPor: sessao.usuario.usuario
            }
        });
        await prisma.mensagemWhatsapp.update({
            where: { id: mensagem.id },
            data: { status: 'enviada', chatId, messageId: envio?.messageId || null, contatoId: contato.id, enviadaEm, erro: null }
        });
        if (sessao.falhasSeguidas) await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { falhasSeguidas: 0 } });

        // Intervalo sorteado entre mínimo e máximo — ritmo fixo é padrão de robô.
        const intervaloSeg = sessao.intervaloMinSeg + Math.floor(Math.random() * (sessao.intervaloMaxSeg - sessao.intervaloMinSeg + 1));
        await atualizarLote(lote, { aguardando: null, proximoEnvioEm: new Date(enviadaEm.getTime() + intervaloSeg * 1000) });
    } catch (erro) {
        console.error(`[whatsapp] lote ${lote.id}, mensagem ${mensagem.id}: falha ${etapa}:`, erro.message);
        await tratarFalhaEnvio(erro, mensagem, sessao, lote, etapa);
    }
}

async function tratarFalhaEnvio(erro, mensagem, sessao, lote, etapa) {
    const descricao = `Falha ${etapa}: ${erro.message}`.slice(0, 250);
    // Mesmo quando volta pra fila, guarda o erro — a tela mostra embaixo do "Na fila".
    const voltarPraFila = () => prisma.mensagemWhatsapp.update({ where: { id: mensagem.id }, data: { status: 'pendente', erro: descricao } });

    if (!(erro instanceof openwa.ErroOpenWA)) {
        await voltarPraFila();
        throw erro;
    }
    // A VERIFICAÇÃO do número deu erro interno (500) ou travou (sem resposta em 30s):
    // a sessão diz "ready", mas o WhatsApp Web por dentro não está funcionando (no log
    // do OpenWA: "[comms] sendIq called before startComms"). Visto em produção em
    // 15-16/09/2026. Insistir não resolve e não é problema do aluno: pausa já.
    if ((erro.status === 500 || erro.status === null) && etapa.startsWith('ao verificar')) {
        await voltarPraFila();
        return pausarSessao(sessao, lote, 'O WhatsApp conectado não está respondendo às consultas. Desconecte e conecte o número de novo (aba Meu número); se continuar, fale com o administrador.');
    }
    if (erro.fatal) {
        await voltarPraFila();
        return pausarSessao(sessao, lote, 'O servidor do WhatsApp recusou a chave de acesso. Fale com o administrador.');
    }
    if (erro.status === 429) {
        await voltarPraFila();
        const esperaSeg = erro.retryAfter || 300;
        return atualizarLote(lote, { aguardando: 'O WhatsApp pediu para diminuir o ritmo — aguardando.', proximoEnvioEm: new Date(Date.now() + esperaSeg * 1000) });
    }

    const falhas = sessao.falhasSeguidas + 1;
    await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { falhasSeguidas: falhas } });
    sessao.falhasSeguidas = falhas;

    if (erro.retentavel) {
        await voltarPraFila();
    } else {
        // Erro do próprio pedido (ex: 400) — tentar a mesma mensagem de novo daria o
        // mesmo erro. Fica como falha temporária: pode entrar num lote novo.
        await prisma.mensagemWhatsapp.update({ where: { id: mensagem.id }, data: { status: 'falhou', erro: descricao } });
    }

    if (falhas >= FALHAS_PARA_PAUSAR) {
        return pausarSessao(sessao, lote, `${falhas} falhas seguidas (última ${etapa}: ${erro.message.slice(0, 100)}).`);
    }
    return atualizarLote(lote, { aguardando: `Falha ${etapa} — nova tentativa em 1 minuto.`, proximoEnvioEm: new Date(Date.now() + ESPERA_FALHA_TEMPORARIA_MS) });
}

// ───────────── Loop ─────────────

let rodando = false;
let timer = null;

async function rodada() {
    if (rodando) return;
    rodando = true;
    try {
        const lotes = await prisma.loteWhatsapp.findMany({ where: { status: 'em_andamento' } });
        for (const lote of lotes) {
            try {
                await processarLote(lote);
            } catch (erro) {
                console.error(`[whatsapp] erro no lote ${lote.id}:`, erro.message);
            }
        }
    } catch (erro) {
        console.error('[whatsapp] erro na rodada:', erro.message);
    } finally {
        rodando = false;
    }
}

// Mensagem que estava "enviando" quando o servidor caiu pode ter saído ou não. Na
// dúvida, não reenvia (mandar duas vezes pro aluno é pior que uma a menos) e deixa
// registrado pra quem acompanha conferir no celular.
async function recuperarInterrompidas() {
    await prisma.mensagemWhatsapp.updateMany({
        where: { status: 'enviando' },
        data: { status: 'falhou', falhaDefinitiva: true, erro: 'Envio interrompido (o servidor reiniciou) — confira no WhatsApp se a mensagem saiu' }
    });
}

function iniciarWorker() {
    if (timer || !openwa.configurado()) {
        if (!openwa.configurado()) console.log('[whatsapp] OpenWA não configurado — envio automático desligado.');
        return;
    }
    recuperarInterrompidas()
        .catch((erro) => console.error('[whatsapp] erro ao recuperar envios interrompidos:', erro.message))
        .finally(() => {
            timer = setInterval(rodada, TICK_MS);
            console.log('[whatsapp] worker de envio iniciado.');
        });
}

// Parar e cancelar pendentes — usado pelo botão "Parar envio" e ao liberar turma.
async function pararLote(lote, paradoPor) {
    await prisma.mensagemWhatsapp.updateMany({
        where: { loteId: lote.id, status: 'pendente' },
        data: { status: 'cancelada', erro: `Envio parado por ${paradoPor}` }
    });
    return prisma.loteWhatsapp.update({
        where: { id: lote.id },
        data: { status: 'parado', paradoPor, aguardando: null, proximoEnvioEm: null, finalizadoEm: new Date() }
    });
}

module.exports = {
    TICK_MS,
    STATUS_PRECISA_ACAO,
    MOTIVO_NUMERO_DIFERENTE,
    STATUS_JA_RECEBEU,
    iniciarWorker,
    processarLote,
    loteEmAndamento,
    pararLote,
    contarEnvios,
    // exportados pros testes e pra tela
    partesLocais,
    janelaAberta,
    proximaAbertura,
    descreverQuando,
    inicioDoDia
};
