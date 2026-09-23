// Protege POST /webhook/whatsapp. Quem chama é o container openwa_retencao, não
// um usuário logado, então não dá pra usar o `autenticar` (JWT).
//
// A doc do OpenWA menciona assinatura HMAC no webhook, mas não fixa o nome do
// header nem o algoritmo. Em vez de apostar num formato só, aceitamos os dois
// caminhos plausíveis: assinatura HMAC-SHA256 do corpo cru, ou o segredo
// compartilhado em header. Quando um evento real confirmar o formato, dá pra
// apertar isto para um caso só — os nomes candidatos estão nas listas abaixo.
//
// A superfície de exposição já é pequena: openwa alcança o backend pela rede
// interna do compose (retencao_net) e o backend não publica porta. O segredo
// protege contra chamada vinda de fora pelo tunnel Cloudflare.

const crypto = require('crypto');

const HEADERS_ASSINATURA = ['x-webhook-signature', 'x-signature', 'x-hub-signature-256', 'x-openwa-signature'];
const HEADERS_SEGREDO = ['x-webhook-secret', 'x-webhook-token', 'x-api-key'];

// Comparação em tempo constante: comparar segredo com === vaza o tamanho do
// prefixo correto pelo tempo de resposta.
function iguaisEmTempoConstante(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length || x.length === 0) return false;
    return crypto.timingSafeEqual(x, y);
}

function primeiroHeader(req, nomes) {
    for (const nome of nomes) {
        const valor = req.headers[nome];
        if (valor) return String(valor);
    }
    return null;
}

function validarWebhookWhatsapp(req, res, next) {
    const segredo = process.env.OPENWA_WEBHOOK_SECRET;
    // Sem segredo configurado a rota fica fechada, não aberta: um webhook público
    // sem proteção aceitaria qualquer um escrevendo no histórico dos alunos.
    if (!segredo) {
        return res.status(503).json({ status: 'erro', mensagem: 'Webhook do WhatsApp não configurado no servidor (OPENWA_WEBHOOK_SECRET).' });
    }

    const assinatura = primeiroHeader(req, HEADERS_ASSINATURA);
    if (assinatura) {
        // O HMAC é sobre os bytes exatos recebidos — depois do JSON.parse não dá
        // mais pra reconstruir o corpo byte a byte (espaços, ordem das chaves).
        // `req.corpoCru` é preenchido pelo `verify` do express.json no server.js.
        if (!req.corpoCru) {
            return res.status(400).json({ status: 'erro', mensagem: 'Corpo cru indisponível para validar a assinatura' });
        }
        const esperado = crypto.createHmac('sha256', segredo).update(req.corpoCru).digest('hex');
        const recebido = assinatura.replace(/^sha256=/i, '').trim();
        if (!iguaisEmTempoConstante(esperado, recebido)) {
            return res.status(401).json({ status: 'erro', mensagem: 'Assinatura inválida' });
        }
        return next();
    }

    const enviado = primeiroHeader(req, HEADERS_SEGREDO);
    if (enviado && iguaisEmTempoConstante(segredo, enviado)) return next();

    return res.status(401).json({ status: 'erro', mensagem: 'Webhook não autorizado' });
}

module.exports = { validarWebhookWhatsapp };
