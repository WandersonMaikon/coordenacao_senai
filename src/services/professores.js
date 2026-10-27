const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const { carregarTurmasEncerradas } = require('../controllers/turmaController');
const { converterDataAula, diaNoFusoDaEscola } = require('../controllers/alunoController');

// Tela /professores: quem lança chamada, quando lançou por último e se o
// userscript de cada um está funcionando.
//
// Não existe cadastro de professor. O nome vem de dois lugares, ambos digitados
// pelo professor no próprio Tampermonkey: `lancamentos.professor` e
// `instalacoes_script.professor`. Os dois são juntados pelo nome normalizado
// (sem acento, caixa, espaços extras nem "Prof."), senão "Wanderson" e
// "wanderson " virariam duas pessoas.

const DIA_MS = 24 * 60 * 60 * 1000;
// Professor com turma ativa e sem envio há mais que isto fica em "Sem envio".
const DIAS_SEM_ENVIO_ALERTA = 7;
// Janela das contagens de chamada e do atraso para lançar.
const DIAS_JANELA = 30;

const CAMINHO_USERSCRIPT = path.join(__dirname, '../../tampermonkey/sge-captura.user.js');

// A versão "atual" é a do arquivo servido aos professores — lida uma vez na
// subida, que é quando o arquivo pode ter mudado (deploy).
const VERSAO_ATUAL = (() => {
    try {
        const achado = fs.readFileSync(CAMINHO_USERSCRIPT, 'utf8').match(/@version\s+(\S+)/);
        return achado ? achado[1] : null;
    } catch (erro) {
        return null;
    }
})();

function compararVersoes(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diferenca = (pa[i] || 0) - (pb[i] || 0);
        if (diferenca !== 0) return diferenca;
    }
    return 0;
}

// Os dois primeiros nomes, sem acento/caixa/"Prof.": o mesmo professor digita
// "Wanderson Maikon da Silva" numa máquina e "Wanderson Maikon" na outra. É a
// mesma regra do cabeçalho da /faltas (nomesCurtosUnicos), com o mesmo efeito
// colateral aceito: dois professores com os dois primeiros nomes iguais viram um.
function chaveProfessor(nome) {
    return nomeNormalizado(nome).split(' ').slice(0, 2).join(' ');
}

// Nome inteiro sem acento/caixa/espaços extras/"Prof." — é a chave das
// correções de nome (correcoes_nome_professor).
function nomeNormalizado(nome) {
    return (nome || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(prof(essor|essora)?\.?)\s+/, '');
}

// Nome errado → nome certo, a partir do "Corrigir nome" da /professores.
// Lido a cada envio (tabela pequena), para a correção valer na hora.
async function carregarCorrecoesDeNome() {
    const correcoes = await prisma.correcaoNomeProfessor.findMany();
    return new Map(correcoes.map((c) => [c.nomeDigitado, c.nomeCorreto]));
}

function nomeCorrigido(nome, correcoes) {
    return correcoes.get(nomeNormalizado(nome)) ?? nome;
}

function navegadorDe(userAgent) {
    const ua = userAgent || '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return '';
}

function texto(valor, limite) {
    return typeof valor === 'string' ? valor.trim().slice(0, limite) : '';
}

function dataValida(valor) {
    const data = valor ? new Date(valor) : null;
    return data && !Number.isNaN(data.getTime()) ? data : null;
}

const ID_INSTALACAO = /^[A-Za-z0-9-]{8,64}$/;

// Grava o que o script contou sobre o navegador. `dados` é o objeto que o
// script manda (`id`, `versao`, `professor` e, no sinal, `fila`, `filaDesde`,
// `tela`); `extras` são os campos que dependem do evento. Devolve false se o
// id não serve — chamada pública, então nada aqui confia no corpo.
async function registrarInstalacao(dados, userAgent, extras = {}) {
    if (!dados || !ID_INSTALACAO.test(dados.id || '')) return false;
    const correcoes = await carregarCorrecoesDeNome();
    const campos = {
        professor: nomeCorrigido(texto(dados.professor, 255), correcoes),
        versao: texto(dados.versao, 20),
        ultimoSinalEm: new Date(),
        ...extras
    };
    // Navegador não reconhecido não apaga o que já se sabia.
    const navegador = navegadorDe(userAgent);
    if (navegador) campos.navegador = navegador;
    await prisma.instalacaoScript.upsert({
        where: { instalacaoId: dados.id },
        update: campos,
        create: { instalacaoId: dados.id, ...campos }
    });
    return true;
}

// POST /webhook/sinal-script. Eventos: `carregou` (o SGE abriu com o script
// rodando), `capturou` (Salvar com alunos lidos) e `sem_captura` (Salvar sem
// aluno nenhum na tela).
async function registrarSinal(corpo, userAgent) {
    const agora = new Date();
    const tela = texto(corpo?.tela, 200) || null;
    const extras = {};
    if (Number.isInteger(corpo?.fila) && corpo.fila >= 0) {
        extras.filaPendente = Math.min(corpo.fila, 100000);
        extras.filaDesde = corpo.fila > 0 ? dataValida(corpo.filaDesde) : null;
    }
    if (corpo?.evento === 'capturou') Object.assign(extras, { ultimaCapturaEm: agora, telaCaptura: tela });
    if (corpo?.evento === 'sem_captura') Object.assign(extras, { semCapturaEm: agora, semCapturaTela: tela });
    return registrarInstalacao(corpo, userAgent, extras);
}

function mediana(valores) {
    if (valores.length === 0) return null;
    const ordenados = [...valores].sort((a, b) => a - b);
    const meio = Math.floor(ordenados.length / 2);
    return ordenados.length % 2 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

function resumoInstalacao(inst) {
    // Só acusa a tela se o "Salvar" sem alunos foi na mesma tela em que o script
    // já capturou antes, e depois dessa captura: Salvar em outra tela do SGE
    // (cadastro, notas...) também não acha aluno, e não é problema.
    const telaNaoReconhecida = Boolean(
        inst.semCapturaEm && inst.telaCaptura && inst.semCapturaTela === inst.telaCaptura
        && (!inst.ultimaCapturaEm || inst.semCapturaEm > inst.ultimaCapturaEm)
    );
    return {
        navegador: inst.navegador,
        versao: inst.versao,
        desatualizada: Boolean(VERSAO_ATUAL && (!inst.versao || compararVersoes(inst.versao, VERSAO_ATUAL) < 0)),
        ultimoSinalEm: inst.ultimoSinalEm,
        ultimoEnvioEm: inst.ultimoEnvioEm,
        ultimaCapturaEm: inst.ultimaCapturaEm,
        filaPendente: inst.filaPendente,
        filaDesde: inst.filaDesde,
        telaNaoReconhecida,
        semCapturaEm: telaNaoReconhecida ? inst.semCapturaEm : null
    };
}

const ORDEM_SITUACAO = { problema: 1, sem_envio: 2, atencao: 3, ok: 4, inativo: 5 };

async function listarProfessores() {
    const agora = Date.now();
    const hoje = converterDataAula(diaNoFusoDaEscola(new Date()));

    // Uma linha por chamada (professor, turma, UC, dia) — não por aluno.
    const [chamadas, nomesTurma, encerradas, instalacoes] = await Promise.all([
        prisma.lancamento.groupBy({
            by: ['professor', 'codigoTurma', 'uc', 'dataAula'],
            _min: { criadoEm: true },
            _max: { atualizadoEm: true }
        }),
        prisma.lancamento.findMany({
            where: { codigoTurma: { not: null } },
            distinct: ['codigoTurma'],
            select: { codigoTurma: true, nomeTurma: true }
        }),
        carregarTurmasEncerradas(),
        prisma.instalacaoScript.findMany({ orderBy: { ultimoSinalEm: 'desc' } })
    ]);
    const nomeDaTurma = new Map(nomesTurma.map((t) => [t.codigoTurma, t.nomeTurma]));

    const professores = new Map();
    const doProfessor = (nome) => {
        const chave = chaveProfessor(nome);
        if (!professores.has(chave)) {
            professores.set(chave, { chave, grafias: new Map(), turmas: new Map(), chamadas: [], instalacoes: [] });
        }
        const professor = professores.get(chave);
        const grafia = (nome || '').replace(/\s+/g, ' ').trim();
        if (grafia) professor.grafias.set(grafia, (professor.grafias.get(grafia) || 0) + 1);
        return professor;
    };

    for (const chamada of chamadas) {
        const professor = doProfessor(chamada.professor);
        professor.chamadas.push(chamada);
        const codigo = chamada.codigoTurma || '';
        if (!professor.turmas.has(codigo)) {
            professor.turmas.set(codigo, {
                codigoTurma: codigo,
                nomeTurma: nomeDaTurma.get(codigo) || '',
                encerrada: encerradas.has(codigo),
                ucs: new Set(),
                ultimaAula: null,
                ultimoEnvioEm: null
            });
        }
        const turma = professor.turmas.get(codigo);
        if (chamada.uc) turma.ucs.add(chamada.uc);
        if (!turma.ultimaAula || converterDataAula(chamada.dataAula) > converterDataAula(turma.ultimaAula)) turma.ultimaAula = chamada.dataAula;
        if (!turma.ultimoEnvioEm || chamada._max.atualizadoEm > turma.ultimoEnvioEm) turma.ultimoEnvioEm = chamada._max.atualizadoEm;
    }
    for (const inst of instalacoes) doProfessor(inst.professor).instalacoes.push(resumoInstalacao(inst));

    const lista = [...professores.values()].map((p) => {
        const turmas = [...p.turmas.values()]
            .map((t) => ({
                ...t,
                ucs: [...t.ucs].sort(),
                diasSemAula: t.ultimaAula ? Math.round((hoje - converterDataAula(t.ultimaAula)) / DIA_MS) : null
            }))
            .sort((a, b) => a.encerrada - b.encerrada || converterDataAula(b.ultimaAula) - converterDataAula(a.ultimaAula));

        let ultimoEnvioEm = null;
        let ultimaAula = null;
        let chamadas7 = 0;
        let chamadas30 = 0;
        const atrasos = [];
        for (const c of p.chamadas) {
            if (!ultimoEnvioEm || c._max.atualizadoEm > ultimoEnvioEm) ultimoEnvioEm = c._max.atualizadoEm;
            if (!ultimaAula || converterDataAula(c.dataAula) > converterDataAula(ultimaAula)) ultimaAula = c.dataAula;
            const idade = agora - c._min.criadoEm.getTime();
            if (idade <= 7 * DIA_MS) chamadas7++;
            if (idade <= DIAS_JANELA * DIA_MS) {
                chamadas30++;
                // Atraso = dia do primeiro envio − dia da aula. Mediana, não média:
                // quem instala o script manda de uma vez os dias antigos da tela,
                // e esse pacote não é atraso de verdade.
                const atraso = Math.round((converterDataAula(diaNoFusoDaEscola(c._min.criadoEm)) - converterDataAula(c.dataAula)) / DIA_MS);
                if (atraso >= 0) atrasos.push(atraso);
            }
        }
        for (const inst of p.instalacoes) {
            if (inst.ultimoEnvioEm && (!ultimoEnvioEm || inst.ultimoEnvioEm > ultimoEnvioEm)) ultimoEnvioEm = inst.ultimoEnvioEm;
        }
        const diasSemEnvio = ultimoEnvioEm ? Math.floor((agora - ultimoEnvioEm.getTime()) / DIA_MS) : null;
        // Professor só com instalação (nunca lançou) conta como ativo: pode ser
        // justamente o script que não está funcionando.
        const temTurmaAtiva = turmas.length === 0 || turmas.some((t) => !t.encerrada);

        // A grafia mais usada; no empate, a mais longa (costuma ser a completa, com acento).
        const grafias = [...p.grafias.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([nome]) => nome);

        const alertas = [];
        if (p.chave === '') alertas.push({ tipo: 'atencao', texto: 'Lançamentos sem nome de professor: o nome não foi configurado no Tampermonkey (menu "Alterar nome do professor").' });
        for (const inst of p.instalacoes) {
            const onde = inst.navegador ? ` (${inst.navegador})` : '';
            if (inst.filaPendente > 0) alertas.push({ tipo: 'problema', texto: `${inst.filaPendente} envio(s) não chegaram ao servidor e esperam na fila do navegador${onde}.`, desde: inst.filaDesde });
            if (inst.telaNaoReconhecida) alertas.push({ tipo: 'problema', texto: `Clicou em Salvar na tela de frequência e o script não encontrou os alunos${onde}. O SGE pode ter mudado.`, desde: inst.semCapturaEm });
            if (inst.desatualizada) alertas.push({ tipo: 'atencao', texto: `Script na versão ${inst.versao || 'desconhecida'}${onde}; a atual é ${VERSAO_ATUAL}.` });
        }
        if (p.instalacoes.length === 0 && p.chave !== '') {
            alertas.push({ tipo: 'atencao', texto: 'Ainda não deu sinal pela versão nova do script: ou não atualizou, ou não abriu o SGE desde então.' });
        }
        if (temTurmaAtiva && (diasSemEnvio === null || diasSemEnvio > DIAS_SEM_ENVIO_ALERTA)) {
            alertas.push({ tipo: 'sem_envio', texto: diasSemEnvio === null ? 'Nunca enviou chamada.' : `Nenhuma chamada enviada há ${diasSemEnvio} dias.` });
        }

        let situacao = 'ok';
        if (alertas.some((a) => a.tipo === 'problema')) situacao = 'problema';
        else if (!temTurmaAtiva) situacao = 'inativo';
        else if (alertas.some((a) => a.tipo === 'sem_envio')) situacao = 'sem_envio';
        else if (alertas.length > 0) situacao = 'atencao';

        return {
            // Dois primeiros nomes, como no cabeçalho da /faltas: o mesmo professor
            // aparece escrito igual nas duas telas. As grafias completas vão junto.
            nome: (grafias[0] || '').split(' ').slice(0, 2).join(' '),
            grafias,
            chave: p.chave,
            situacao,
            alertas,
            ultimoEnvioEm,
            diasSemEnvio,
            ultimaAula,
            chamadas7,
            chamadas30,
            atrasoTipicoDias: mediana(atrasos),
            turmas,
            instalacoes: p.instalacoes
        };
    });

    lista.sort((a, b) => ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao]
        || (b.diasSemEnvio ?? Infinity) - (a.diasSemEnvio ?? Infinity)
        || a.nome.localeCompare(b.nome, 'pt-BR'));

    return { professores: lista, versaoAtual: VERSAO_ATUAL, diasSemEnvioAlerta: DIAS_SEM_ENVIO_ALERTA, diasJanela: DIAS_JANELA };
}

// "Corrigir nome": todos os nomes que caem no card `de` (a chave da lista)
// passam a ser `nomeCorreto`, nos lançamentos e nos navegadores — o conserto é
// no dado, então /faltas, /risco e /professores mostram o mesmo nome. Cada nome
// trocado vira uma correção, para o próximo envio do navegador antigo já chegar
// certo. Para juntar com outro professor, basta digitar o nome dele.
async function corrigirNomeProfessor(de, nomeCorreto, usuario) {
    const nome = texto(nomeCorreto, 255).replace(/\s+/g, ' ');
    if (!nome) throw Object.assign(new Error('Digite o nome correto.'), { status: 400 });
    // "Sem nome" junta lançamentos de professores diferentes: não dá para dizer de quem são.
    if (!de) throw Object.assign(new Error('Os lançamentos sem nome não podem ser corrigidos por aqui.'), { status: 400 });

    const [doLancamento, doNavegador] = await Promise.all([
        prisma.lancamento.findMany({ distinct: ['professor'], select: { professor: true } }),
        prisma.instalacaoScript.findMany({ distinct: ['professor'], select: { professor: true } })
    ]);
    const nomesAntigos = [...new Set([...doLancamento, ...doNavegador].map((l) => l.professor))]
        .filter((n) => n && chaveProfessor(n) === de && n !== nome);
    if (nomesAntigos.length === 0) throw Object.assign(new Error('O nome já está assim.'), { status: 400 });

    const correto = nomeNormalizado(nome);
    const operacoes = [];
    for (const antigo of nomesAntigos) {
        // SQL direto de propósito: o updateMany do Prisma preencheria
        // atualizado_em, e é ele que diz quando o professor enviou cada chamada.
        operacoes.push(prisma.$executeRaw`UPDATE lancamentos SET professor = ${nome} WHERE professor = ${antigo}`);
        operacoes.push(prisma.instalacaoScript.updateMany({ where: { professor: antigo }, data: { professor: nome } }));
        const digitado = nomeNormalizado(antigo);
        if (digitado !== correto) {
            operacoes.push(prisma.correcaoNomeProfessor.upsert({
                where: { nomeDigitado: digitado },
                update: { nomeCorreto: nome, corrigidoPor: usuario },
                create: { nomeDigitado: digitado, nomeCorreto: nome, corrigidoPor: usuario }
            }));
        }
        // Correções antigas que apontavam para este nome passam a apontar para o novo.
        operacoes.push(prisma.correcaoNomeProfessor.updateMany({ where: { nomeCorreto: antigo }, data: { nomeCorreto: nome } }));
    }
    // O nome certo nunca é trocado por outro (evita ida e volta).
    operacoes.push(prisma.correcaoNomeProfessor.deleteMany({ where: { nomeDigitado: correto } }));
    const resultados = await prisma.$transaction(operacoes);
    // Só o $executeRaw devolve número: a soma é quantos lançamentos mudaram.
    const lancamentos = resultados.filter((r) => typeof r === 'number').reduce((total, n) => total + n, 0);
    return { nomesAntigos, lancamentos };
}

module.exports = { listarProfessores, corrigirNomeProfessor, carregarCorrecoesDeNome, nomeCorrigido, registrarSinal, registrarInstalacao, chaveProfessor, compararVersoes };
