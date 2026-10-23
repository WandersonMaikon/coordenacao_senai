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
//
// Confirma ANTES de processar: a interpretação pela IA local pode levar alguns
// segundos (dezenas, se o modelo estiver carregando), e o gateway reenvia evento
// que demora a ser confirmado. A reentrega não duplica nada (messageId único em
// respostas_whatsapp), mas confirmar na hora evita a fila de repetição.
router.post('/webhook/whatsapp', validarWebhookWhatsapp, (req, res) => {
    res.json({ status: 'ok' });
    whatsappResposta.processarEvento(req.body)
        // Log sem o texto do aluno — são dados de menores; pra depurar basta o id.
        .then((resultado) => console.log('[whatsapp] evento recebido:', JSON.stringify(resultado)))
        .catch((erro) => console.error('[whatsapp] falha ao processar evento do webhook:', erro.message));
});

module.exports = router;
