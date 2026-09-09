const express = require('express');
const path = require('path');

const router = express.Router();

// O userscript é servido direto do arquivo versionado no repositório — o deploy
// publica a versão nova junto com o resto, sem cópia separada pra esquecer de
// atualizar. O Tampermonkey de cada professor consulta essa URL sozinho
// (@updateURL no cabeçalho do script) e atualiza quando a @version sobe.
const CAMINHO_USERSCRIPT = path.join(__dirname, '../../tampermonkey/sge-captura.user.js');

// Público: o Tampermonkey busca essa URL em background, sem token — mesmo
// motivo do /webhook/frequencia. O conteúdo não é sigiloso (é o script que roda
// no navegador do professor), mas repare que ele não carrega segredo nenhum:
// o nome do professor fica no Tampermonkey de cada máquina, não no arquivo.
router.get('/sge-captura.user.js', (req, res) => {
    // no-store é obrigatório aqui: o backend fica atrás de um túnel Cloudflare,
    // que cacheia .js na borda por padrão. Sem isso, os professores continuariam
    // recebendo a versão antiga por horas depois do deploy.
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.type('text/javascript; charset=utf-8');
    res.sendFile(CAMINHO_USERSCRIPT, (erro) => {
        if (erro && !res.headersSent) {
            res.status(500).type('text/plain').send('Não foi possível ler o userscript.');
        }
    });
});

module.exports = router;
