const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

// Lista os usuários com acesso ao painel (sem o hash da senha)
async function listar(req, res) {
    try {
        const usuarios = await prisma.usuario.findMany({
            select: { id: true, usuario: true, nome: true, criadoEm: true },
            orderBy: { nome: 'asc' }
        });
        res.json({ status: 'ok', dados: usuarios });
    } catch (erro) {
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

// Cadastra um novo usuário da coordenação com acesso ao painel
async function criar(req, res) {
    const { usuario, senha, nome } = req.body;

    if (!usuario || !senha) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe usuário e senha' });
    }

    if (senha.length < 6) {
        return res.status(400).json({ status: 'erro', mensagem: 'A senha precisa ter pelo menos 6 caracteres' });
    }

    try {
        const senhaHash = await bcrypt.hash(senha, 10);
        const novoUsuario = await prisma.usuario.create({
            data: { usuario, senhaHash, nome: nome || null },
            select: { id: true, usuario: true, nome: true, criadoEm: true }
        });
        res.json({ status: 'ok', dados: novoUsuario });
    } catch (erro) {
        if (erro.code === 'P2002') {
            return res.status(400).json({ status: 'erro', mensagem: 'Já existe um usuário com esse nome de login' });
        }
        res.status(500).json({ status: 'erro', mensagem: erro.message });
    }
}

module.exports = { listar, criar };
