const XLSX = require('xlsx');
const prisma = require('../config/prisma');

// Nº de dias de aula seguidos com falta (sem nenhuma presença no meio) que
// colocam o aluno em risco. Não é soma acumulada do período todo: assim que o
// aluno tem presença num dia posterior, entende-se que ele voltou e some da
// lista — mesmo que o total de faltas do semestre continue alto.
// Vale tanto pra turma diária quanto pra semi-presencial (1 aula/semana — 2
// dias de aula seguidos, ex: 06/08 e 13/08), sem precisar diferenciar o tipo de
// turma: a régua é "dia de aula lançado", não intervalo de calendário.
const DIAS_AULA_CONSECUTIVOS_RISCO = 2;

// Quantos dias de aula o aluno marcado como "recuperado" fica em acompanhamento
// na tela /recuperado antes de sair dela. Conta dias de aula lançados pelos
// professores DEPOIS da marcação (mesma régua do risco: dia de aula, não
// calendário). Enquanto está em acompanhamento ele não aparece na /risco, mesmo
// que falte — a falta vira um alerta na /recuperado.
const DIAS_AULA_ACOMPANHAMENTO_RECUPERADO = 4;

// Só entram no acompanhamento as turmas em que o aluno teve aula nesse intervalo
// antes da marcação — sem isso, uma turma antiga dele (semestre passado) nunca
// receberia lançamento novo e ficaria "0 de 4" pra sempre na tela.
const DIAS_TURMA_RECENTE = 30;

// A escola é em Ji-Paraná (UTC-4) e o container roda em UTC: um contato marcado
// às 21h viraria "dia seguinte" e a aula daquela noite ficaria de fora.
const FUSO_ESCOLA = 'America/Porto_Velho';

// Valores da coluna "Situação" da planilha da secretaria que contam como aluno
// ativo no painel. A comparação ignora acento e maiúscula porque a planilha não
// é consistente. Se a secretaria passar a usar outro termo, é só acrescentar
// aqui — o valor cru fica salvo em `alunos.situacao`, então a reclassificação
// não exige reimportar nada.
const SITUACOES_ATIVAS = ['matriculado', 'matriculada', 'cursando', 'ativo', 'ativa'];

function normalizarTexto(texto) {
    return (texto || '')
        .toString()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .toLowerCase();
}

// Aluno sem situação preenchida conta como ativo: são os importados antes da
// planilha passar a trazer essa coluna. Tratá-los como inativos derrubaria o
// número do painel até cada turma ser reimportada.
function ehSituacaoAtiva(situacao) {
    if (!situacao) return true;
    return SITUACOES_ATIVAS.includes(normalizarTexto(situacao));
}

function converterDataAula(dataAula) {
    if (!dataAula) return 0;
    const [dia, mes, ano] = dataAula.split('/').map(Number);
    return new Date(ano, (mes || 1) - 1, dia || 1).getTime();
}

// Agrupa lançamentos por (aluno, turma) e verifica a sequência de faltas em
// aberto, do dia mais recente pra trás, parando no primeiro dia com presença.
// Devolve uma linha por (aluno, turma) — quem estuda em duas turmas aparece
// duas vezes, então quem precisa de "quantos alunos" (e não "quantos casos")
// tem que contar matrículas distintas.
async function calcularAlunosEmRisco() {
    const lancamentos = await prisma.lancamento.findMany({
        select: { matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, dataAula: true, qtdFaltas: true }
    });

    const grupos = new Map();
    // Dia de aula mais recente lançado em cada turma (por qualquer aluno, não só
    // os em risco) — a tela mostra no cabeçalho da turma pra deixar claro até
    // quando a frequência daquela turma está atualizada.
    const ultimaAulaPorTurma = new Map();
    // Quem é aluno de cada turma. A tabela `alunos` não guarda turma (a planilha
    // da secretaria é por turma, mas não traz o código dela numa coluna), então
    // o vínculo sai dos lançamentos: quem já teve chamada lançada naquela turma
    // é aluno dela. É o que permite filtrar o painel por turma.
    const matriculasPorTurma = new Map();
    for (const item of lancamentos) {
        const chave = `${item.matricula}||${item.codigoTurma || ''}`;
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(item);

        const chaveTurma = item.codigoTurma || '';
        const atual = ultimaAulaPorTurma.get(chaveTurma);
        if (!atual || converterDataAula(item.dataAula) > converterDataAula(atual)) {
            ultimaAulaPorTurma.set(chaveTurma, item.dataAula);
        }

        if (!matriculasPorTurma.has(chaveTurma)) matriculasPorTurma.set(chaveTurma, new Set());
        matriculasPorTurma.get(chaveTurma).add(item.matricula);
    }

    const resultado = [];
    for (const registros of grupos.values()) {
        registros.sort((a, b) => converterDataAula(a.dataAula) - converterDataAula(b.dataAula));

        // Um mesmo dia pode ter mais de um lançamento, um por UC, quando dois
        // professores dão aula pra turma no mesmo dia. As faltas do dia somam,
        // mas presença em qualquer UC significa que o aluno veio: o dia inteiro
        // conta como presença e a sequência de risco reseta.
        const porDia = new Map();
        for (const item of registros) {
            const dia = item.dataAula || '';
            if (!porDia.has(dia)) {
                porDia.set(dia, { dataAula: dia, faltas: 0, tevePresenca: false });
            }
            const registroDoDia = porDia.get(dia);
            const faltas = item.qtdFaltas || 0;
            registroDoDia.faltas += faltas;
            if (faltas === 0) registroDoDia.tevePresenca = true;
        }

        const dias = [...porDia.values()]
            .sort((a, b) => converterDataAula(a.dataAula) - converterDataAula(b.dataAula));

        let sequencia = 0;
        let faltasNaSequencia = 0;
        let indice = dias.length - 1;
        for (; indice >= 0 && !dias[indice].tevePresenca && dias[indice].faltas > 0; indice--) {
            sequencia++;
            faltasNaSequencia += dias[indice].faltas;
        }

        // O laço para no primeiro dia em que o aluno veio — é a última presença
        // dele. Fica `null` quando ele nunca apareceu em nenhum lançamento da
        // turma (a sequência começa no primeiro dia de aula registrado).
        const ultimaPresenca = indice >= 0 ? dias[indice].dataAula : null;
        const primeiraFalta = dias[indice + 1]?.dataAula || null;

        if (sequencia < DIAS_AULA_CONSECUTIVOS_RISCO) continue;

        const ultimo = registros[registros.length - 1];
        resultado.push({
            matricula: ultimo.matricula,
            nomeAluno: ultimo.nomeAluno,
            codigoTurma: ultimo.codigoTurma,
            nomeTurma: ultimo.nomeTurma,
            // Dias de aula seguidos sem vir — é o que a tela mostra. Contar dias
            // é mais fiel que dividir o total de faltas por um nº fixo de aulas,
            // já que um dia com duas UCs tem mais aulas que um dia com uma só.
            diasSemVir: sequencia,
            totalFaltas: faltasNaSequencia,
            // Datas em `dd/mm/aaaa` (formato do SGE) — a tela mostra "sumiu desde"
            // pra dar a noção de calendário que `diasSemVir` sozinho não dá:
            // 2 dias de aula é uma semana na turma diária e quase um mês na
            // semipresencial.
            ultimaPresenca,
            primeiraFalta
        });
    }

    resultado.sort((a, b) => b.diasSemVir - a.diasSemVir || b.totalFaltas - a.totalFaltas);

    return { emRisco: resultado, ultimaAulaPorTurma, matriculasPorTurma };
}

// Matrículas que a coordenação marcou como recuperadas: o contato MAIS RECENTE
// do aluno está com status "recuperado". Vale o último contato, não "algum dia
// foi recuperado" — se depois registrarem "acompanhar" ou "sem resposta", o
// aluno deixa de contar. É uma marcação manual da coordenação (tela /risco), não
// um cálculo em cima da frequência. Separada do resumo pra poder ser reaproveitada
// por uma futura tela de acompanhamento dos recuperados.
async function listarMatriculasRecuperadas() {
    const contatos = await prisma.contato.findMany({
        select: { matricula: true, status: true },
        orderBy: { criadoEm: 'desc' }
    });

    const ultimoStatusPorMatricula = new Map();
    for (const contato of contatos) {
        if (!ultimoStatusPorMatricula.has(contato.matricula)) {
            ultimoStatusPorMatricula.set(contato.matricula, contato.status);
        }
    }

    const recuperadas = new Set();
    for (const [matricula, status] of ultimoStatusPorMatricula) {
        if (status === 'recuperado') recuperadas.add(matricula);
    }
    return recuperadas;
}

// "dd/mm/aaaa" do dia em que o contato foi registrado, no fuso da escola — o
// mesmo formato de `dataAula`, pra dar pra comparar com converterDataAula.
function diaNoFusoDaEscola(data) {
    return data.toLocaleDateString('pt-BR', { timeZone: FUSO_ESCOLA, day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Alunos marcados como recuperados que ainda estão no período de acompanhamento,
// uma linha por (aluno, turma). Recuperado = último contato com status
// "recuperado" (mesma regra de listarMatriculasRecuperadas). Um dia de aula conta
// no acompanhamento quando é do dia da marcação em diante E o lançamento foi
// criado depois da marcação — a segunda condição tira a chamada do próprio dia
// que já tinha sido lançada antes (normalmente a falta que motivou o contato).
async function calcularRecuperadosEmAcompanhamento() {
    const contatos = await prisma.contato.findMany({ orderBy: { criadoEm: 'desc' } });

    const marcacaoPorMatricula = new Map();
    const vistos = new Set();
    for (const contato of contatos) {
        if (vistos.has(contato.matricula)) continue;
        vistos.add(contato.matricula);
        if (contato.status === 'recuperado') marcacaoPorMatricula.set(contato.matricula, contato);
    }
    if (marcacaoPorMatricula.size === 0) return [];

    const lancamentos = await prisma.lancamento.findMany({
        where: { matricula: { in: [...marcacaoPorMatricula.keys()] } },
        select: { matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, dataAula: true, uc: true, qtdFaltas: true, criadoEm: true }
    });

    const grupos = new Map();
    for (const item of lancamentos) {
        const chave = chaveAlunoTurma(item);
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(item);
    }

    const resultado = [];
    for (const registros of grupos.values()) {
        const { matricula } = registros[0];
        const marcacao = marcacaoPorMatricula.get(matricula);
        const inicio = converterDataAula(diaNoFusoDaEscola(marcacao.criadoEm));

        const limiteTurmaRecente = inicio - DIAS_TURMA_RECENTE * 24 * 60 * 60 * 1000;
        if (!registros.some((item) => converterDataAula(item.dataAula) >= limiteTurmaRecente)) continue;

        // Agrega por dia como no risco: presença em qualquer UC = o aluno veio.
        const porDia = new Map();
        for (const item of registros) {
            if (converterDataAula(item.dataAula) < inicio || item.criadoEm <= marcacao.criadoEm) continue;
            const dia = item.dataAula || '';
            if (!porDia.has(dia)) porDia.set(dia, { dataAula: dia, faltas: 0, tevePresenca: false, ucs: [] });
            const registroDoDia = porDia.get(dia);
            const faltas = item.qtdFaltas || 0;
            registroDoDia.faltas += faltas;
            if (faltas === 0) registroDoDia.tevePresenca = true;
            else registroDoDia.ucs.push(item.uc || '');
        }

        const dias = [...porDia.values()].sort((a, b) => converterDataAula(a.dataAula) - converterDataAula(b.dataAula));
        if (dias.length >= DIAS_AULA_ACOMPANHAMENTO_RECUPERADO) continue;

        const diasComFalta = dias
            .filter((dia) => !dia.tevePresenca && dia.faltas > 0)
            .map(({ dataAula, faltas, ucs }) => ({ dataAula, faltas, ucs }));

        const ultimo = registros.reduce((a, b) => (converterDataAula(b.dataAula) > converterDataAula(a.dataAula) ? b : a));
        resultado.push({
            matricula,
            nomeAluno: ultimo.nomeAluno,
            codigoTurma: ultimo.codigoTurma,
            nomeTurma: ultimo.nomeTurma,
            recuperadoEm: marcacao.criadoEm,
            recuperadoPor: marcacao.contatadoPor,
            observacao: marcacao.observacao,
            diasAcompanhados: dias.length,
            diasComFalta
        });
    }

    return resultado;
}

function chaveAlunoTurma(item) {
    return `${item.matricula}||${item.codigoTurma || ''}`;
}

// Lista de risco sem quem está em acompanhamento na /recuperado — o aluno sai de
// uma tela e vai pra outra. Usada pela /risco e pelo painel, pros dois números
// baterem.
// Pares (aluno, turma) que a coordenação encerrou na tela /recuperado. Ficam fora
// do risco e do acompanhamento mesmo faltando, até alguém reabrir o caso.
async function listarCasosResolvidos() {
    const casos = await prisma.casoResolvido.findMany({ select: { matricula: true, codigoTurma: true } });
    return new Set(casos.map(chaveAlunoTurma));
}

async function calcularAlunosEmRiscoSemRecuperados() {
    const [risco, recuperados, resolvidos] = await Promise.all([
        calcularAlunosEmRisco(),
        calcularRecuperadosEmAcompanhamento(),
        listarCasosResolvidos()
    ]);
    const emAcompanhamento = new Set(recuperados.map(chaveAlunoTurma));
    const fora = (item) => emAcompanhamento.has(chaveAlunoTurma(item)) || resolvidos.has(chaveAlunoTurma(item));
    return {
        ...risco,
        resolvidos,
        // O acompanhamento também não mostra caso encerrado (ver listarRecuperados).
        recuperados: recuperados.filter((item) => !resolvidos.has(chaveAlunoTurma(item))),
        emRisco: risco.emRisco.filter((item) => !fora(item))
    };
}

// GET /alunos-recuperados — tela /recuperado. Quem faltou durante o
// acompanhamento vem primeiro: é quem precisa de atenção de novo.
async function listarRecuperados(req, res) {
    try {
        const { turma } = req.query;
        const { recuperados } = await calcularAlunosEmRiscoSemRecuperados();
        const resultado = turma ? recuperados.filter((item) => item.codigoTurma === turma) : recuperados;

        const alunos = await prisma.aluno.findMany({
            where: { matricula: { in: resultado.map((item) => item.matricula) } },
            select: { matricula: true, telefone: true }
        });
        const telefonePorMatricula = new Map(alunos.map((aluno) => [aluno.matricula, aluno.telefone]));

        const dados = resultado
            .map((item) => ({ ...item, telefone: telefonePorMatricula.get(item.matricula) || null }))
            .sort((a, b) =>
                b.diasComFalta.length - a.diasComFalta.length ||
                (a.nomeAluno || '').localeCompare(b.nomeAluno || '', 'pt-BR'));

        res.json({ status: 'ok', total: dados.length, diasAcompanhamento: DIAS_AULA_ACOMPANHAMENTO_RECUPERADO, dados });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Códigos de turma (entre os informados) cuja planilha da secretaria já foi
// importada. Turma "importada" = a maioria dos alunos dela, pelos lançamentos,
// tem telefone ou situação no cadastro — campos que só a importação grava (o
// upsert de POST /contatos cria o aluno só com nome). Não basta um aluno só: a
// matrícula é do aluno, não da turma, então quem também estuda numa turma já
// importada faria a turma dele parecer importada.
async function listarTurmasImportadas(codigosTurma) {
    const alunosPorTurma = await prisma.lancamento.findMany({
        where: { codigoTurma: { in: codigosTurma } },
        select: { codigoTurma: true, matricula: true, aluno: { select: { telefone: true, situacao: true } } },
        distinct: ['codigoTurma', 'matricula']
    });

    const contagemPorTurma = new Map();
    for (const { codigoTurma, aluno } of alunosPorTurma) {
        const contagem = contagemPorTurma.get(codigoTurma) || { total: 0, importados: 0 };
        contagem.total++;
        if (aluno && (aluno.telefone || aluno.situacao)) contagem.importados++;
        contagemPorTurma.set(codigoTurma, contagem);
    }
    return new Set(
        [...contagemPorTurma].filter(([, c]) => c.importados * 2 >= c.total).map(([codigo]) => codigo)
    );
}

// Enriquece a lista de risco com telefone, histórico de contato e a última aula
// da turma — o que a tela /risco precisa pra decidir quem abordar e como.
async function listarEmRisco(req, res) {
    try {
        const { turma } = req.query;
        const { emRisco, ultimaAulaPorTurma } = await calcularAlunosEmRiscoSemRecuperados();

        const resultado = turma
            ? emRisco.filter((item) => item.codigoTurma === turma)
            : emRisco;

        const matriculas = resultado.map((item) => item.matricula);

        const codigosTurma = [...new Set(resultado.map((item) => item.codigoTurma).filter(Boolean))];

        const [alunos, contatos, codigosImportados] = await Promise.all([
            prisma.aluno.findMany({
                where: { matricula: { in: matriculas } },
                select: { matricula: true, telefone: true }
            }),
            // Já vem ordenado por mais recente; guardamos só o primeiro encontro de
            // cada matrícula pra ter o último contato sem precisar de outra query.
            prisma.contato.findMany({
                where: { matricula: { in: matriculas } },
                orderBy: { criadoEm: 'desc' }
            }),
            listarTurmasImportadas(codigosTurma)
        ]);

        const telefonePorMatricula = new Map(alunos.map((aluno) => [aluno.matricula, aluno.telefone]));
        const ultimoContatoPorMatricula = new Map();
        // Quantas vezes a coordenação já tentou falar com o aluno: quem acumula
        // várias tentativas sem resposta precisa de outra abordagem (ligação,
        // responsável), não de mais uma mensagem igual.
        const totalContatosPorMatricula = new Map();
        for (const contato of contatos) {
            if (!ultimoContatoPorMatricula.has(contato.matricula)) {
                ultimoContatoPorMatricula.set(contato.matricula, contato);
            }
            totalContatosPorMatricula.set(contato.matricula, (totalContatosPorMatricula.get(contato.matricula) || 0) + 1);
        }

        const dados = resultado.map((item) => ({
            ...item,
            telefone: telefonePorMatricula.get(item.matricula) || null,
            ultimoContato: ultimoContatoPorMatricula.get(item.matricula) || null,
            totalContatos: totalContatosPorMatricula.get(item.matricula) || 0,
            ultimaAulaTurma: ultimaAulaPorTurma.get(item.codigoTurma || '') || null,
            turmaImportada: codigosImportados.has(item.codigoTurma)
        }));

        res.json({ status: 'ok', total: dados.length, dados });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Recebe a planilha Excel da secretaria (colunas: Aluno, Nascimento, Matricula,
// Telefone, Telefone, Situação, Apuração) e importa Matricula + Aluno (nome) +
// Telefone (a primeira coluna "Telefone" — a segunda é ignorada) + Situação.
// O telefone alimenta o link de WhatsApp das telas de Faltas e Risco; a situação
// é o que define "aluno ativo" no painel, então a planilha precisa entrar
// inteira: quem não tem telefone também é aluno e também conta.
async function importarTelefones(req, res) {
    if (!req.file) {
        return res.status(400).json({ status: 'erro', mensagem: 'Nenhum arquivo enviado' });
    }

    try {
        // codepage 65001 = UTF-8, evita corromper acentos em planilhas .xls antigas
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', codepage: 65001 });
        const planilha = workbook.Sheets[workbook.SheetNames[0]];

        if (!planilha) {
            return res.status(400).json({ status: 'erro', mensagem: 'Planilha vazia' });
        }

        // raw: false formata os valores como texto (preserva zero à esquerda em
        // matrícula/telefone); header: 1 devolve cada linha como array de células.
        const linhas = XLSX.utils.sheet_to_json(planilha, { header: 1, raw: false, defval: '' });

        // A planilha da secretaria tem um bloco de título (logo, nome da escola,
        // dados da turma) antes da tabela — o cabeçalho real pode estar em
        // qualquer linha, então procuramos a primeira linha com "matricula".
        let colMatricula = -1;
        let colTelefone = -1;
        let colNome = -1;
        let colSituacao = -1;
        let indiceCabecalho = -1;

        for (let i = 0; i < linhas.length; i++) {
            // A comparação ignora acento pra achar "Situação" do jeito que a
            // secretaria escrever ("Situacao", "SITUAÇÃO", com espaço sobrando).
            const valores = linhas[i].map(normalizarTexto);
            const indiceMatricula = valores.indexOf('matricula');
            if (indiceMatricula !== -1) {
                indiceCabecalho = i;
                colMatricula = indiceMatricula;
                colTelefone = valores.indexOf('telefone');
                colNome = valores.indexOf('aluno');
                colSituacao = valores.indexOf('situacao');
                break;
            }
        }

        if (indiceCabecalho === -1 || colTelefone === -1) {
            return res.status(400).json({ status: 'erro', mensagem: 'A planilha precisa ter as colunas "Matricula" e "Telefone"' });
        }

        let importados = 0;
        let semTelefone = 0;
        // Telefones corrigidos na tela /telefones: a planilha não sobrescreve.
        // Quem edita na mão está vendo o número novo do aluno na frente; a
        // planilha da secretaria costuma ser mais velha que essa correção.
        const editadosNoPainel = new Set(
            (await prisma.aluno.findMany({
                where: { telefoneEditadoEm: { not: null } },
                select: { matricula: true }
            })).map((aluno) => aluno.matricula)
        );
        let telefonesPreservados = 0;
        // Contagem por situação encontrada na planilha, devolvida na resposta: é
        // como a coordenação descobre quais valores a secretaria usa de verdade
        // e confere se SITUACOES_ATIVAS cobre todos eles.
        const situacoes = {};

        for (let i = indiceCabecalho + 1; i < linhas.length; i++) {
            const linha = linhas[i];
            const matricula = (linha[colMatricula] || '').toString().trim();
            if (!matricula) continue;

            const telefone = (linha[colTelefone] || '').toString().replace(/\D/g, '');
            const nome = colNome !== -1 ? (linha[colNome] || '').toString().trim() : '';
            const situacao = colSituacao !== -1 ? (linha[colSituacao] || '').toString().trim() : '';

            if (!telefone) semTelefone++;

            const rotuloSituacao = situacao || 'Sem situação na planilha';
            situacoes[rotuloSituacao] = (situacoes[rotuloSituacao] || 0) + 1;

            // Só sobrescreve o que a planilha realmente traz: uma planilha sem
            // telefone pra um aluno não pode apagar o telefone que já temos dele.
            const campos = {};
            if (telefone && editadosNoPainel.has(matricula)) {
                telefonesPreservados++;
            } else if (telefone) {
                campos.telefone = telefone;
            }
            if (nome) campos.nome = nome;
            if (situacao) campos.situacao = situacao;

            // Uma query por linha (~130 por turma). É lento em tese, mas a
            // importação roda uma vez por turma por semestre — não vale a
            // complexidade de agrupar em transação.
            await prisma.aluno.upsert({
                where: { matricula },
                update: campos,
                create: { matricula, ...campos }
            });
            importados++;
        }

        res.json({
            status: 'ok',
            mensagem: `${importados} aluno(s) importado(s)`
                + (semTelefone > 0 ? `, ${semTelefone} sem telefone na planilha` : '')
                + (telefonesPreservados > 0 ? `, ${telefonesPreservados} telefone(s) corrigido(s) no painel foram mantidos` : ''),
            situacoes,
            telefonesPreservados
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Quantos alunos a busca da tela /telefones devolve no máximo. É busca pra
// achar um aluno específico, não listagem: a tela pede pra refinar se estourar.
const LIMITE_BUSCA_ALUNOS = 50;

// Campos que a tela /telefones mostra de cada aluno
const CAMPOS_ALUNO_BUSCA = {
    matricula: true,
    nome: true,
    telefone: true,
    situacao: true,
    whatsappOptOut: true,
    telefoneEditadoEm: true,
    telefoneEditadoPor: true
};

// Busca aluno por parte do nome ou da matrícula, pra tela /telefones. Sem termo
// não devolve nada: são dados de menores, uma chamada sem filtro despejaria a
// escola inteira.
async function buscarAlunos(req, res) {
    const busca = (req.query.busca || '').toString().trim();

    if (busca.length < 2) {
        return res.status(400).json({ status: 'erro', mensagem: 'Digite pelo menos 2 caracteres pra buscar' });
    }

    try {
        // O nome do aluno mora em dois lugares: `alunos.nome`, que só quem veio
        // da planilha da secretaria tem, e `lancamentos.nome_aluno`, que todo
        // aluno com chamada lançada tem. Procurar só na tabela `alunos` não
        // acha quem está em turma ainda não importada — justamente quem tende a
        // estar sem telefone e ser o alvo desta tela.
        const [cadastrados, lancados] = await Promise.all([
            prisma.aluno.findMany({
                where: {
                    OR: [
                        { nome: { contains: busca } },
                        { matricula: { contains: busca } }
                    ]
                },
                select: CAMPOS_ALUNO_BUSCA,
                take: LIMITE_BUSCA_ALUNOS
            }),
            prisma.lancamento.findMany({
                where: {
                    OR: [
                        { nomeAluno: { contains: busca } },
                        { matricula: { contains: busca } }
                    ]
                },
                select: { matricula: true, nomeAluno: true },
                distinct: ['matricula'],
                take: LIMITE_BUSCA_ALUNOS
            })
        ]);

        const nomeDoLancamento = new Map(
            lancados.filter((item) => item.nomeAluno).map((item) => [item.matricula, item.nomeAluno])
        );
        const porMatricula = new Map(cadastrados.map((aluno) => [aluno.matricula, aluno]));
        const matriculas = [...new Set([...porMatricula.keys(), ...lancados.map((item) => item.matricula)])];

        // Quem veio pelo lançamento pode já ter linha em `alunos` (criada por um
        // contato, por exemplo) sem o nome preenchido — então o cadastro dele
        // precisa ser buscado à parte, senão o telefone que já existe some.
        const semCadastroCarregado = matriculas.filter((matricula) => !porMatricula.has(matricula));
        if (semCadastroCarregado.length) {
            const extras = await prisma.aluno.findMany({
                where: { matricula: { in: semCadastroCarregado } },
                select: CAMPOS_ALUNO_BUSCA
            });
            extras.forEach((aluno) => porMatricula.set(aluno.matricula, aluno));
        }

        const dados = matriculas
            .map((matricula) => {
                const aluno = porMatricula.get(matricula);
                return {
                    matricula,
                    nome: (aluno && aluno.nome) || nomeDoLancamento.get(matricula) || null,
                    telefone: aluno ? aluno.telefone : null,
                    situacao: aluno ? aluno.situacao : null,
                    whatsappOptOut: aluno ? aluno.whatsappOptOut : false,
                    telefoneEditadoEm: aluno ? aluno.telefoneEditadoEm : null,
                    telefoneEditadoPor: aluno ? aluno.telefoneEditadoPor : null,
                    // Aparece só em lançamento: a planilha da turma dele ainda
                    // não foi importada. Salvar o telefone cria o cadastro.
                    semCadastro: !aluno
                };
            })
            .sort((a, b) => (a.nome || 'zzz').localeCompare(b.nome || 'zzz', 'pt-BR'))
            .slice(0, LIMITE_BUSCA_ALUNOS);

        res.json({ status: 'ok', dados, limite: LIMITE_BUSCA_ALUNOS });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Corrige o telefone de um aluno que trocou de número no meio do semestre. O
// número fica marcado como editado na mão (telefoneEditadoEm), e a partir daí a
// importação da planilha não o sobrescreve mais.
async function atualizarTelefone(req, res) {
    const { matricula } = req.params;
    const { telefone } = req.body;

    // Mesma normalização da importação: `alunos.telefone` guarda só dígitos e
    // sem o 55 — é o formato de que dependem o link wa.me das telas e a
    // comparação com o número conectado no WhatsApp.
    const digitos = (telefone || '').toString().replace(/\D/g, '');

    if (digitos && (digitos.length < 10 || digitos.length > 11)) {
        return res.status(400).json({ status: 'erro', mensagem: 'O telefone precisa ter DDD + 8 ou 9 dígitos' });
    }

    try {
        // Aluno de turma ainda não importada não tem linha em `alunos` — só
        // lançamento. Criar o cadastro aqui é o mesmo que `POST /contatos` faz:
        // é justamente esse aluno que costuma estar sem telefone. Sem nenhum
        // lançamento, porém, a matrícula não existe no sistema: é erro de
        // digitação, e criar a linha só sujaria a contagem do painel.
        const cadastro = await prisma.aluno.findUnique({ where: { matricula }, select: { matricula: true } });
        if (!cadastro) {
            const lancamento = await prisma.lancamento.findFirst({
                where: { matricula },
                select: { nomeAluno: true },
                orderBy: { criadoEm: 'desc' }
            });
            if (!lancamento) {
                return res.status(404).json({ status: 'erro', mensagem: 'Aluno não encontrado' });
            }
            await prisma.aluno.create({ data: { matricula, nome: lancamento.nomeAluno || null } });
        }

        const aluno = await prisma.aluno.update({
            where: { matricula },
            // Campo vazio apaga o telefone de propósito: é como se registra que
            // o número antigo não serve mais e ninguém tem o novo ainda.
            data: {
                telefone: digitos || null,
                telefoneEditadoEm: new Date(),
                telefoneEditadoPor: req.usuario.usuario
            },
            select: CAMPOS_ALUNO_BUSCA
        });

        res.json({ status: 'ok', dados: aluno });
    } catch (erro) {
        // Aluno só existe aqui se veio da planilha ou de um lançamento — a tela
        // não cadastra aluno novo.
        if (erro.code === 'P2025') {
            return res.status(404).json({ status: 'erro', mensagem: 'Aluno não encontrado' });
        }
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Turma sem chamada lançada há mais que isso (dias corridos) ganha alerta no
// painel. O sistema inteiro depende do professor lançar com o userscript: turma
// sem lançamento some do "em risco" sem ninguém perceber — aluno que evadiu
// simplesmente não aparece.
const DIAS_SEM_CHAMADA_ALERTA = 7;

// Turma sem nenhum lançamento há mais que isso sai do ranking do painel: é turma
// encerrada (semestre passado), não turma parada — senão ficaria pra sempre com
// alerta de "sem chamada" e empurraria as turmas de verdade pra baixo.
const DIAS_TURMA_ENCERRADA = 60;

// Status de contato que indicam que a coordenação conseguiu falar com o aluno
// (ou com a família). "nunca_contato" é "tentou e não conseguiu", não "nunca
// tentou" — o rótulo na tela é "Nunca contatado".
const STATUS_COM_RETORNO = ['respondido', 'acompanhar'];

function diasDesde(dataAula) {
    if (!dataAula) return null;
    const hoje = converterDataAula(diaNoFusoDaEscola(new Date()));
    return Math.round((hoje - converterDataAula(dataAula)) / (24 * 60 * 60 * 1000));
}

// GET /alunos/atencao — dois blocos do painel:
// - `contatos`: em que pé está o trabalho da coordenação com quem precisa de
//   atenção agora (em risco + em acompanhamento na /recuperado). As fatias são
//   excludentes e somam o total, pra caberem numa barra só.
// - `turmas`: uma linha por turma com chamada lançada — onde agir primeiro, e
//   quais turmas estão sem chamada recente (ponto cego do sistema).
async function atencaoPainel(req, res) {
    try {
        const { turma } = req.query;
        const { emRisco, recuperados, ultimaAulaPorTurma, matriculasPorTurma } = await calcularAlunosEmRiscoSemRecuperados();

        const riscoFiltrado = turma ? emRisco.filter((item) => item.codigoTurma === turma) : emRisco;
        const recuperadosFiltrado = turma ? recuperados.filter((item) => item.codigoTurma === turma) : recuperados;
        const codigosTurma = turma ? (matriculasPorTurma.has(turma) ? [turma] : []) : [...matriculasPorTurma.keys()].filter(Boolean);

        const [contatos, codigosImportados, nomes] = await Promise.all([
            prisma.contato.findMany({
                where: { matricula: { in: [...new Set(emRisco.map((item) => item.matricula))] } },
                select: { matricula: true, status: true },
                orderBy: { criadoEm: 'desc' }
            }),
            listarTurmasImportadas(codigosTurma),
            prisma.lancamento.findMany({
                where: { codigoTurma: { in: codigosTurma } },
                select: { codigoTurma: true, nomeTurma: true },
                distinct: ['codigoTurma']
            })
        ]);

        const ultimoStatusPorMatricula = new Map();
        for (const contato of contatos) {
            if (!ultimoStatusPorMatricula.has(contato.matricula)) ultimoStatusPorMatricula.set(contato.matricula, contato.status);
        }
        const situacaoContato = (matricula) => {
            if (!ultimoStatusPorMatricula.has(matricula)) return 'semContato';
            return STATUS_COM_RETORNO.includes(ultimoStatusPorMatricula.get(matricula)) ? 'comRetorno' : 'semResposta';
        };

        // Matrículas distintas, como o card "em risco": quem está em risco em duas
        // turmas é um aluno só pra coordenação contatar.
        const contagemContatos = { semContato: 0, semResposta: 0, comRetorno: 0 };
        for (const matricula of new Set(riscoFiltrado.map((item) => item.matricula))) {
            contagemContatos[situacaoContato(matricula)]++;
        }
        const matriculasAcompanhamento = new Set(recuperadosFiltrado.map((item) => item.matricula));
        const matriculasFaltaram = new Set(recuperadosFiltrado.filter((item) => item.diasComFalta.length > 0).map((item) => item.matricula));

        const nomePorTurma = new Map(nomes.map((item) => [item.codigoTurma, item.nomeTurma]));
        const turmas = codigosTurma.map((codigo) => {
            const riscoDaTurma = emRisco.filter((item) => item.codigoTurma === codigo);
            const alunos = matriculasPorTurma.get(codigo)?.size || 0;
            const ultimaAula = ultimaAulaPorTurma.get(codigo) || null;
            return {
                codigoTurma: codigo,
                nomeTurma: nomePorTurma.get(codigo) || codigo,
                alunos,
                emRisco: riscoDaTurma.length,
                percentualRisco: alunos > 0 ? Math.round((riscoDaTurma.length / alunos) * 100) : 0,
                semContato: riscoDaTurma.filter((item) => situacaoContato(item.matricula) === 'semContato').length,
                emAcompanhamento: recuperados.filter((item) => item.codigoTurma === codigo).length,
                importada: codigosImportados.has(codigo),
                ultimaAula,
                diasSemChamada: diasDesde(ultimaAula)
            };
        });

        // Quem tem mais aluno em risco esperando contato vem primeiro — é onde a
        // coordenação precisa agir. Empate: maior % de risco.
        const turmasAtivas = turmas.filter((item) => item.diasSemChamada === null || item.diasSemChamada <= DIAS_TURMA_ENCERRADA);
        turmasAtivas.sort((a, b) => b.semContato - a.semContato || b.percentualRisco - a.percentualRisco || b.emRisco - a.emRisco);

        res.json({
            status: 'ok',
            dados: {
                contatos: {
                    ...contagemContatos,
                    emAcompanhamento: matriculasAcompanhamento.size,
                    faltaramNoAcompanhamento: matriculasFaltaram.size
                },
                turmas: turmasAtivas,
                diasSemChamadaAlerta: DIAS_SEM_CHAMADA_ALERTA
            }
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// POST /casos-resolvidos — encerra o caso de um aluno numa turma. Ele sai do risco
// e do acompanhamento mesmo continuando a faltar. A marcação vira também um
// `Contato` (status "recuperado"), pra ficar no histórico do aluno e contar no
// gráfico de motivos do painel — é ali que se vê por que os casos se resolvem.
async function resolverCaso(req, res) {
    try {
        const { matricula, codigoTurma, nomeAluno, nomeTurma, motivo, observacao } = req.body;
        if (!matricula || !codigoTurma) {
            return res.status(400).json({ status: 'erro', mensagem: 'Informe matrícula e turma' });
        }

        // A FK de Contato exige o aluno; nem todo aluno em risco veio da planilha.
        await prisma.aluno.upsert({
            where: { matricula },
            update: {},
            create: { matricula, nome: nomeAluno || null }
        });

        const contato = await prisma.contato.create({
            data: {
                matricula,
                canal: 'presencial',
                status: 'recuperado',
                motivo: motivo || null,
                observacao: `Caso encerrado na tela de Recuperados${observacao ? `: ${observacao}` : '.'}`,
                contatadoPor: req.usuario.usuario
            }
        });

        const caso = await prisma.casoResolvido.upsert({
            where: { matricula_codigoTurma: { matricula, codigoTurma } },
            update: { motivo: motivo || null, observacao: observacao || null, resolvidoPor: req.usuario.usuario, nomeAluno, nomeTurma },
            create: { matricula, codigoTurma, nomeAluno, nomeTurma, motivo: motivo || null, observacao: observacao || null, resolvidoPor: req.usuario.usuario }
        });

        res.json({ status: 'ok', mensagem: 'Caso encerrado. O aluno sai do risco até alguém reabrir.', dados: caso, contatoId: contato.id });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// GET /casos-resolvidos — lista os casos encerrados (tela /recuperado).
async function listarCasosResolvidosRota(req, res) {
    try {
        const { turma } = req.query;
        const casos = await prisma.casoResolvido.findMany({
            where: turma ? { codigoTurma: turma } : {},
            orderBy: { criadoEm: 'desc' }
        });
        res.json({ status: 'ok', total: casos.length, dados: casos });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// DELETE /casos-resolvidos/:matricula/:codigoTurma — reabre: o aluno volta a ser
// avaliado pelas faltas normalmente (entra em risco se a sequência estiver aberta).
async function reabrirCaso(req, res) {
    try {
        const { matricula, codigoTurma } = req.params;
        const caso = await prisma.casoResolvido.findUnique({ where: { matricula_codigoTurma: { matricula, codigoTurma } } });
        if (!caso) return res.status(404).json({ status: 'erro', mensagem: 'Este caso não está encerrado.' });

        await prisma.casoResolvido.delete({ where: { id: caso.id } });
        await prisma.contato.create({
            data: {
                matricula,
                canal: 'presencial',
                status: 'acompanhar',
                observacao: 'Caso reaberto: o aluno volta a ser acompanhado pelas faltas.',
                contatadoPor: req.usuario.usuario
            }
        });

        res.json({ status: 'ok', mensagem: 'Caso reaberto. O aluno volta a ser avaliado pelas faltas.' });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Números do painel. "Ativo" vem da coluna Situação da planilha da secretaria,
// não de "não está na lista de risco": quem evade de vez para de receber
// lançamento de falta e sairia da lista de risco sozinho, sendo contado como
// ativo — quanto mais evasão, mais "ativos". A planilha é a fonte confiável.
async function resumoAlunos(req, res) {
    try {
        const { turma } = req.query;

        const [todosAlunos, { emRisco, matriculasPorTurma }, matriculasRecuperadas] = await Promise.all([
            prisma.aluno.findMany({ select: { matricula: true, telefone: true, situacao: true, atualizadoEm: true } }),
            calcularAlunosEmRiscoSemRecuperados(),
            listarMatriculasRecuperadas()
        ]);

        // Filtrar por turma restringe aos alunos com chamada lançada nela. Quem foi
        // importado da planilha mas ainda não apareceu em nenhum lançamento fica de
        // fora do recorte por turma — só aparece no total geral.
        // Turma sem nenhum lançamento cai num Set vazio (e não em "todas"), pra um
        // código de turma errado devolver zero em vez do total da escola.
        const matriculasDaTurma = turma ? (matriculasPorTurma.get(turma) || new Set()) : null;
        const alunos = matriculasDaTurma
            ? todosAlunos.filter((aluno) => matriculasDaTurma.has(aluno.matricula))
            : todosAlunos;

        const emRiscoFiltrado = turma
            ? emRisco.filter((item) => item.codigoTurma === turma)
            : emRisco;

        let inativos = 0;
        let semSituacao = 0;
        let semTelefone = 0;
        let importadosEm = null;
        const matriculasMatriculadas = new Set();

        for (const aluno of alunos) {
            if (ehSituacaoAtiva(aluno.situacao)) matriculasMatriculadas.add(aluno.matricula);
            else inativos++;

            if (!aluno.situacao) semSituacao++;
            if (!aluno.telefone) semTelefone++;

            if (!importadosEm || aluno.atualizadoEm > importadosEm) importadosEm = aluno.atualizadoEm;
        }

        // calcularAlunosEmRisco devolve uma linha por (aluno, turma): contamos
        // matrículas distintas pra não inflar o número de alunos com quem estuda
        // em duas turmas — senão o risco pode até passar o total de ativos.
        const matriculasEmRisco = new Set(emRiscoFiltrado.map((item) => item.matricula));

        const matriculados = matriculasMatriculadas.size;

        // "Ativo" no painel é quem está vindo à aula: matriculado e sem sequência
        // de faltas em aberto. A subtração só desconta quem está nos dois lados da
        // conta — pode haver lançamento de aluno que não veio na planilha (ou que
        // veio como cancelado), e descontar essa gente do total de matriculados
        // daria um número menor que a realidade, ou até negativo.
        const emRiscoMatriculados = [...matriculasEmRisco].filter((matricula) => matriculasMatriculadas.has(matricula)).length;
        const ativos = matriculados - emRiscoMatriculados;

        // Recuperado = último contato marcado como "recuperado" pela coordenação
        // (ver listarMatriculasRecuperadas). Quem está no acompanhamento da
        // /recuperado já sai do "em risco" (calcularAlunosEmRiscoSemRecuperados);
        // depois do acompanhamento, se voltou a faltar, pode contar nos dois.
        const recuperados = matriculasDaTurma
            ? [...matriculasRecuperadas].filter((matricula) => matriculasDaTurma.has(matricula)).length
            : matriculasRecuperadas.size;

        res.json({
            status: 'ok',
            dados: {
                // ativos = está vindo à aula; matriculados = total da planilha.
                // A diferença entre os dois é o que está em risco.
                ativos,
                matriculados,
                inativos,
                semSituacao,
                semTelefone,
                emRisco: matriculasEmRisco.size,
                // Parte do "em risco" que está na planilha. É o numerador certo pro
                // "% dos matriculados": o emRisco inclui aluno de turma que não foi
                // importada, e dividir isso pelos matriculados mistura duas bases
                // (dava 142/212 = 67% quando só 71 dos 142 estão na planilha).
                emRiscoMatriculados,
                recuperados,
                importadosEm,
                criterioRisco: DIAS_AULA_CONSECUTIVOS_RISCO
            }
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = {
    listarEmRisco,
    listarRecuperados,
    importarTelefones,
    buscarAlunos,
    atualizarTelefone,
    resumoAlunos,
    atencaoPainel,
    resolverCaso,
    listarCasosResolvidosRota,
    reabrirCaso,
    DIAS_AULA_CONSECUTIVOS_RISCO,
    // Reaproveitados pelo envio de WhatsApp (src/services/whatsappLote.js)
    calcularAlunosEmRiscoSemRecuperados,
    ehSituacaoAtiva,
    converterDataAula,
    diaNoFusoDaEscola,
    FUSO_ESCOLA
};
