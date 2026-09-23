// Interpreta o que o aluno respondeu no WhatsApp.
//
// Peça deliberadamente isolada e sem dependência de banco, rede ou API: é o
// ponto de troca se um dia a classificação passar a usar LLM. Trocar este
// arquivo (mantendo `interpretarResposta`) não mexe em mais nada do sistema.
//
// IMPORTANTE: usar LLM aqui significa mandar texto escrito por menor de idade
// para uma API externa. Isso é decisão da diretoria, do mesmo tipo que a de usar
// o OpenWA — não trocar por conta própria.
//
// A saída nunca é gravada como fato: vira `contatos.motivo_sugerido`, que a
// coordenação confirma na /risco. Por isso a regra de ouro aqui é **não chutar**:
// na dúvida, `nao_entendido` (a coordenação escolhe) é sempre melhor que um
// palpite errado (que ela pode confirmar sem perceber).

const { MOTIVOS } = require('../config/motivos');

// Dicionário de palavras-chave por motivo. Ponto de partida — a ideia é afinar
// com o que a tabela `respostas_whatsapp` for registrando: ela guarda o texto e
// a interpretação, então dá pra ver o que está caindo em "nao_entendido".
//
// Os termos são comparados sem acento e sem caixa, e só casam como palavra
// inteira (ver `contarTermos`) — senão "passe" casaria dentro de "passear".
// Termos de duas palavras funcionam normalmente.
//
// Um termo pode vir como `['palavra', peso]`. Peso < 1 é para palavra genérica,
// que aparece em frase de vários assuntos: "não tenho dinheiro pra passagem" é
// problema de transporte (a escola resolve com passe), não de "financeiro" no
// sentido de mensalidade — "dinheiro" sozinho não pode empatar com "passagem".
const TERMOS = {
    transporte: ['onibus', 'busao', 'buzu', 'passagem', 'passagens', 'carona', 'transporte', 'conducao', 'bilhete', 'van', 'longe demais', 'sem carona'],
    trabalho: ['trabalho', 'trabalhando', 'trampo', 'trampando', 'servico', 'emprego', 'empregado', 'estagio', 'turno', 'expediente', 'patrao', 'hora extra', 'comecei a trabalhar'],
    saude_atestado: ['atestado', 'atestados'],
    saude_sem_atestado: ['doente', 'doenca', 'medico', 'medica', 'consulta', 'exame', 'exames', 'hospital', 'cirurgia', 'gripe', 'febre', 'dor', 'internado', 'remedio', 'sem atestado', 'nao peguei atestado', 'nao tenho atestado'],
    saude_mental: ['ansiedade', 'ansioso', 'ansiosa', 'depressao', 'deprimido', 'deprimida', 'panico', 'crise', 'psicologo', 'psicologa', 'psiquiatra', 'burnout', 'saude mental', 'esgotado', 'esgotada'],
    financeiro: [['dinheiro', 0.5], ['grana', 0.5], 'financeiro', 'sem condicoes', 'sem condicao', 'desempregado', 'desempregada', ['conta', 0.5], ['contas', 0.5], ['caro', 0.5], 'nao tenho como pagar'],
    desmotivacao_curso: ['desisti', 'desistir', 'nao gosto', 'nao gostei', 'desanimado', 'desanimada', 'desanimo', 'nao e o que eu queria', 'nao era o que eu queria', 'perdi o interesse', 'trocar de curso', 'nao quero mais'],
    problema_familiar: ['familia', 'familiar', 'minha mae', 'meu pai', 'meu filho', 'minha filha', 'em casa', 'falecimento', 'faleceu', 'luto', 'cuidar', 'irmao', 'irma', 'avo']
};

// Sem acento, sem caixa, espaços colapsados — a forma em que tudo é comparado.
function normalizar(texto) {
    return String(texto ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// Só "sair" sozinho desinscreve. Uma frase como "não quero sair do curso" contém
// a palavra e significa o contrário — tirar esse aluno dos envios seria
// exatamente o erro mais caro que este arquivo pode cometer.
function ehPedidoDeSaida(normalizado) {
    return /^sair[.!]?$/.test(normalizado);
}

// Aceita "2", "2.", "opção 2", "numero 2" — mas não "20" nem "2 porque...".
// Fora do intervalo do menu não é escolha de menu: é um número qualquer que o
// aluno digitou, e quem decide o que fazer com ele é o dicionário.
function numeroDoMenu(normalizado) {
    const casou = normalizado.match(/^(?:opcao|opção|numero|n|item)?\s*(\d{1,2})[.!)]?$/);
    if (!casou) return null;
    const numero = Number(casou[1]);
    return numero >= 1 && numero <= MOTIVOS.length ? numero : null;
}

function contarTermos(normalizado, termos) {
    return termos.reduce((total, entrada) => {
        const [termo, peso] = Array.isArray(entrada) ? entrada : [entrada, 1];
        // \b não funciona em volta de acento, mas `normalizado` e `termo` já
        // vieram sem acento — aqui só sobram letras simples, dígitos e espaço.
        const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return total + (new RegExp(`(^|\\s)${escapado}($|\\s|[.,!?;])`).test(normalizado) ? peso : 0);
    }, 0);
}

// Devolve { tipo, motivo? }:
//   sair           — pediu para não receber mais mensagens
//   menu           — digitou o número de uma opção (motivo = a chave dela)
//   palavras_chave — o texto livre bateu com um motivo (motivo = a chave)
//   nao_entendido  — respondeu, mas não dá pra dizer o motivo
function interpretarResposta(texto) {
    const normalizado = normalizar(texto);
    if (!normalizado) return { tipo: 'nao_entendido' };

    if (ehPedidoDeSaida(normalizado)) return { tipo: 'sair' };

    const numero = numeroDoMenu(normalizado);
    if (numero) return { tipo: 'menu', motivo: MOTIVOS[numero - 1].chave };

    // "outro" nunca é deduzido de texto livre: ele significa "nenhum dos
    // anteriores", coisa que só o aluno escolhendo no menu pode dizer.
    const placar = Object.entries(TERMOS)
        .map(([motivo, termos]) => ({ motivo, pontos: contarTermos(normalizado, termos) }))
        .filter((item) => item.pontos > 0)
        .sort((a, b) => b.pontos - a.pontos);

    // Os dois motivos de saúde compartilham o assunto de propósito ("fui ao
    // médico e peguei atestado" pontua nos dois), então eles não podem se
    // anular no critério de empate abaixo — sem isso, toda frase sobre saúde
    // com atestado cairia em "nao_entendido". Quem tiver mais pontos vence, e o
    // outro sai do placar; "sem atestado" está na lista do sem_atestado
    // justamente pra ganhar de "atestado" nessa disputa.
    const saude = placar.filter((item) => item.motivo.startsWith('saude_'));
    if (saude.length === 2) {
        const perdedor = saude[0].pontos >= saude[1].pontos ? saude[1] : saude[0];
        placar.splice(placar.indexOf(perdedor), 1);
    }

    if (placar.length === 0) return { tipo: 'nao_entendido' };
    // Empate no topo = a frase fala de dois assuntos ("fiquei doente e perdi o
    // trampo"). Escolher um dos dois seria sorteio; a coordenação decide.
    if (placar.length > 1 && placar[0].pontos === placar[1].pontos) return { tipo: 'nao_entendido' };

    return { tipo: 'palavras_chave', motivo: placar[0].motivo };
}

module.exports = { interpretarResposta, normalizar, TERMOS };
