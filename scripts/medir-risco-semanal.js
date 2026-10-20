// Mede quantos alunos ENTRAM em risco por semana — o número que decide quantos
// números de WhatsApp o envio automático precisa (ver "O funil automático" em
// docs/visao/VISAO.md). Só lê o banco e só imprime contagens: nenhum nome,
// matrícula ou telefone de aluno sai no terminal.
//
// Uso (no servidor):
//   docker compose exec node_retencao node scripts/medir-risco-semanal.js
//       → últimas 8 semanas
//   docker compose exec node_retencao node scripts/medir-risco-semanal.js 12
//       → últimas 12 semanas
//
// "Entrar em risco" usa a mesma regra do /alunos-risco (DIAS_AULA_CONSECUTIVOS_RISCO
// dias de aula seguidos com falta, presença em qualquer UC conta como dia
// presente), mas percorrendo o histórico inteiro: cada vez que uma sequência de
// faltas atinge o limite é um episódio novo — é exatamente quando o envio
// automático mandaria a mensagem. O dia em que isso acontece é o dia do episódio.
//
// O que o resultado NÃO cobre: turma cujo professor ainda não usa o userscript
// não tem lançamento, então o número real da escola é maior que este.

require('dotenv').config();
const prisma = require('../src/config/prisma');
const { converterDataAula, ehSituacaoAtiva, DIAS_AULA_CONSECUTIVOS_RISCO } = require('../src/controllers/alunoController');

const UM_DIA = 24 * 60 * 60 * 1000;

// Segunda-feira da semana da data (em ms), pra agrupar por semana.
function inicioDaSemana(ms) {
    const data = new Date(ms);
    const diaDaSemana = (data.getDay() + 6) % 7; // segunda = 0
    return new Date(data.getFullYear(), data.getMonth(), data.getDate() - diaDaSemana).getTime();
}

function formatar(ms) {
    return new Date(ms).toLocaleDateString('pt-BR');
}

// Mesmo agrupamento por dia do calcularAlunosEmRisco: faltas somam, presença em
// qualquer UC marca o dia inteiro como presença.
function diasDoAluno(registros) {
    const porDia = new Map();
    for (const item of registros) {
        const dia = item.dataAula || '';
        if (!porDia.has(dia)) porDia.set(dia, { ms: converterDataAula(dia), faltas: 0, tevePresenca: false });
        const registroDoDia = porDia.get(dia);
        const faltas = item.qtdFaltas || 0;
        registroDoDia.faltas += faltas;
        if (faltas === 0) registroDoDia.tevePresenca = true;
    }
    return [...porDia.values()].sort((a, b) => a.ms - b.ms);
}

// Episódios de um (aluno, turma): o dia em que a sequência atingiu o limite e o
// que aconteceu no dia de aula seguinte (veio, faltou, ou ainda não houve aula).
function episodios(dias) {
    const lista = [];
    let sequencia = 0;
    for (let i = 0; i < dias.length; i++) {
        const faltou = !dias[i].tevePresenca && dias[i].faltas > 0;
        sequencia = faltou ? sequencia + 1 : 0;
        if (sequencia !== DIAS_AULA_CONSECUTIVOS_RISCO) continue;

        const seguinte = dias[i + 1];
        let depois = 'sem_aula_ainda';
        if (seguinte) depois = !seguinte.tevePresenca && seguinte.faltas > 0 ? 'faltou' : 'voltou';
        lista.push({ ms: dias[i].ms, depois });
    }
    return lista;
}

async function main() {
    const semanas = Number(process.argv[2]) || 8;

    const [lancamentos, alunos] = await Promise.all([
        prisma.lancamento.findMany({
            select: { matricula: true, codigoTurma: true, nomeTurma: true, dataAula: true, qtdFaltas: true }
        }),
        prisma.aluno.findMany({
            select: { matricula: true, telefone: true, situacao: true, whatsappOptOut: true }
        })
    ]);
    const alunoPorMatricula = new Map(alunos.map((a) => [a.matricula, a]));

    // Quem receberia de fato a mensagem automática (mesmos filtros da prévia do
    // lote, sem os de contato/episódio, que dependem do momento).
    function podeReceber(matricula) {
        const aluno = alunoPorMatricula.get(matricula);
        return Boolean(aluno && aluno.telefone && ehSituacaoAtiva(aluno.situacao) && !aluno.whatsappOptOut);
    }

    const grupos = new Map();
    const nomePorTurma = new Map();
    for (const item of lancamentos) {
        const chave = `${item.matricula}||${item.codigoTurma || ''}`;
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(item);
        if (item.nomeTurma) nomePorTurma.set(item.codigoTurma || '', item.nomeTurma);
    }

    const hoje = new Date();
    const semanaAtual = inicioDaSemana(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime());
    const primeiraSemana = semanaAtual - (semanas - 1) * 7 * UM_DIA;

    const porSemana = new Map();
    const porTurma = new Map();
    const porDia = new Map();
    const turmasComAulaPorSemana = new Map();

    for (const [chave, registros] of grupos) {
        const [matricula, codigoTurma] = chave.split('||');

        // Turmas com chamada lançada em cada semana — o divisor da média por turma.
        for (const item of registros) {
            const semana = inicioDaSemana(converterDataAula(item.dataAula));
            if (semana < primeiraSemana) continue;
            if (!turmasComAulaPorSemana.has(semana)) turmasComAulaPorSemana.set(semana, new Set());
            turmasComAulaPorSemana.get(semana).add(codigoTurma);
        }

        for (const episodio of episodios(diasDoAluno(registros))) {
            const semana = inicioDaSemana(episodio.ms);
            if (semana < primeiraSemana) continue;

            if (!porSemana.has(semana)) porSemana.set(semana, { total: 0, receberiam: 0, voltou: 0, faltou: 0, semAulaAinda: 0 });
            const linha = porSemana.get(semana);
            linha.total++;
            if (podeReceber(matricula)) linha.receberiam++;
            if (episodio.depois === 'voltou') linha.voltou++;
            else if (episodio.depois === 'faltou') linha.faltou++;
            else linha.semAulaAinda++;

            porTurma.set(codigoTurma, (porTurma.get(codigoTurma) || 0) + 1);
            porDia.set(episodio.ms, (porDia.get(episodio.ms) || 0) + 1);
        }
    }

    console.log(`\nAlunos que ENTRARAM em risco por semana (${DIAS_AULA_CONSECUTIVOS_RISCO} dias de aula seguidos com falta)`);
    console.log(`Últimas ${semanas} semanas. "Receberiam" = com telefone, situação ativa e sem SAIR.\n`);
    console.log('semana de\tturmas c/ aula\tentraram\treceberiam\tmédia/turma\tvoltaram na aula seguinte\tfaltaram de novo\tsem aula ainda');

    let somaTotal = 0;
    let somaReceberiam = 0;
    for (let semana = primeiraSemana; semana <= semanaAtual; semana += 7 * UM_DIA) {
        const linha = porSemana.get(semana) || { total: 0, receberiam: 0, voltou: 0, faltou: 0, semAulaAinda: 0 };
        const turmas = turmasComAulaPorSemana.get(semana)?.size || 0;
        const media = turmas ? (linha.total / turmas).toFixed(1) : '—';
        somaTotal += linha.total;
        somaReceberiam += linha.receberiam;
        console.log(`${formatar(semana)}\t${turmas}\t\t${linha.total}\t\t${linha.receberiam}\t\t${media}\t\t${linha.voltou}\t\t\t\t${linha.faltou}\t\t\t${linha.semAulaAinda}`);
    }

    const pico = [...porDia.entries()].sort((a, b) => b[1] - a[1])[0];
    console.log(`\nMédia por semana: ${(somaTotal / semanas).toFixed(1)} entraram, ${(somaReceberiam / semanas).toFixed(1)} receberiam a mensagem.`);
    if (pico) console.log(`Dia com mais entradas: ${formatar(pico[0])}, com ${pico[1]} alunos.`);
    console.log('(A semana atual ainda está em andamento.)');

    console.log('\nPor turma (total no período, da maior para a menor):\n');
    console.log('entraram\tpor semana\tturma');
    const turmasOrdenadas = [...porTurma.entries()].sort((a, b) => b[1] - a[1]);
    for (const [codigoTurma, total] of turmasOrdenadas) {
        console.log(`${total}\t\t${(total / semanas).toFixed(1)}\t\t${codigoTurma} ${nomePorTurma.get(codigoTurma) || ''}`);
    }
}

main()
    .catch((erro) => {
        console.error('Erro ao medir:', erro.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
