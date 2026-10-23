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
// Um termo terminado em `*` casa por radical: 'trabalh*' cobre trabalho,
// trabalhar, trabalhando, trabalhei, trabalhava. Isso existe porque a falha mais
// comum não era erro de ortografia, era **conjugação**: a lista tinha "trabalho"
// e "trabalhando", e "tenho que trabalhar" não casava com nada.
// Onde entra um radical, as palavras que ele cobre saem da lista — senão a mesma
// frase pontuaria duas vezes e desequilibraria o placar contra os outros motivos.
//
// Peso > 1 é o contrário: assunto que deve ganhar quando divide a frase com
// outro. Familiar (`PESO_FORTE`) ganha de doença: em "minha mãe tá internada" e
// "meu irmão tá doente" quem está doente é outra pessoa, e o motivo da falta é o
// aluno estar cuidando dela — sem o peso, empatava com saúde e virava
// "nao_entendido". Saúde mental tem o mesmo peso para não perder para familiar:
// "minha mãe acha que eu tô com depressão" empata e vai para uma pessoa ler, em
// vez de esconder um assunto delicado debaixo de "problema familiar".
const PESO_FORTE = 1.5;
const TERMOS = {
    transporte: ['onibus', 'busao', 'buzu', 'passage*', 'carona', 'transporte', 'conducao', 'bilhete', 'van', ['longe', 0.5], 'sem carona'],
    trabalho: ['trabalh*', 'tramp*', 'servico', 'empreg*', 'estagio', 'turno', 'expediente', 'patrao', 'hora extra'],
    saude_atestado: ['atestado', 'atestados'],
    saude_sem_atestado: ['doen*', 'medic*', 'consulta', 'exame*', 'hospital', 'cirurgia', 'gripe', 'febre', 'dor', 'internad*', 'remedio', 'sem atestado', 'nao peguei atestado', 'nao tenho atestado'],
    saude_mental: [['ansied*', PESO_FORTE], ['ansios*', PESO_FORTE], ['depress*', PESO_FORTE], ['deprimid*', PESO_FORTE], ['panico', PESO_FORTE], 'crise', ['psicolog*', PESO_FORTE], ['psiquiatra', PESO_FORTE], ['burnout', PESO_FORTE], ['saude mental', PESO_FORTE], 'esgotad*'],
    financeiro: [['dinheiro', 0.5], ['grana', 0.5], 'financeiro', 'sem condic*', 'desempregad*', ['contas', 0.5], ['caro', 0.5], 'nao tenho como pagar'],
    desmotivacao_curso: ['desist*', 'nao gost*', 'desanim*', 'nao e o que eu queria', 'nao era o que eu queria', 'perdi o interesse', 'trocar de curso', 'nao quero mais'],
    problema_familiar: ['famili*', ['minha mae', PESO_FORTE], ['meu pai', PESO_FORTE], ['meu filho', PESO_FORTE], ['minha filha', PESO_FORTE], 'em casa', 'falec*', 'luto', 'cuidar', ['irmao', PESO_FORTE], ['irma', PESO_FORTE], ['avo', PESO_FORTE]]
};

// Abreviação de celular → palavra inteira. O aluno escreve "n gosto", "mto
// longe", "tenho q trabalhar" — e nenhuma dessas casava com termo nenhum.
// Aplicado só na fase do dicionário: se fosse dentro de `normalizar`, o "n" de
// "n 2" viraria "nao 2" e a escolha do menu se perderia.
const ABREVIACOES = {
    q: 'que', qnd: 'quando', qdo: 'quando', pq: 'porque',
    vc: 'voce', vcs: 'voces', cmg: 'comigo',
    tb: 'tambem', tbm: 'tambem', msm: 'mesmo',
    mt: 'muito', mto: 'muito', mta: 'muita',
    n: 'nao', naum: 'nao', nunk: 'nunca',
    to: 'estou', ta: 'esta', tava: 'estava', tow: 'estou',
    hj: 'hoje', agr: 'agora', dps: 'depois', blz: 'beleza',
    trab: 'trabalho', fds: 'fim de semana', pfv: 'favor', pfvr: 'favor'
};

// Uma troca de letra vale menos que a palavra escrita certa: assim um acerto
// exato sempre ganha de um aproximado, e dois aproximados empatados continuam
// caindo em `nao_entendido` em vez de virar chute.
const PESO_APROXIMADO = 0.75;

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

// Texto pronto para o dicionário: letra repetida ("naaao") colapsada e
// abreviação expandida. Separado de `normalizar` de propósito — ver ABREVIACOES.
function canonizar(normalizado) {
    return normalizado
        // 3+ letras iguais viram uma. Nenhuma palavra do português tem isso, e é
        // como se escreve ênfase no WhatsApp ("naaao", "muitooo", "socorrooo").
        .replace(/(.)\1{2,}/g, '$1')
        .split(' ')
        .map((palavra) => ABREVIACOES[palavra] || palavra)
        .join(' ');
}

// Distância de Levenshtein — quantas letras precisam mudar para uma virar a
// outra. Usada só para aceitar erro de digitação, nunca para aproximar palavras
// diferentes (ver `tolerancia`).
function distancia(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 99;
    let linha = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = linha[0];
        linha[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const guardado = linha[j];
            linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = guardado;
        }
    }
    return linha[b.length];
}

// Quanto erro de digitação aceitar, por tamanho do termo. Palavra curta não
// aceita nenhum: em "van", "dor", "irma" e "avo" uma letra trocada já é outra
// palavra — "dor"/"dou", "avo"/"ano" —, e aí o aproximado viraria chute.
function tolerancia(termo) {
    if (termo.length < 5) return 0;
    if (termo.length < 8) return 1;
    return 2;
}

function contarTermos(frase, termos) {
    const palavras = frase.split(' ').filter(Boolean);

    return termos.reduce((total, entrada) => {
        const [bruto, peso] = Array.isArray(entrada) ? entrada : [entrada, 1];
        const ehRadical = bruto.endsWith('*');
        const termo = ehRadical ? bruto.slice(0, -1) : bruto;

        // Termo de duas ou mais palavras continua casando na frase inteira, e só
        // exato: aproximar frase multiplicaria as chances de erro.
        if (termo.includes(' ')) {
            // \b não funciona em volta de acento, mas `texto` e `termo` já vieram
            // sem acento — aqui só sobram letras simples, dígitos e espaço.
            const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const fim = ehRadical ? '' : '($|\\s|[.,!?;])';
            return total + (new RegExp(`(^|\\s)${escapado}${fim}`).test(frase) ? peso : 0);
        }

        const exato = palavras.some((palavra) => (ehRadical ? palavra.startsWith(termo) : palavra === termo));
        if (exato) return total + peso;

        // Termo de peso reduzido não aceita aproximação. Peso < 1 marca a palavra
        // genérica ("dinheiro", "contas", "caro"), que já entra na conta com
        // ressalva — deixar ela casar por semelhança traz de volta exatamente o
        // que o peso queria evitar: "dou conta" (= dou conselho de mim mesmo)
        // chegava a uma letra de "contas" e virava problema financeiro.
        const limite = peso < 1 ? 0 : tolerancia(termo);
        if (limite === 0) return total;

        // No radical, compara só o pedaço do tamanho dele: "ansiedadi" vira
        // "ansiedad" contra "ansied".
        //
        // A primeira letra tem que bater. Quem erra digitação erra o miolo da
        // palavra, não a inicial — e sem essa trava "meu estado é rondônia"
        // virava "atestado" (duas letras de distância) e a coordenação recebia
        // uma sugestão de motivo tirada do nada.
        const aproximou = palavras.some((palavra) => {
            if (palavra[0] !== termo[0]) return false;
            return distancia(ehRadical ? palavra.slice(0, termo.length) : palavra, termo) <= limite;
        });
        return total + (aproximou ? peso * PESO_APROXIMADO : 0);
    }, 0);
}

// ───────────── Promessa de voltar ─────────────
//
// O único tipo de resposta que o robô resolve sozinho (ver "O funil automático"
// em docs/visao/VISAO.md): o aluno diz que vem na próxima aula, o sistema
// responde "combinado" e quem confere é a chamada seguinte. Por isso o erro aqui
// é barato — promessa reconhecida à toa se corrige sozinha quando ele falta de
// novo e cai pra coordenação. O erro caro é o contrário: dúvida ou recusa lida
// como promessa. Daí a negação ser conferida antes de tudo.

// "não vou", "nem vou dar", "acho que não", "talvez", "não sei se volto".
const NEGACAO = /\b(nao|nem|nunca)\b(\s+\S+){0,3}\s+(vou|volto|voltar|irei|consigo|consegui|da|dar|posso|estarei|vai)\b|\bacho que nao\b|\btalvez\b|\bnao sei\b|\bnao tenho como\b|\bnao vai dar\b|\bnao da\b/;

// Resposta curta à pergunta fechada da mensagem ("Você consegue vir na próxima
// aula? Responda SIM").
const SIM_CURTO = /^(sim|s|ss|sim sim|claro|com certeza|certeza|pode deixar|consigo|vou|vou sim|sim vou|sim consigo|ok|okay|beleza|certo|esta bem|esta bom|combinado|pode ser|positivo)( senhora?| professora?| prof)?[ !.]*$/;

// "estarei"/"vou estar" só valem com lugar ("estarei aí", "vou estar na aula"):
// soltos, casavam com "estarei saindo do curso" — visto em 22/10/2026, o robô
// respondeu "Combinado! Te esperamos" pra quem avisou que ia desistir.
const VERBO_VOLTAR = /\b(volto|voltarei|vou voltar|irei|vou ir|vou sim|vou la|vou na aula|apareco|vou aparecer|compareco|vou comparecer|estou indo|pretendo voltar|pretendo ir|(estarei|vou estar) (ai|la|na aula|presente))\b/;

// Desistência ganha de qualquer coisa: é o caso mais urgente para uma pessoa, e
// a frase pode ter palavras de promessa ("estarei saindo", "vou parar").
// "não quero sair do curso" é o contrário — por isso o "nao" antes de sair/
// desistir/parar anula.
const DESISTENCIA = /\b(saindo do curso|sair do curso|largar o curso|largando o curso|desist\w*|trancar|trancando|tranquei|cancelar (a |minha )?matricula|abandon\w*|parar o curso|parar de estudar|parei o curso|nao vou (mais )?continuar|nao vou mais (vir|voltar|fazer)|nao quero mais (o curso|estudar|fazer o curso|vir))\b/;
const NAO_DESISTE = /\bnao (quero|vou|pretendo|penso em) (sair|desistir|largar|parar|trancar|abandonar)\b/;

function ehDesistencia(frase) {
    return DESISTENCIA.test(frase) && !NAO_DESISTE.test(frase);
}
const QUANDO = /\b(amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|proxima aula|semana que vem|depois de amanha)\b/;

// Motivos que, mesmo com promessa, vão para uma pessoa: o robô não responde
// "combinado!" para quem contou que a mãe faleceu ou que está em crise.
const MOTIVOS_DELICADOS = ['saude_mental', 'problema_familiar'];

function ehPromessa(frase) {
    if (NEGACAO.test(frase)) return false;
    if (SIM_CURTO.test(frase)) return true;
    if (VERBO_VOLTAR.test(frase)) return true;
    return /\bvou\b/.test(frase) && QUANDO.test(frase);
}

// Devolve { tipo, motivo? }:
//   sair           — pediu para não receber mais mensagens
//   menu           — digitou o número de uma opção (motivo = a chave dela)
//   desistencia    — disse que vai sair do curso (motivo, se também contou um)
//   promessa       — disse que vem na próxima aula (motivo, se também contou um)
//   palavras_chave — o texto livre bateu com um motivo (motivo = a chave)
//   nao_entendido  — respondeu, mas não dá pra dizer o motivo
function interpretarResposta(texto) {
    const normalizado = normalizar(texto);
    if (!normalizado) return { tipo: 'nao_entendido' };

    if (ehPedidoDeSaida(normalizado)) return { tipo: 'sair' };

    const numero = numeroDoMenu(normalizado);
    if (numero) return { tipo: 'menu', motivo: MOTIVOS[numero - 1].chave };

    // Só daqui pra baixo o texto é canonizado: o menu numérico e o SAIR acima
    // precisam do texto como o aluno escreveu.
    const frase = canonizar(normalizado);

    // "outro" nunca é deduzido de texto livre: ele significa "nenhum dos
    // anteriores", coisa que só o aluno escolhendo no menu pode dizer.
    const placar = Object.entries(TERMOS)
        .map(([motivo, termos]) => ({ motivo, pontos: contarTermos(frase, termos) }))
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

    // Empate no topo = a frase fala de dois assuntos ("fiquei doente e perdi o
    // trampo"). Escolher um dos dois seria sorteio; a coordenação decide.
    const empate = placar.length > 1 && placar[0].pontos === placar[1].pontos;
    const motivo = placar.length > 0 && !empate ? placar[0].motivo : null;

    if (ehDesistencia(frase)) {
        return motivo ? { tipo: 'desistencia', motivo } : { tipo: 'desistencia' };
    }

    // Promessa com assunto delicado (ou com dois assuntos empatados, um deles
    // talvez delicado) segue o caminho normal: uma pessoa lê.
    const delicado = placar.some((item) => MOTIVOS_DELICADOS.includes(item.motivo));
    if (ehPromessa(frase) && !delicado && !empate) {
        return motivo ? { tipo: 'promessa', motivo } : { tipo: 'promessa' };
    }

    if (!motivo) return { tipo: 'nao_entendido' };
    return { tipo: 'palavras_chave', motivo };
}

// Tira da resposta o trecho que é a NOSSA mensagem citada. Muito aluno responde
// com "responder" ou copiando tudo, e a mensagem do robô vem junto — com
// "Sentimos sua falta nas últimas 5 aulas", "Responda SIM", "SAIR"... Sem isso o
// classificador lia o nosso texto como se fosse do aluno. Compara linha a linha,
// sem acento/caixa; se sobrar nada, devolve o texto como veio.
function removerMensagemCitada(texto, mensagemEnviada) {
    if (!texto || !mensagemEnviada) return texto;
    const nossas = new Set(String(mensagemEnviada).split(/\r?\n/).map(normalizar).filter(Boolean));
    const proprias = String(texto).split(/\r?\n/).filter((linha) => {
        const n = normalizar(linha.replace(/^\s*>+\s?/, ''));
        return n && !nossas.has(n);
    });
    const limpo = proprias.join('\n').trim();
    return limpo || texto;
}

// Usado como trava sobre a IA local (iaLocal.js): mesmo que o modelo diga
// "promessa", negação ou dúvida no texto impede o "Combinado!".
function temNegacaoOuDuvida(texto) {
    return NEGACAO.test(canonizar(normalizar(texto)));
}

module.exports = { interpretarResposta, normalizar, removerMensagemCitada, temNegacaoOuDuvida, TERMOS, MOTIVOS_DELICADOS };
