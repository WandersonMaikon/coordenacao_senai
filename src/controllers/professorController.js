const { listarProfessores, registrarSinal, corrigirNomeProfessor } = require('../services/professores');

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

// POST /professores/corrigir-nome { de, nomeCorreto } — troca o nome em todos os
// lançamentos daquele card (src/services/professores.js). Qualquer usuário
// logado, mesma regra de encerrar turma.
async function corrigirNome(req, res) {
    try {
        const resultado = await corrigirNomeProfessor(req.body?.de, req.body?.nomeCorreto, req.usuario.usuario);
        console.log(`[Professores] Nome corrigido por ${req.usuario.usuario}: ${resultado.lancamentos} lançamento(s)`);
        return res.json({ status: 'ok', ...resultado });
    } catch (erro) {
        if (erro.status) return res.status(erro.status).json({ status: 'erro', mensagem: erro.message });
        console.error('[Professores] Erro ao corrigir nome:', erro);
        return res.status(500).json({ status: 'erro', mensagem: 'Erro ao corrigir o nome' });
    }
}

module.exports = { listar, receberSinal, corrigirNome };
