const express = require('express');
const { validarWebhookWhatsapp } = require('../middlewares/webhookWhatsapp');
const whatsappResposta = require('../services/whatsappResposta');

const router = express.Router();

// Recebe os eventos do OpenWA (resposta do aluno e confirmação de entrega).
// Sem `autenticar`: quem chama é o container openwa_retencao pela rede interna,
// não um usuário do painel. A proteção é o middleware acima.
//
// Responde 200 mesmo quando o evento é ignorado ou não entendido: webhook que
// devolve erro vira fila de reentrega no gateway, e reentregar um evento que
// nunca vai ser tratado só gera ruído.
router.post('/webhook/whatsapp', validarWebhookWhatsapp, async (req, res) => {
    try {
        const resultado = await whatsappResposta.processarEvento(req.body);
        // Log sem o texto do aluno — são dados de menores; pra depurar basta o id.
        console.log('[whatsapp] evento recebido:', JSON.stringify(resultado));
        res.json({ status: 'ok', ...resultado });
    } catch (erro) {
        // Erro nosso não vira reentrega: registra e confirma, senão o gateway
        // repete o mesmo evento quebrado para sempre.
        console.error('[whatsapp] falha ao processar evento do webhook:', erro.message);
        res.json({ status: 'ok', erro: 'falha ao processar' });
    }
});

module.exports = router;
