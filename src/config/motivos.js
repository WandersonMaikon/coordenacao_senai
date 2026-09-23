// Motivos de falta — as mesmas chaves gravadas em `contatos.motivo` pela tela
// /risco, e o alvo da classificação da resposta do aluno
// (src/services/classificarResposta.js).
//
// A ORDEM ainda importa, mas menos do que antes: o menu numerado saiu da
// mensagem de WhatsApp (ocupava o dobro do texto e afastava mais aluno do que
// ajudava). O classificador continua aceitando um número solto, porque quem
// recebeu a mensagem antiga pode responder "3" dias depois — então acrescentar
// motivo novo só no FIM da lista continua sendo a regra segura enquanto houver
// conversa em andamento.
//
// `rotulo` é o texto da coordenação (igual ao <select> de risco.ejs e painel.ejs);
// `rotuloAluno` é a versão em linguagem simples, usada quando o motivo precisa
// ser mostrado ao próprio aluno.
const MOTIVOS = [
    { chave: 'transporte', rotulo: 'Transporte', rotuloAluno: 'Transporte' },
    { chave: 'trabalho', rotulo: 'Trabalho', rotuloAluno: 'Trabalho' },
    { chave: 'saude_atestado', rotulo: 'Saúde - com atestado', rotuloAluno: 'Saúde (tenho atestado)' },
    { chave: 'saude_sem_atestado', rotulo: 'Saúde - sem atestado', rotuloAluno: 'Saúde (sem atestado)' },
    { chave: 'saude_mental', rotulo: 'Saúde mental', rotuloAluno: 'Saúde emocional' },
    { chave: 'financeiro', rotulo: 'Financeiro', rotuloAluno: 'Dificuldade financeira' },
    { chave: 'desmotivacao_curso', rotulo: 'Desmotivação com o curso', rotuloAluno: 'Desânimo com o curso' },
    { chave: 'problema_familiar', rotulo: 'Problema familiar', rotuloAluno: 'Problema familiar' },
    { chave: 'outro', rotulo: 'Outro / não informado', rotuloAluno: 'Outro motivo' }
];

module.exports = { MOTIVOS };
