const jwt = require('jsonwebtoken');

// Protege as rotas do dashboard (dados de alunos) — exige token emitido por /auth/login
function autenticar(req, res, next) {
    const cabecalho = req.headers.authorization || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

    if (!token) {
        return res.status(401).json({ status: 'erro', mensagem: 'Token não informado' });
    }

    try {
        req.usuario = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (erro) {
        return res.status(401).json({ status: 'erro', mensagem: 'Token inválido ou expirado' });
    }
}

// Restringe a rota a usuários com admin = true no token (gestão de usuários) —
// use sempre depois de autenticar, que é quem popula req.usuario
function exigirAdmin(req, res, next) {
    if (!req.usuario || !req.usuario.admin) {
        return res.status(403).json({ status: 'erro', mensagem: 'Acesso restrito ao administrador' });
    }
    next();
}

module.exports = { autenticar, exigirAdmin };
