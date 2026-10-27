const { listarProfessores, registrarSinal } = require('../services/professores');

// GET /professores/lista — tela /professores.
async function listar(req, res) {
    try {
        const dados = await listarProfessores();
        return res.json({ status: 'ok', ...dados });
    } catch (erro) {
        console.error('[Professores] Erro ao listar:', erro);
        return res.status(500).json({ status: 'erro', mensagem: 'Erro ao listar os professores' });
    }
}

// POST /webhook/sinal-script — público, chamado pelo userscript (sem token,
// mesmo motivo do /webhook/frequencia). Não carrega dado de aluno.
async function receberSinal(req, res) {
    try {
        const gravou = await registrarSinal(req.body, req.get('user-agent'));
        if (!gravou) return res.status(400).json({ status: 'erro', mensagem: 'Instalação inválida' });
        return res.json({ status: 'ok' });
    } catch (erro) {
        console.error('[Professores] Erro ao gravar sinal do script:', erro.message);
        return res.status(500).json({ status: 'erro', mensagem: 'Erro ao gravar o sinal' });
    }
}

module.exports = { listar, receberSinal };
