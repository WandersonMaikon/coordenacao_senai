// Aceita "(69) 99340-8643", "+55 69 99340-8643" etc. e devolve só os dígitos sem o
// 55 — mesmo formato do telefone dos alunos.
function normalizarTelefone(valor) {
    let digitos = String(valor || '').replace(/\D/g, '');
    if (digitos.length >= 12 && digitos.startsWith('55')) digitos = digitos.slice(2);
    return digitos;
}

// Compara dois números pelo DDD + últimos 8 dígitos. O WhatsApp identifica alguns
// celulares antigos sem o 9º dígito (556992306863), então comparar o número
// inteiro daria "diferente" pro mesmo celular.
function mesmoTelefone(a, b) {
    const x = normalizarTelefone(a);
    const y = normalizarTelefone(b);
    if (!x || !y) return false;
    return x.slice(0, 2) === y.slice(0, 2) && x.slice(-8) === y.slice(-8);
}

module.exports = { normalizarTelefone, mesmoTelefone };
