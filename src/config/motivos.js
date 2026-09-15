// Motivos de falta — as mesmas chaves gravadas em `contatos.motivo` pela tela
// /risco. A ORDEM importa: é o número que o aluno digita no menu do WhatsApp
// (1 = transporte, 2 = trabalho...). Acrescentar motivo novo só no FIM da lista,
// senão uma resposta "3" de uma conversa em andamento passaria a significar outra
// coisa.
//
// `rotulo` é o texto da coordenação (igual ao <select> de risco.ejs e painel.ejs);
// `rotuloAluno` é como aparece no menu enviado ao aluno — linguagem mais simples.
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
