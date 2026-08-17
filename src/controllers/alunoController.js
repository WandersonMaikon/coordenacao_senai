const XLSX = require('xlsx');
const prisma = require('../config/prisma');

// Limiar de faltas acumuladas para considerar o aluno em risco (decisão do usuário: mínimo 4)
const LIMITE_FALTAS_RISCO = 4;

// Agrupa lançamentos por aluno e filtra quem já atingiu o limite de faltas
async function listarEmRisco(req, res) {
    try {
        const resultado = await prisma.lancamento.groupBy({
            by: ['matricula', 'nomeAluno'],
            _sum: { qtdFaltas: true },
            having: {
                qtdFaltas: { _sum: { gte: LIMITE_FALTAS_RISCO } }
            },
            orderBy: { _sum: { qtdFaltas: 'desc' } }
        });
        res.json({ status: 'ok', total: resultado.length, dados: resultado });
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

module.exports = { listarEmRisco, importarTelefones, LIMITE_FALTAS_RISCO };
