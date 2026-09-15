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

// Endereço do WhatsApp de um celular brasileiro, pra quando não dá pra perguntar
// ao WhatsApp qual é (a verificação do OpenWA falhou). Contas de DDD 31 em diante
// são registradas SEM o 9º dígito (o WhatsApp manteve o formato antigo quando o 9
// foi adicionado) — ex: (69) 99230-6863 é 556992306863@c.us. DDDs 11 a 28 mantêm
// o 9. É a regra que o próprio WhatsApp Web usa, mas pode haver exceção; por isso
// só é usada quando a verificação oficial não está disponível.
function chatIdBrasil(telefone) {
    let digitos = normalizarTelefone(telefone);
    const ddd = Number(digitos.slice(0, 2));
    if (digitos.length === 11 && digitos[2] === '9' && ddd >= 31) {
        digitos = digitos.slice(0, 2) + digitos.slice(3);
    }
    return `55${digitos}@c.us`;
}

module.exports = { normalizarTelefone, mesmoTelefone, chatIdBrasil };
