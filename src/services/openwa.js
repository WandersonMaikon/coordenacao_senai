// Cliente do OpenWA (container openwa_retencao), o gateway não oficial de
// WhatsApp usado pra falar com os alunos. Só o backend conversa com ele: o
// container não tem porta publicada nem passa pelo tunnel Cloudflare.
//
// Referência da API: docs/06-api-specification.md do repositório
// rmyndharis/OpenWA. Autenticação por header X-API-Key (chave OPERATOR).

class ErroOpenWA extends Error {
    constructor(mensagem, { status = null, codigo = null, retryAfter = null } = {}) {
        super(mensagem);
        this.status = status;
        this.codigo = codigo;
        this.retryAfter = retryAfter;
        // 409/503/502/504 = sessão ainda não pronta ou reconectando; 500 = erro interno
        // do OpenWA/whatsapp-web.js (costuma ser o WhatsApp Web instável). Nos dois
        // casos o problema não é a mensagem: tentar de novo mais tarde, com a mesma.
        // 401/403 = chave errada, não adianta insistir.
        this.retentavel = [409, 429, 500, 502, 503, 504].includes(status) || status === null;
        this.fatal = [401, 403].includes(status);
    }
}

function configurado() {
    return Boolean(process.env.OPENWA_URL && process.env.OPENWA_API_KEY);
}

async function chamar(metodo, caminho, corpo) {
    if (!configurado()) {
        throw new ErroOpenWA('WhatsApp não configurado no servidor (OPENWA_URL/OPENWA_API_KEY).', { status: 503, codigo: 'NAO_CONFIGURADO' });
    }

    let resposta;
    try {
        resposta = await fetch(`${process.env.OPENWA_URL.replace(/\/$/, '')}${caminho}`, {
            method: metodo,
            headers: {
                'X-API-Key': process.env.OPENWA_API_KEY,
                ...(corpo ? { 'Content-Type': 'application/json' } : {})
            },
            body: corpo ? JSON.stringify(corpo) : undefined,
            signal: AbortSignal.timeout(30000)
        });
    } catch (erro) {
        // Container fora do ar, DNS da rede do compose, timeout.
        throw new ErroOpenWA(`Não foi possível falar com o OpenWA: ${erro.message}`);
    }

    if (resposta.status === 204) return null;

    const texto = await resposta.text();
    let dados = null;
    try {
        dados = texto ? JSON.parse(texto) : null;
    } catch {
        dados = { message: texto };
    }

    if (!resposta.ok) {
        const mensagem = Array.isArray(dados?.message) ? dados.message.join('; ') : (dados?.message || resposta.statusText);
        throw new ErroOpenWA(`OpenWA ${resposta.status}: ${mensagem}`, {
            status: resposta.status,
            codigo: dados?.code || null,
            retryAfter: Number(resposta.headers.get('retry-after')) || null
        });
    }
    return dados;
}

const criarSessao = (nome) => chamar('POST', '/sessions', { name: nome, config: { autoReconnect: true } });
const obterSessao = (sessionId) => chamar('GET', `/sessions/${encodeURIComponent(sessionId)}`);
const iniciarSessao = (sessionId) => chamar('POST', `/sessions/${encodeURIComponent(sessionId)}/start`);
const obterQr = (sessionId) => chamar('GET', `/sessions/${encodeURIComponent(sessionId)}/qr`);
const desconectarSessao = (sessionId) => chamar('POST', `/sessions/${encodeURIComponent(sessionId)}/logout`);
const apagarSessao = (sessionId) => chamar('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);

// `numero` só dígitos, já com o 55.
const verificarNumero = (sessionId, numero) =>
    chamar('GET', `/sessions/${encodeURIComponent(sessionId)}/contacts/check/${encodeURIComponent(numero)}`);

const enviarTexto = (sessionId, chatId, texto) =>
    chamar('POST', `/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, { chatId, text: texto });

// Webhook de entrada (etapa 4): é assim que a resposta do aluno chega até aqui.
// A URL registrada é a do backend na rede interna do compose
// (http://node_retencao:3000/webhook/whatsapp) — o tráfego não sai da máquina
// nem passa pelo tunnel Cloudflare.
const listarWebhooks = (sessionId) =>
    chamar('GET', `/sessions/${encodeURIComponent(sessionId)}/webhooks`);

const registrarWebhook = (sessionId, { url, eventos, segredo }) =>
    chamar('POST', `/sessions/${encodeURIComponent(sessionId)}/webhooks`, {
        url,
        events: eventos,
        ...(segredo ? { secret: segredo } : {})
    });

module.exports = {
    ErroOpenWA,
    configurado,
    criarSessao,
    obterSessao,
    iniciarSessao,
    obterQr,
    desconectarSessao,
    apagarSessao,
    verificarNumero,
    enviarTexto,
    listarWebhooks,
    registrarWebhook
};
