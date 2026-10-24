// A fila de trabalho da coordenação (tela /contatar): quem está em risco e o robô
// do WhatsApp NÃO resolve — precisa de uma pessoa, por ligação, WhatsApp pessoal
// ou presencialmente. É a etapa 3 do funil (docs/visao/VISAO.md).
//
// Não é uma tabela: é calculado na hora a partir do risco, das mensagens
// automáticas, das respostas e dos contatos. Por isso o aluno sai da lista
// sozinho quando volta a ter presença (sai do risco) ou quando alguém registra
// um contato que resolve (RESOLVE_CASO) depois do motivo que o trouxe pra cá.

const prisma = require('../config/prisma');
const {
    calcularAlunosEmRiscoSemRecuperados,
    converterDataAula,
    diaNoFusoDaEscola
} = require('../controllers/alunoController');
const { STATUS_JA_RECEBEU } = require('./whatsappLote');
const { interpretarResposta } = require('./classificarResposta');
const { garantirAnalises } = require('./whatsappAnalise');
const { DIAS_PARA_SEGUNDA } = require('./whatsappAutomatico');

const DIA_MS = 24 * 60 * 60 * 1000;

// Sem resposta depois da 2ª (e última) mensagem automática há este tempo: o robô
// já parou, é caso de pessoa.
const DIAS_SEM_RESPOSTA = 3;
// Rede de segurança: se a 2ª não chegou a sair (envio desligado, turma fora do
// piloto, limite), a 1ª sem resposta há este tempo também vira caso de pessoa —
// senão o aluno ficaria esperando um robô que não vai mandar nada.
const DIAS_SEM_SEGUNDA = 10;

// Contato registrado depois do motivo com um destes status tira o aluno da lista.
// "Sem resposta" e "Não foi possível contatar" não tiram: tentaram e não deu, o
// aluno continua precisando — a linha só passa a mostrar a última tentativa.
const RESOLVE_CASO = ['respondido', 'acompanhar', 'recuperado'];

const MOTIVOS_DELICADOS = ['saude_mental', 'problema_familiar'];

// Por que o aluno está na lista, em ordem de prioridade (1 = primeiro).
const MOTIVOS_LISTA = {
    desistencia: { prioridade: 1, rotulo: 'Disse que vai sair do curso' },
    delicado: { prioridade: 1, rotulo: 'Assunto delicado na resposta' },
    pediu_ajuda: { prioridade: 2, rotulo: 'Pediu para a coordenação falar com ele' },
    promessa_quebrada: { prioridade: 2, rotulo: 'Prometeu voltar e faltou de novo' },
    respondeu: { prioridade: 3, rotulo: 'Respondeu e precisa de retorno' },
    sem_resposta: { prioridade: 4, rotulo: 'Não respondeu às mensagens automáticas' },
    sair: { prioridade: 5, rotulo: 'Pediu para não receber WhatsApp (SAIR)' },
    sem_whatsapp: { prioridade: 5, rotulo: 'O número não tem WhatsApp' },
    // Não é trabalho pendente: só informação. Fica no fim e fora do contador do menu.
    robo_cuidando: { prioridade: 6, rotulo: 'O robô ainda está cuidando' }
};

function textoCurto(texto, limite = 200) {
    if (!texto) return null;
    return texto.length > limite ? `${texto.slice(0, limite)}…` : texto;
}

// Qual das respostas do sumiço define o caso. `respostas` vem da mais recente
// para a mais antiga. O texto é relido com o dicionário de agora (e não só com a
// interpretação gravada na hora): correção no dicionário vale para as conversas
// antigas também — foi assim que "eu falei a secretária que iria sair do curso",
// gravada como problema familiar por um erro já corrigido, virou desistência.
function respostaQueDefine(respostas, analise) {
    const lida = respostas.map((r) => ({ r, dic: interpretarResposta(r.texto) }));

    // Desistência dita em qualquer ponto da conversa, por qualquer um dos dois.
    const desistencia = lida.find(({ r, dic }) => r.interpretacao === 'desistencia' || dic.tipo === 'desistencia');
    if (desistencia || analise?.conversaSituacao === 'vai_desistir') {
        return { motivo: 'desistencia', resposta: desistencia?.r || respostas[0] };
    }

    // Delicado só com o dicionário (palavra exata) E a IA de acordo, quando ela
    // leu a conversa: errar para "delicado" põe no topo quem não contou nada.
    const delicada = lida.find(({ dic }) => MOTIVOS_DELICADOS.includes(dic.motivo));
    if (delicada && (!analise || MOTIVOS_DELICADOS.includes(analise.conversaMotivoIa))) {
        return { motivo: 'delicado', resposta: delicada.r };
    }

    if (respostas[0].interpretacao === 'promessa') return { motivo: 'promessa', resposta: respostas[0] };

    // Respondeu SIM a "quer que alguém da coordenação converse com você?": é uma
    // promessa NOSSA, precisa ser cumprida.
    const pediu = respostas.find((r) => r.interpretacao === 'pediu_ajuda');
    if (pediu) return { motivo: 'pediu_ajuda', resposta: pediu };

    return { motivo: 'respondeu', resposta: respostas[0] };
}

// Classifica um (aluno, turma) em risco. Devolve { motivo, desde, detalhe } ou
// null (não há nada que o sistema saiba dizer). Quem o robô ainda está cuidando
// vem como `robo_cuidando`, com `robo` dizendo em que ponto está — a tela mostra
// no fim, em cinza, para ninguém precisar adivinhar onde o aluno foi parar.
function classificar(item, { aluno, mensagem, respostas, analise, falhou }, agora) {
    if (aluno?.whatsappOptOut) {
        const sair = respostas.find((r) => r.interpretacao === 'sair');
        return { motivo: 'sair', desde: sair ? sair.recebidaEm : new Date(converterDataAula(item.primeiraFalta)) };
    }

    const validas = respostas.filter((r) => r.interpretacao !== 'sair');
    if (validas.length > 0) {
        const { motivo, resposta } = respostaQueDefine(validas, analise);
        if (motivo === 'promessa') {
            const diaDaPromessa = converterDataAula(diaNoFusoDaEscola(resposta.recebidaEm));
            if (converterDataAula(item.ultimaFalta) <= diaDaPromessa) {
                // Aguardando a próxima chamada conferir.
                return { motivo: 'robo_cuidando', desde: resposta.recebidaEm, detalhe: textoCurto(resposta.texto), robo: { etapa: 'promessa', em: resposta.recebidaEm } };
            }
            return { motivo: 'promessa_quebrada', desde: resposta.recebidaEm, detalhe: textoCurto(resposta.texto) };
        }
        return { motivo, desde: resposta.recebidaEm, detalhe: textoCurto(resposta.texto) };
    }

    if (mensagem) {
        const espera = mensagem.tentativa === 2 ? DIAS_SEM_RESPOSTA : DIAS_SEM_SEGUNDA;
        const entraNaListaEm = new Date(mensagem.enviadaEm.getTime() + espera * DIA_MS);
        if (agora < entraNaListaEm.getTime()) {
            return {
                motivo: 'robo_cuidando',
                desde: mensagem.enviadaEm,
                robo: {
                    etapa: 'aguardando_resposta',
                    tentativa: mensagem.tentativa,
                    enviadaEm: mensagem.enviadaEm,
                    entrega: mensagem.status,
                    // A 2ª sai só se ele continuar faltando e ninguém tiver falado com
                    // ele (whatsappAutomatico.js) — por isso a tela diz "prevista".
                    segundaPrevistaEm: mensagem.tentativa === 1 ? new Date(mensagem.enviadaEm.getTime() + DIAS_PARA_SEGUNDA * DIA_MS) : null,
                    entraNaListaEm
                }
            };
        }
        return { motivo: 'sem_resposta', desde: mensagem.enviadaEm };
    }

    const inicio = new Date(converterDataAula(item.primeiraFalta));
    if (falhou) return { motivo: 'sem_whatsapp', desde: inicio };
    // Sem telefone cadastrado NÃO entra (saiu em 24/10/2026): esta lista é o funil
    // do que aconteceu com as mensagens, e quem não tem telefone nunca recebeu
    // nenhuma — eram dezenas de cards sem conversa nenhuma, afogando os casos
    // reais. Esses alunos continuam visíveis na /risco, no "quem não recebe" da
    // aba Envio automático, e o telefone se corrige na /telefones.
    return null;
}

// A conversa do sumiço para o card, da mais antiga para a mais recente: o que o
// aluno escreveu e o que o robô respondeu. A mensagem automática em si fica de
// fora (é o mesmo texto para todos).
function montarConversa(respostas) {
    const conversa = [];
    for (const r of [...respostas].reverse()) {
        conversa.push({ quem: 'aluno', texto: r.texto, em: r.recebidaEm });
        if (r.respostaRobo) conversa.push({ quem: 'robo', texto: r.respostaRobo });
    }
    return conversa;
}

// `analisar: false` = não agendar leitura da IA (o contador do menu lateral
// chama isto em toda página; quem agenda é a tela /contatar).
async function listarPrecisamContato({ turma, analisar = true } = {}, agora = new Date()) {
    const { emRisco } = await calcularAlunosEmRiscoSemRecuperados();
    const candidatos = turma ? emRisco.filter((item) => item.codigoTurma === turma) : emRisco;
    const matriculas = [...new Set(candidatos.map((item) => item.matricula))];
    if (matriculas.length === 0) return [];

    const [alunos, mensagens, respostas, contatos, responsaveis] = await Promise.all([
        prisma.aluno.findMany({
            where: { matricula: { in: matriculas } },
            select: { matricula: true, telefone: true, whatsappOptOut: true }
        }),
        prisma.mensagemWhatsapp.findMany({
            where: { matricula: { in: matriculas } },
            select: {
                id: true, matricula: true, codigoTurma: true, primeiraFalta: true, tentativa: true, status: true, falhaDefinitiva: true, contatoId: true, enviadaEm: true,
                conversaResumo: true, conversaSituacao: true, conversaMotivo: true, conversaMotivoIa: true, conversaAnalisadaEm: true
            },
            orderBy: { enviadaEm: 'desc' }
        }),
        prisma.respostaWhatsapp.findMany({
            where: { matricula: { in: matriculas }, interpretacao: { notIn: ['ignorada', 'sem_vinculo'] } },
            select: { matricula: true, mensagemId: true, texto: true, interpretacao: true, motivoSugerido: true, recebidaEm: true, respostaRobo: true },
            orderBy: { recebidaEm: 'desc' }
        }),
        prisma.contato.findMany({
            where: { matricula: { in: matriculas } },
            select: { id: true, matricula: true, status: true, canal: true, contatadoPor: true, criadoEm: true },
            orderBy: { criadoEm: 'desc' }
        }),
        prisma.responsavelContato.findMany({ where: { matricula: { in: matriculas } } })
    ]);
    const responsavelPorMatricula = new Map(responsaveis.map((r) => [r.matricula, r]));
    const nomes = responsaveis.length
        ? new Map((await prisma.usuario.findMany({
            where: { usuario: { in: [...new Set(responsaveis.map((r) => r.usuario))] } },
            select: { usuario: true, nome: true }
        })).map((u) => [u.usuario, u.nome || u.usuario]))
        : new Map();

    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));
    // Contato criado pelo envio automático não é contato de uma pessoa: ele vira
    // "respondido" quando o aluno responde, e isso não pode tirar ninguém da lista.
    const contatosDoRobo = new Set(mensagens.map((m) => m.contatoId).filter(Boolean));
    const agoraMs = agora.getTime();

    const porMatricula = new Map();
    const paraAnalisar = new Map();
    for (const item of candidatos) {
        const inicioEpisodio = converterDataAula(item.primeiraFalta);
        const doAluno = mensagens.filter((m) => m.matricula === item.matricula);
        // A mensagem automática mais recente deste sumiço (qualquer turma: o aluno
        // recebe uma por semana, não uma por turma).
        const doEpisodio = doAluno.filter((m) => STATUS_JA_RECEBEU.includes(m.status) && m.enviadaEm && m.enviadaEm.getTime() >= inicioEpisodio);
        const mensagem = doEpisodio[0] || null;
        const falhou = doAluno.some((m) => m.codigoTurma === item.codigoTurma && m.primeiraFalta === item.primeiraFalta && m.status === 'falhou' && m.falhaDefinitiva);
        // Resposta a qualquer uma das mensagens deste sumiço: conta a partir da 1ª.
        const primeiraEnviada = doEpisodio[doEpisodio.length - 1];
        const doSumico = primeiraEnviada
            ? respostas.filter((r) => r.matricula === item.matricula && r.recebidaEm.getTime() >= primeiraEnviada.enviadaEm.getTime())
            : [];
        // A leitura da conversa pela IA (whatsappAnalise.js), da mensagem mais
        // recente que já foi analisada.
        const analise = doEpisodio.find((m) => m.conversaAnalisadaEm) || null;

        const caso = classificar(item, { aluno: alunoPorMatricula.get(item.matricula), mensagem, respostas: doSumico, analise, falhou }, agoraMs);
        if (!caso) continue;

        // Conversa sem leitura da IA, ou com mensagem nova depois da última: lê agora,
        // em segundo plano (a próxima vez que a tela carregar, o resumo já está lá).
        for (const m of doEpisodio) {
            const ultima = doSumico.find((r) => r.mensagemId === m.id);
            if (ultima) paraAnalisar.set(m.id, { id: m.id, conversaAnalisadaEm: m.conversaAnalisadaEm, ultimaRespostaEm: ultima.recebidaEm });
        }

        // Contato de uma pessoa depois do motivo: resolve ou é só uma tentativa.
        const contatoHumano = contatos.find((c) =>
            c.matricula === item.matricula && !contatosDoRobo.has(c.id) && c.criadoEm.getTime() >= new Date(caso.desde).getTime());
        if (contatoHumano && RESOLVE_CASO.includes(contatoHumano.status)) continue;

        const linha = {
            matricula: item.matricula,
            nomeAluno: item.nomeAluno,
            telefone: alunoPorMatricula.get(item.matricula)?.telefone || null,
            motivo: caso.motivo,
            prioridade: MOTIVOS_LISTA[caso.motivo].prioridade,
            rotulo: MOTIVOS_LISTA[caso.motivo].rotulo,
            desde: caso.desde,
            detalhe: caso.detalhe || null,
            robo: caso.robo || null,
            // Para o formulário já vir preenchido: o resumo da conversa escrito
            // pela IA e o motivo — este só quando há certeza (whatsappAnalise.js).
            resumoIa: analise?.conversaResumo || null,
            motivoIa: analise?.conversaMotivo || null,
            respondeuRobo: doSumico.length > 0,
            conversa: montarConversa(doSumico),
            // Foto ou documento pelo WhatsApp — quase sempre o atestado. O arquivo
            // não é guardado no sistema: ver no WhatsApp do número do sistema.
            enviouArquivo: doSumico.some((r) => ['[imagem]', '[documento]'].includes(r.texto)),
            ultimaTentativa: contatoHumano
                ? { em: contatoHumano.criadoEm, por: contatoHumano.contatadoPor, status: contatoHumano.status, canal: contatoHumano.canal }
                : null,
            turmas: [{ codigoTurma: item.codigoTurma, nomeTurma: item.nomeTurma, diasSemVir: item.diasSemVir, primeiraFalta: item.primeiraFalta }]
        };

        // Uma linha por aluno: em risco em duas turmas, fica o motivo mais urgente
        // e as turmas juntas.
        const atual = porMatricula.get(item.matricula);
        if (!atual) porMatricula.set(item.matricula, linha);
        else {
            const turmas = [...atual.turmas, ...linha.turmas];
            porMatricula.set(item.matricula, { ...(linha.prioridade < atual.prioridade ? linha : atual), turmas });
        }
    }

    if (analisar) garantirAnalises([...paraAnalisar.values()]);

    // "Eu cuido deste aluno": só vale se assumido depois que o motivo atual
    // trouxe o aluno para a lista.
    for (const linha of porMatricula.values()) {
        const r = responsavelPorMatricula.get(linha.matricula);
        linha.responsavel = r && r.assumidoEm >= new Date(linha.desde)
            ? { usuario: r.usuario, nome: nomes.get(r.usuario) || r.usuario, em: r.assumidoEm }
            : null;
    }

    // Mais urgente primeiro; dentro da mesma prioridade, quem espera há mais tempo.
    return [...porMatricula.values()].sort((a, b) =>
        a.prioridade - b.prioridade || new Date(a.desde) - new Date(b.desde));
}

module.exports = { listarPrecisamContato, MOTIVOS_LISTA, DIAS_SEM_RESPOSTA, DIAS_SEM_SEGUNDA, RESOLVE_CASO };
