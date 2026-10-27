const { listarProfessores, registrarSinal, juntarProfessores, separarProfessor } = require('../services/professores');

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

// POST /professores/juntar { de, para } — "é a mesma pessoa". Qualquer usuário
// logado (mesma regra de encerrar turma): não apaga nada e dá para separar.
async function juntar(req, res) {
    try {
        await juntarProfessores(req.body?.de, req.body?.para, req.usuario.usuario);
        return res.json({ status: 'ok' });
    } catch (erro) {
        if (erro.status) return res.status(erro.status).json({ status: 'erro', mensagem: erro.message });
        console.error('[Professores] Erro ao juntar:', erro);
        return res.status(500).json({ status: 'erro', mensagem: 'Erro ao juntar os professores' });
    }
}

// DELETE /professores/juntar/:chave — separa o nome de volta no próprio card.
async function separar(req, res) {
    try {
        const separou = await separarProfessor(req.params.chave);
        if (!separou) return res.status(404).json({ status: 'erro', mensagem: 'Esse nome não está juntado a ninguém' });
        return res.json({ status: 'ok' });
    } catch (erro) {
        console.error('[Professores] Erro ao separar:', erro);
        return res.status(500).json({ status: 'erro', mensagem: 'Erro ao separar o professor' });
    }
}

module.exports = { listar, receberSinal, juntar, separar };
