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

module.exports = { autenticar };
