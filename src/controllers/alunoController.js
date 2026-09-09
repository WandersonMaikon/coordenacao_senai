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

function converterDataAula(dataAula) {
    if (!dataAula) return 0;
    const [dia, mes, ano] = dataAula.split('/').map(Number);
    return new Date(ano, (mes || 1) - 1, dia || 1).getTime();
}

// Agrupa lançamentos por (aluno, turma) e verifica a sequência de faltas em
// aberto, do dia mais recente pra trás, parando no primeiro dia com presença.
async function listarEmRisco(req, res) {
    try {
        const { turma } = req.query;

        const lancamentos = await prisma.lancamento.findMany({
            select: { matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, dataAula: true, qtdFaltas: true }
        });

        const grupos = new Map();
        // Dia de aula mais recente lançado em cada turma (por qualquer aluno, não só
        // os em risco) — a tela mostra no cabeçalho da turma pra deixar claro até
        // quando a frequência daquela turma está atualizada.
        const ultimaAulaPorTurma = new Map();
        for (const item of lancamentos) {
            const chave = `${item.matricula}||${item.codigoTurma || ''}`;
            if (!grupos.has(chave)) grupos.set(chave, []);
            grupos.get(chave).push(item);

            const chaveTurma = item.codigoTurma || '';
            const atual = ultimaAulaPorTurma.get(chaveTurma);
            if (!atual || converterDataAula(item.dataAula) > converterDataAula(atual)) {
                ultimaAulaPorTurma.set(chaveTurma, item.dataAula);
            }
        }

        let resultado = [];
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

        if (turma) {
            resultado = resultado.filter((item) => item.codigoTurma === turma);
        }

        resultado.sort((a, b) => b.diasSemVir - a.diasSemVir || b.totalFaltas - a.totalFaltas);

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
// Telefone, Telefone, Situação, Apuração) e importa só Matricula + Telefone
// (primeira coluna "Telefone" da planilha — a segunda é ignorada), vinculando
// o telefone ao aluno pra tela de Faltas poder linkar direto pro WhatsApp.
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
        let indiceCabecalho = -1;

        for (let i = 0; i < linhas.length; i++) {
            const valores = linhas[i].map((valor) => (valor || '').toString().trim().toLowerCase());
            const indiceMatricula = valores.indexOf('matricula');
            if (indiceMatricula !== -1) {
                indiceCabecalho = i;
                colMatricula = indiceMatricula;
                colTelefone = valores.indexOf('telefone');
                break;
            }
        }

        if (indiceCabecalho === -1 || colTelefone === -1) {
            return res.status(400).json({ status: 'erro', mensagem: 'A planilha precisa ter as colunas "Matricula" e "Telefone"' });
        }

        let importados = 0;
        let semTelefone = 0;

        for (let i = indiceCabecalho + 1; i < linhas.length; i++) {
            const linha = linhas[i];
            const matricula = (linha[colMatricula] || '').toString().trim();
            const telefone = (linha[colTelefone] || '').toString().replace(/\D/g, '');

            if (!matricula) continue;
            if (!telefone) {
                semTelefone++;
                continue;
            }

            await prisma.aluno.upsert({
                where: { matricula },
                update: { telefone },
                create: { matricula, telefone }
            });
            importados++;
        }

        res.json({
            status: 'ok',
            mensagem: `${importados} telefone(s) importado(s)${semTelefone > 0 ? `, ${semTelefone} aluno(s) sem telefone na planilha` : ''}`
        });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { listarEmRisco, importarTelefones, DIAS_AULA_CONSECUTIVOS_RISCO };
