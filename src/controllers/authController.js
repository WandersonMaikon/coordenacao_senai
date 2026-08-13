const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

async function login(req, res) {
    const { usuario, senha } = req.body;

    if (!usuario || !senha) {
        return res.status(400).json({ status: 'erro', mensagem: 'Informe usuário e senha' });
    }

    const usuarioEncontrado = await prisma.usuario.findUnique({ where: { usuario } });
    const senhaValida = usuarioEncontrado && await bcrypt.compare(senha, usuarioEncontrado.senhaHash);

    if (!usuarioEncontrado || !senhaValida) {
        return res.status(401).json({ status: 'erro', mensagem: 'Usuário ou senha inválidos' });
    }

    const token = jwt.sign({ usuario: usuarioEncontrado.usuario }, process.env.JWT_SECRET, { expiresIn: '12h' });
    return res.json({ status: 'ok', token });
}

module.exports = { login };