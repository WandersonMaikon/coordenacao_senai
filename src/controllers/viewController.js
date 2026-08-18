function paginaLogin(req, res) {
    res.render('auth/login');
}

function paginaPainel(req, res) {
    res.render('painel');
}

function paginaFaltas(req, res) {
    res.render('faltas');
}

function paginaRisco(req, res) {
    res.render('risco');
}

function paginaImportarTelefones(req, res) {
    res.render('importar-telefones');
}

module.exports = { paginaLogin, paginaPainel, paginaFaltas, paginaRisco, paginaImportarTelefones };