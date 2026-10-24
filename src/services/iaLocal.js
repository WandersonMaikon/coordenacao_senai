// IA local para entender a resposta do aluno no WhatsApp: um modelo de linguagem
// gratuito (Gemma, por padrão) rodando no próprio servidor da escola pelo Ollama
// (container ollama_retencao). A frase do aluno NÃO sai do servidor — foi por
// isso que esta opção entrou no lugar de uma API externa (ver "Decisões" no
// CLAUDE.md e docs/visao/VISAO.md).
//
// O que ela faz e o que não faz:
// - Só INTERPRETA: devolve a intenção (promessa, desistência, motivo...) e o
//   motivo. Nunca escreve resposta para o aluno — o robô continua mandando só os
//   textos fixos de whatsappResposta.js.
// - O dicionário de classificarResposta.js continua como reserva: IA desligada,
//   modelo ainda baixando, lenta ou com resposta fora do formato → vale o
//   dicionário, como antes.
// - Travas que valem por cima da IA (o erro caro é dizer "Combinado!" a quem não
//   prometeu nada): negação/dúvida no texto impede promessa; desistência vista
//   pela IA OU pelo dicionário vira desistência; assunto delicado visto por
//   qualquer um dos dois vai para uma pessoa.

const { MOTIVOS } = require('../config/motivos');
const {
    interpretarResposta,
    temNegacaoOuDuvida,
    MOTIVOS_DELICADOS
} = require('./classificarResposta');

const MODELO = process.env.OLLAMA_MODELO || 'gemma3:4b';
// Sem placa de vídeo, o primeiro pedido depois de um tempo parado carrega o
// modelo na memória (dezenas de segundos); os seguintes levam poucos segundos.
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 90000;
// Quanto tempo o modelo fica na memória depois do último uso. Mais tempo =
// resposta mais rápida, mas ~3-4 GB de RAM ocupados enquanto isso.
const MANTER_CARREGADO = process.env.OLLAMA_KEEP_ALIVE || '30m';

function configurado() {
    return Boolean(process.env.OLLAMA_URL) && process.env.IA_RESPOSTAS !== 'off';
}

function url(caminho) {
    return `${process.env.OLLAMA_URL.replace(/\/$/, '')}${caminho}`;
}

const CHAVES_MOTIVO = MOTIVOS.filter((m) => m.chave !== 'outro').map((m) => m.chave);

// Formato que o Ollama força na saída (JSON schema): o modelo só consegue
// devolver um destes valores — nada de texto livre para interpretar depois.
const FORMATO = {
    type: 'object',
    properties: {
        intencao: { type: 'string', enum: ['promessa', 'desistencia', 'motivo', 'duvida', 'outro'] },
        motivo: { type: 'string', enum: [...CHAVES_MOTIVO, 'nenhum'] }
    },
    required: ['intencao', 'motivo']
};

const INSTRUCOES = `Você classifica respostas de alunos de um curso técnico do SENAI. A escola mandou ao aluno uma mensagem de WhatsApp dizendo que sentiu falta dele nas aulas e perguntando se ele consegue vir na próxima aula. Você recebe só a resposta do aluno.

Responda com a intenção principal:
- "promessa": o aluno afirma que vai vir/voltar na próxima aula ou numa data próxima ("sim", "amanhã eu vou", "segunda estou aí").
- "desistencia": o aluno diz que vai sair, desistir, trancar, cancelar ou não continuar o curso.
- "motivo": o aluno explica por que faltou, sem prometer voltar nem desistir.
- "duvida": o aluno faz uma pergunta (horário, reposição, atestado...).
- "outro": qualquer outra coisa (cumprimento, recusa sem explicação, texto sem sentido, incerteza como "talvez" ou "não sei").

Regras:
- Na dúvida entre "promessa" e outra opção, NÃO escolha "promessa".
- Se houver negação ou incerteza sobre vir ("não vou", "acho que não", "talvez"), não é "promessa".
- Se o aluno fala em sair do curso, é "desistencia", mesmo que use palavras como "estarei" ou "vou".
- "desistencia" é deixar o curso de vez. Faltar por uns dias ou "não vou conseguir ir essa semana" não é desistência.
- Respostas curtas de concordância ("ok", "blz", "certo") não têm motivo: use "nenhum".

E o motivo da falta, se o aluno disse (mesmo junto de uma promessa ou desistência):
transporte (ônibus, carona, falta de dinheiro para a passagem), trabalho (emprego, horário do serviço), saude_atestado (doença com atestado), saude_sem_atestado (o próprio aluno doente, sem atestado ou sem dizer), saude_mental (ansiedade, depressão, crise), financeiro (só dinheiro em geral, sem falar de passagem), desmotivacao_curso (não gosta do curso, desanimado), problema_familiar (família, filho doente, luto, cuidar de alguém), ou "nenhum" se não disse.`;

async function chamar(caminho, corpo, timeoutMs) {
    const resposta = await fetch(url(caminho), {
        method: corpo ? 'POST' : 'GET',
        headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!resposta.ok) throw new Error(`Ollama ${resposta.status}: ${(await resposta.text()).slice(0, 200)}`);
    return resposta.json();
}

// Pergunta ao modelo. Devolve { intencao, motivo } ou null (e quem chama usa o
// dicionário). Nunca lança.
async function perguntar(texto) {
    if (!configurado()) return null;
    try {
        const dados = await chamar('/api/chat', {
            model: MODELO,
            stream: false,
            format: FORMATO,
            keep_alive: MANTER_CARREGADO,
            options: { temperature: 0 },
            messages: [
                { role: 'system', content: INSTRUCOES },
                { role: 'user', content: String(texto).slice(0, 1500) }
            ]
        }, TIMEOUT_MS);
        const saida = JSON.parse(dados?.message?.content || '{}');
        if (!FORMATO.properties.intencao.enum.includes(saida.intencao)) return null;
        if (!FORMATO.properties.motivo.enum.includes(saida.motivo)) saida.motivo = 'nenhum';
        return saida;
    } catch (erro) {
        // Sem o texto do aluno no log (dados de menores).
        console.warn('[ia] sem resposta do modelo local, usando o dicionário:', erro.message);
        return null;
    }
}

// Mesmo contrato de interpretarResposta ({ tipo, motivo? }), mais `fonte`
// ('ia' ou 'dicionario'). É o que whatsappResposta.js chama.
async function interpretar(texto) {
    const dicionario = interpretarResposta(texto);
    // SAIR e número do menu são exatos: não há o que a IA acrescentar.
    if (['sair', 'menu'].includes(dicionario.tipo)) return { ...dicionario, fonte: 'dicionario' };

    const ia = await perguntar(texto);
    if (!ia) return { ...dicionario, fonte: 'dicionario' };

    // Dicionário primeiro, IA para as lacunas. Medido em 23/10/2026 com 30
    // respostas reais/difíceis: sozinho, o gemma3:4b acertou 22 (puxa
    // "financeiro" pra tudo e chegou a ler "ok" como doença) e o dicionário 26 —
    // mas os erros não se sobrepõem: a IA entende o que o dicionário não pega
    // ("Simmm amanhã to aí", "fiquei gripado"), e o dicionário é preciso quando
    // acha a palavra. Combinados assim: 28 de 30, e os dois erros que sobram vão
    // para uma pessoa em vez de virar "Combinado!".
    if (dicionario.tipo !== 'nao_entendido') {
        // Única exceção: a IA vê desistência onde o dicionário viu promessa —
        // vence a desistência, que é o lado seguro (uma pessoa lê).
        if (dicionario.tipo === 'promessa' && ia.intencao === 'desistencia') {
            return dicionario.motivo ? { tipo: 'desistencia', motivo: dicionario.motivo, fonte: 'ia' } : { tipo: 'desistencia', fonte: 'ia' };
        }
        return { ...dicionario, fonte: 'dicionario' };
    }

    const motivo = ia.motivo !== 'nenhum' ? ia.motivo : null;
    const comMotivo = (tipo) => (motivo ? { tipo, motivo, fonte: 'ia' } : { tipo, fonte: 'ia' });

    if (ia.intencao === 'desistencia') return comMotivo('desistencia');
    if (ia.intencao === 'promessa' && !MOTIVOS_DELICADOS.includes(motivo) && !temNegacaoOuDuvida(texto)) return comMotivo('promessa');
    if (motivo) return { tipo: 'palavras_chave', motivo, fonte: 'ia' };
    return { tipo: 'nao_entendido', fonte: 'ia' };
}

// ───────────── Leitura da conversa inteira (para a coordenação) ─────────────
//
// Diferente de `interpretar` (uma mensagem, decide o próximo passo do robô),
// aqui a IA lê a conversa toda e escreve um resumo para a OBSERVAÇÃO do contato
// na /contatar. É o único texto que a IA escreve — e é para a coordenação ler e
// conferir, nunca para o aluno (whatsappAnalise.js).

const SITUACOES = ['vai_voltar', 'vai_desistir', 'pediu_ajuda', 'explicou_motivo', 'sem_informacao'];

const FORMATO_ANALISE = {
    type: 'object',
    properties: {
        resumo: { type: 'string' },
        situacao: { type: 'string', enum: SITUACOES },
        motivo: { type: 'string', enum: [...CHAVES_MOTIVO, 'nenhum'] }
    },
    required: ['resumo', 'situacao', 'motivo']
};

const INSTRUCOES_ANALISE = `Você ajuda a coordenação de um curso técnico do SENAI. Recebe uma conversa de WhatsApp entre o robô da escola ("Robô") e um aluno que está faltando às aulas ("Aluno"). Escreva para a coordenação:

- resumo: no máximo 2 frases curtas contando só o que o ALUNO disse. Comece sem sujeito, com "Disse que" ou "Contou que" (não use "o aluno" nem "a aluna"). Não invente nada que não esteja nas mensagens do aluno, não dê conselhos e não repita o que o robô falou. Se o aluno mandou áudio ou foto, escreva "Mandou um áudio" ou "Mandou uma foto".
- situacao: "vai_voltar" (disse que vem para a aula), "vai_desistir" (disse que vai sair, desistir, trancar ou que não vai continuar o curso), "pediu_ajuda" (aceitou conversar com a coordenação ou pediu ajuda), "explicou_motivo" (explicou por que está faltando, sem os casos anteriores), "sem_informacao" (não deu para saber).
- motivo: transporte (ônibus, carona, passagem), trabalho (emprego, horário do serviço), saude_atestado (doente com atestado), saude_sem_atestado (doente sem atestado ou sem dizer), saude_mental (ansiedade, depressão, crise), financeiro (dinheiro em geral), desmotivacao_curso (não gosta do curso, desanimado), problema_familiar (família, luto, cuidar de alguém), ou "nenhum" se o aluno não disse. Falar com a secretaria, com o professor ou com a mãe sobre o curso NÃO é problema familiar.`;

// trechos: [{ quem: 'robo' | 'aluno', texto }]. Devolve { resumo, situacao,
// motivo } ou null (IA desligada, lenta ou fora do formato). Nunca lança.
async function analisarConversa(trechos) {
    if (!configurado()) return null;
    const conversa = trechos
        .map((t) => `${t.quem === 'robo' ? 'Robô' : 'Aluno'}: ${String(t.texto).slice(0, 600)}`)
        .join('\n');
    try {
        const dados = await chamar('/api/chat', {
            model: MODELO,
            stream: false,
            format: FORMATO_ANALISE,
            keep_alive: MANTER_CARREGADO,
            options: { temperature: 0 },
            messages: [
                { role: 'system', content: INSTRUCOES_ANALISE },
                { role: 'user', content: conversa.slice(0, 4000) }
            ]
        }, TIMEOUT_MS);
        const saida = JSON.parse(dados?.message?.content || '{}');
        const resumo = String(saida.resumo || '').trim();
        if (!resumo || !SITUACOES.includes(saida.situacao)) return null;
        return {
            resumo: resumo.slice(0, 500),
            situacao: saida.situacao,
            motivo: FORMATO_ANALISE.properties.motivo.enum.includes(saida.motivo) ? saida.motivo : 'nenhum'
        };
    } catch (erro) {
        // Sem o texto da conversa no log (dados de menores).
        console.warn('[ia] não foi possível analisar a conversa:', erro.message);
        return null;
    }
}

// Sem conseguir falar com o Ollama, tenta de novo depois deste tempo. Visto no
// 1º deploy (23/10/2026): o atualizar.sh sobe o node_retencao ANTES de criar o
// ollama_retencao, a única tentativa deu "fetch failed" e o modelo nunca foi baixado.
const TENTAR_DE_NOVO_MS = 5 * 60 * 1000;

// Na subida do servidor: confere se o modelo já está baixado e, se não, manda o
// Ollama baixar (alguns GB, só na primeira vez). Enquanto baixa, vale o dicionário.
async function garantirModelo() {
    if (!configurado()) {
        console.log('[ia] IA local desligada (sem OLLAMA_URL ou IA_RESPOSTAS=off) — respostas pelo dicionário.');
        return;
    }
    try {
        const { models = [] } = await chamar('/api/tags', null, 10000);
        if (models.some((m) => m.name === MODELO || m.model === MODELO)) {
            console.log(`[ia] modelo local ${MODELO} pronto.`);
            return;
        }
        console.log(`[ia] baixando o modelo ${MODELO} (só na primeira vez; pode levar vários minutos)...`);
        await chamar('/api/pull', { model: MODELO, stream: false }, 2 * 60 * 60 * 1000);
        console.log(`[ia] modelo ${MODELO} baixado.`);
    } catch (erro) {
        console.warn(`[ia] não foi possível preparar o modelo local — respostas pelo dicionário; nova tentativa em ${TENTAR_DE_NOVO_MS / 60000} min:`, erro.message);
        setTimeout(garantirModelo, TENTAR_DE_NOVO_MS).unref();
    }
}

module.exports = { configurado, interpretar, perguntar, analisarConversa, garantirModelo, MODELO, INSTRUCOES, SITUACOES };
