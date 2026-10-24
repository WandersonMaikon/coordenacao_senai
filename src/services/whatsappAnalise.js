// A IA local lê a conversa inteira do robô com o aluno e deixa pronto, para a
// /contatar, o que a coordenação teria que escrever à mão: um resumo para a
// observação, a situação (vai voltar, vai desistir, pediu ajuda...) e o motivo.
//
// O motivo só é gravado em `conversaMotivo` quando há CERTEZA (motivoComCerteza):
// a IA e o dicionário, lendo as mesmas mensagens, chegaram ao mesmo motivo — ou
// o aluno escolheu pelo número do menu. Fora isso fica vazio e
// a pessoa escolhe. Mesmo com certeza, nada entra no gráfico de motivos sem o
// clique de alguém da coordenação em "Salvar contato" (decisão de 22/10/2026:
// o gráfico vai para a diretoria).
//
// Quando roda: um tempo depois da última mensagem do aluno (ESPERA_MS), para ler
// a conversa de uma vez em vez de a cada "oi"; e, para conversas antigas ou que
// ficaram para trás num reinício do servidor, quando a /contatar encontra uma
// conversa sem análise atualizada (garantirAnalises).

const prisma = require('../config/prisma');
const { analisarConversa, configurado } = require('./iaLocal');
const { interpretarResposta } = require('./classificarResposta');

const ESPERA_MS = 60 * 1000;

// Uma análise por vez: o Ollama atende um pedido de cada vez (OLLAMA_NUM_PARALLEL
// = 1) e, com vários na fila dele, os últimos estourariam o tempo limite.
let fila = Promise.resolve();
const agendadas = new Map();

// A "certeza" que o próprio modelo declara não serve: no teste de 24/10/2026 ele
// disse "baixa" para "comecei a trabalhar e o horário bate". O critério é a
// concordância de dois leitores independentes — a IA e o dicionário (que só
// acha motivo com a palavra escrita) — e o dicionário sem achar outro motivo.
function motivoComCerteza({ ia, motivosDicionario, motivoMenu }) {
    if (motivoMenu) return motivoMenu;
    if (!ia || ia.motivo === 'nenhum') return null;
    return motivosDicionario.size === 1 && motivosDicionario.has(ia.motivo) ? ia.motivo : null;
}

async function analisar(mensagemId) {
    const mensagem = await prisma.mensagemWhatsapp.findUnique({ where: { id: mensagemId } });
    if (!mensagem) return null;
    const respostas = await prisma.respostaWhatsapp.findMany({
        where: { mensagemId, interpretacao: { notIn: ['ignorada', 'sem_vinculo'] } },
        orderBy: { recebidaEm: 'asc' }
    });
    if (respostas.length === 0) return null;

    const trechos = [{ quem: 'robo', texto: mensagem.texto }];
    for (const r of respostas) {
        trechos.push({ quem: 'aluno', texto: r.texto });
        if (r.respostaRobo) trechos.push({ quem: 'robo', texto: r.respostaRobo });
    }

    const ia = await analisarConversa(trechos);
    if (!ia) return null;

    const motivosDicionario = new Set(respostas.map((r) => interpretarResposta(r.texto).motivo).filter(Boolean));
    const motivoMenu = respostas.find((r) => r.interpretacao === 'menu')?.motivoSugerido || null;

    return prisma.mensagemWhatsapp.update({
        where: { id: mensagemId },
        data: {
            conversaResumo: ia.resumo,
            conversaSituacao: ia.situacao,
            conversaMotivo: motivoComCerteza({ ia, motivosDicionario, motivoMenu }),
            conversaMotivoIa: ia.motivo === 'nenhum' ? null : ia.motivo,
            conversaAnalisadaEm: new Date()
        }
    });
}

// Marca a conversa para ser lida daqui a `esperaMs`. Chamado de novo antes disso
// (o aluno mandou outra mensagem), o relógio recomeça.
function agendarAnalise(mensagemId, esperaMs = ESPERA_MS) {
    if (!configurado()) return;
    clearTimeout(agendadas.get(mensagemId));
    const timer = setTimeout(() => {
        agendadas.delete(mensagemId);
        fila = fila.then(() => analisar(mensagemId)).catch((erro) => {
            console.error('[ia] erro ao analisar conversa', mensagemId, erro.message);
        });
    }, esperaMs);
    timer.unref();
    agendadas.set(mensagemId, timer);
}

// mensagens: [{ id, conversaAnalisadaEm }] com a data da última resposta de cada
// uma (`ultimaRespostaEm`). Agenda as que nunca foram lidas ou receberam
// mensagem nova depois da última leitura.
function garantirAnalises(mensagens) {
    for (const m of mensagens) {
        if (agendadas.has(m.id)) continue;
        if (m.conversaAnalisadaEm && m.conversaAnalisadaEm >= m.ultimaRespostaEm) continue;
        agendarAnalise(m.id, 1000);
    }
}

module.exports = { agendarAnalise, garantirAnalises, analisar, motivoComCerteza, ESPERA_MS };
