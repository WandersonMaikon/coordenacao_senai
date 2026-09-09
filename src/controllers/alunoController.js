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

// Nº de dias de aula seguidos sem vir que um sumiço precisa ter tido para que a
// volta do aluno conte como recuperação no painel. É bem maior que o critério de
// risco de propósito: com a régua do risco (2 dias), "recuperado" viraria ruído —
// quem faltou dois dias por uma gripe e voltou não foi resgatado, só adoeceu.
// Aqui a régua é "sumiu a ponto de parecer evasão e mesmo assim voltou".
const DIAS_AULA_SUMIDO_RECUPERADO = 6;

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
    const recuperados = [];
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

        // Sumiços que já terminaram: sequência de faltas fechada por um dia em que
        // o aluno veio. Sumiço longo o bastante + volta = recuperação. Percorre do
        // começo pro fim justamente porque interessa o que já foi resolvido — o
        // contrário da sequência em aberto, que se conta do fim pro começo.
        let diasSumido = 0;
        let inicioSumico = null;
        for (const dia of dias) {
            const faltou = !dia.tevePresenca && dia.faltas > 0;
            if (faltou) {
                if (diasSumido === 0) inicioSumico = dia.dataAula;
                diasSumido++;
                continue;
            }

            if (diasSumido >= DIAS_AULA_SUMIDO_RECUPERADO) {
                recuperados.push({
                    matricula: registros[0].matricula,
                    nomeAluno: registros[0].nomeAluno,
                    codigoTurma: registros[0].codigoTurma,
                    diasSumido,
                    inicioSumico,
                    dataRetorno: dia.dataAula
                });
            }
            diasSumido = 0;
            inicioSumico = null;
        }

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

    return { emRisco: resultado, recuperados, ultimaAulaPorTurma, matriculasPorTurma };
}

// Enriquece a lista de risco com telefone, histórico de contato e a última aula
// da turma — o que a tela /risco precisa pra decidir quem abordar e como.
async function listarEmRisco(req, res) {
    try {
        const { turma } = req.query;
        const { emRisco, ultimaAulaPorTurma } = await calcularAlunosEmRisco();

        const resultado = turma
            ? emRisco.filter((item) => item.codigoTurma === turma)
            : emRisco;

        const matriculas = resultado.map((item) => item.matricula);

        const [alunos, contatos] = await Promise.all([
            prisma.aluno.findMany({
                where: { matricula: { in: matriculas } },
                select: { matricula: true, telefone: true }
            }),
            // Já vem ordenado por mais recente; guardamos só o primeiro encontro de
            // cada matrícula pra ter o último contato sem precisar de outra query.
            prisma.contato.findMany({
                where: { matricula: { in: matriculas } },
                orderBy: { criadoEm: 'desc' }
            })
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
            ultimaAulaTurma: ultimaAulaPorTurma.get(item.codigoTurma || '') || null
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
            if (telefone) campos.telefone = telefone;
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
            mensagem: `${importados} aluno(s) importado(s)${semTelefone > 0 ? `, ${semTelefone} sem telefone na planilha` : ''}`,
            situacoes
        });
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

        const [todosAlunos, { emRisco, recuperados, matriculasPorTurma }] = await Promise.all([
            prisma.aluno.findMany({ select: { matricula: true, telefone: true, situacao: true, atualizadoEm: true } }),
            calcularAlunosEmRisco()
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

        // Recuperado é quem sumiu, voltou e continua vindo: quem está em risco
        // agora sai da conta, mesmo que já tenha sido resgatado antes. Assim os
        // dois cards do painel são estados excludentes e ninguém é contado nos
        // dois — um resgate que não durou não é um resgate.
        const recuperadosFiltrados = (turma ? recuperados.filter((item) => item.codigoTurma === turma) : recuperados)
            .filter((item) => !matriculasEmRisco.has(item.matricula));

        // Um aluno pode ter sumido e voltado mais de uma vez: guardamos o retorno
        // mais recente de cada um, que é o que interessa pra saber se o contato
        // da coordenação teve a ver com a volta.
        const retornoPorMatricula = new Map();
        for (const item of recuperadosFiltrados) {
            const anterior = retornoPorMatricula.get(item.matricula);
            if (!anterior || converterDataAula(item.dataRetorno) > converterDataAula(anterior.dataRetorno)) {
                retornoPorMatricula.set(item.matricula, item);
            }
        }

        // Quantos voltaram depois de a coordenação ter ido atrás: exige um contato
        // registrado dentro da janela do sumiço (entre a primeira falta e o dia da
        // volta). Contato feito antes do sumiço ou depois da volta não conta.
        let recuperadosAposContato = 0;
        if (retornoPorMatricula.size > 0) {
            const contatos = await prisma.contato.findMany({
                where: { matricula: { in: [...retornoPorMatricula.keys()] } },
                select: { matricula: true, criadoEm: true }
            });

            const contatosPorMatricula = new Map();
            for (const contato of contatos) {
                if (!contatosPorMatricula.has(contato.matricula)) contatosPorMatricula.set(contato.matricula, []);
                contatosPorMatricula.get(contato.matricula).push(contato.criadoEm);
            }

            for (const [matricula, item] of retornoPorMatricula) {
                const inicio = converterDataAula(item.inicioSumico);
                // +1 dia: o contato pode ter sido registrado no mesmo dia da volta,
                // e converterDataAula devolve a meia-noite daquele dia.
                const fim = converterDataAula(item.dataRetorno) + 24 * 60 * 60 * 1000;
                const teveContato = (contatosPorMatricula.get(matricula) || [])
                    .some((criadoEm) => criadoEm.getTime() >= inicio && criadoEm.getTime() < fim);
                if (teveContato) recuperadosAposContato++;
            }
        }

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
                recuperados: retornoPorMatricula.size,
                recuperadosAposContato,
                importadosEm,
                criterioRisco: DIAS_AULA_CONSECUTIVOS_RISCO,
                criterioRecuperado: DIAS_AULA_SUMIDO_RECUPERADO
            }
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { listarEmRisco, importarTelefones, resumoAlunos, DIAS_AULA_CONSECUTIVOS_RISCO };
