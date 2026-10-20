# Visão do projeto — Sistema de Retenção e Resgate de Alunos

SENAI Ji-Paraná/RO

## O problema

Aluno que evade raramente some de uma vez. Ele falta um dia, depois outro, e quando
alguém percebe já faz semanas que não aparece — e aí é tarde para trazer de volta.

A escola não tinha como enxergar isso a tempo:

- O SGE (TOTVS) não tem relatório de frequência consolidado por turma, e o suporte
  responde em meses.
- A informação existia, mas espalhada: cada professor lança a chamada da sua turma, e
  ninguém via o conjunto.
- Quando a coordenação ia atrás de um aluno, não ficava registrado quem ligou, o que
  ele respondeu nem por que estava faltando.

## O objetivo

Perceber o aluno que está começando a sumir **enquanto ainda dá para resgatar**, fazer
alguém falar com ele, e registrar o porquê — para que a escola deixe de saber só
*quantos* alunos faltam e passe a saber *por que* faltam.

## Para quem

- **Coordenação** — quem usa o painel no dia a dia: vê quem está em risco, entra em
  contato, registra o resultado e acompanha quem voltou.
- **Professores** — não usam o sistema diretamente. Lançam a chamada no SGE como sempre;
  o resto acontece sem mudar o trabalho deles.
- **Diretoria** — recebe os indicadores (em risco, recuperados, motivos das faltas) e
  decide sobre os pontos sensíveis, como o uso do WhatsApp e de serviços externos.
- **Alunos** (14 a 23 anos, muitos menores) — são o motivo do sistema e também os donos
  dos dados que ele guarda.

## Como funciona, em uma frase por etapa

1. **Captura.** Quando o professor salva a chamada no SGE, um script no navegador dele
   copia as faltas e manda para o sistema. Ele não precisa fazer nada a mais.
2. **Alerta.** Aluno com **2 dias de aula seguidos com falta**, sem nenhuma presença no
   meio, entra na lista de risco. Assim que tem uma presença, sai — o que importa é o
   abandono em curso, não o acumulado do semestre.
3. **Contato.** A coordenação liga, manda mensagem ou conversa pessoalmente, e registra
   o resultado e o motivo da falta. O sistema também pode enviar a primeira mensagem
   pelo WhatsApp, em ritmo controlado, e ler a resposta do aluno para sugerir o motivo —
   que uma pessoa confirma.
4. **Acompanhamento.** Aluno marcado como recuperado é observado pelos próximos 4 dias
   de aula. Se faltar de novo nesse período, a tela avisa.
5. **Indicadores.** O painel mostra matriculados, ativos, em risco, recuperados e o
   gráfico de motivos das faltas, por turma ou da escola inteira.

## Princípios

- **Não mudar a rotina do professor.** A captura acontece por baixo do fluxo que ele já
  tem. Se exigir trabalho extra, deixa de ser feita.
- **Dados de menores são sensíveis.** Nada de exposição pública, cuidado com exportação,
  nada de texto do aluno em log, e nenhum dado vai para serviço externo sem decisão da
  diretoria.
- **Pessoa decide, sistema sugere.** O motivo deduzido da resposta do WhatsApp é só uma
  sugestão até alguém confirmar. Encerrar turma e encerrar caso são sempre manuais. Na
  dúvida, o sistema não chuta.
- **Quem fecha o caso é a chamada.** O que o aluno diz pode adiar a ação humana, mas
  nunca encerra nada: se ele disse que volta, quem confirma é a próxima chamada do
  professor. Assim, quando o sistema entende errado, o caso só chega à coordenação uma
  aula depois, e nenhum aluno some do radar.
- **Simples de manter por uma pessoa.** O sistema é mantido por um professor, não por um
  time. Clareza vale mais que sofisticação.
- **Nada some sem rastro.** Encerrar turma ou caso não apaga lançamentos nem contatos; o
  histórico de quem fez o quê fica registrado.

## Onde estamos (outubro de 2026)

Já em uso:

- Captura automática da chamada, com o script se atualizando sozinho nas máquinas dos
  professores.
- Importação da planilha da secretaria (matrícula, nome, telefone, situação).
- Painel com risco, frequência, recuperados, telefones e o gráfico de motivos.
- Registro de contatos pela coordenação.
- Encerramento de turma e de caso, e acompanhamento dos recuperados.
- Envio de WhatsApp pelo OpenWA, com limites contra bloqueio de número, e leitura das
  respostas dos alunos.

Ainda em aberto:

- **Confirmar a volta do WhatsApp com uma resposta real.** A recepção foi construída a
  partir da documentação do OpenWA e só foi desbloqueada no fim de setembro; falta ver
  uma mensagem de aluno chegar e virar contato.
- **Melhorar a leitura das respostas** — abreviações, conjugações e erros de digitação
  comuns no WhatsApp. Em andamento.

## Próximo grande passo: o funil automático

### O problema que ele resolve

São alunos demais faltando para a coordenação contatar um por um. Mandar mensagem em
massa ajuda a alcançar todos, mas cria outro problema: alguém precisa ler e acompanhar
cada resposta. A ideia é que o sistema faça o contato e resolva sozinho os casos
simples, e que as pessoas só cuidem de quem precisa delas.

### Como vai funcionar

```
Professor lança a chamada
        ↓
Aluno faltou 2 dias de aula seguidos → entra em risco
        ↓
O sistema manda a mensagem de WhatsApp sozinho,
respeitando os limites contra bloqueio do número
        ↓
Aluno responde (ou não)
        ↓
 ┌────────────────┬──────────────────────┬────────────────────┐
 "Amanhã eu volto"  Conta um motivo,       Não respondeu em
                    pede ajuda, pede SAIR  alguns dias
                    ou o sistema não
                    entendeu
 ↓                  ↓                      ↓
 Sistema responde   Vai para a coordenação Vai para a coordenação
 "Combinado, te
 esperamos!"
 ↓
 A próxima chamada da turma decide:
 veio   → sai do risco sozinho, caso fechado
 faltou → "Prometeu e não voltou" → vai para a coordenação
```

O sistema só resolve sozinho **um** tipo de resposta: a promessa de voltar. Todo o resto
vai para uma pessoa, e principalmente o que for delicado (saúde emocional, família). O
robô nunca tenta conversar sobre esses assuntos. Por isso não precisa de inteligência
artificial nem de conversa livre: basta reconhecer o "vou voltar", e a mensagem passa a
terminar com uma pergunta fechada que facilita isso, por exemplo *"Você consegue vir na
próxima aula? Responda SIM, ou conte o que aconteceu."*

### Regras

- **"Amanhã" significa "próximo dia de aula".** Na turma semipresencial, o próximo dia
  de aula pode ser só na semana seguinte. A promessa segue a mesma régua do risco: dia
  de aula lançado, não dia do calendário.
- **Turma sem chamada não deixa a promessa pendente para sempre.** Se a chamada não for
  lançada em alguns dias, o aluno vai para a coordenação de qualquer jeito.
- **Promessa quebrada vai direto para uma pessoa.** Sem segunda mensagem automática:
  repetir o robô justamente quando o aluno sumiu de novo gasta limite e soa frio na hora
  em que mais importa ser gente.
- **Os limites de envio continuam valendo.** Se houver mais alunos em risco do que
  mensagens permitidas no dia, a fila começa por quem está há mais dias sem vir, e quem
  esperar demais sem receber vai para a coordenação.
- **Tudo fica no histórico do aluno.** Cada etapa vira um registro, e quem abrir o aluno
  vê a sequência inteira. Exemplo: "20/10 mensagem automática → 20/10 respondeu 'amanhã
  eu vou' → 22/10 faltou de novo, encaminhado à coordenação".

### A tela da coordenação: "Precisam de contato"

É a fila de trabalho da coordenação. Cada aluno aparece com o motivo de estar ali, em
ordem de prioridade:

| Motivo | Prioridade |
| --- | --- |
| Pediu para falar com alguém ou trouxe assunto delicado | 1 |
| Prometeu voltar e não voltou | 2 |
| Contou um motivo (transporte, trabalho...) | 3 |
| Não respondeu em alguns dias | 4 |
| O sistema não entendeu a resposta, ou chegou um áudio | 4 |
| Pediu SAIR, está sem telefone ou a turma não tem responsável pelo envio | 5 |

Cada linha tem o atalho para o WhatsApp do aluno e o histórico completo.

### Ordem de construção

1. Confirmar que as respostas dos alunos chegam ao sistema. Ainda não foi visto com uma
   mensagem real, e sem isso o funil não funciona.
2. Envio automático, sem precisar alguém clicar em "Iniciar envio".
3. Pergunta fechada na mensagem, reconhecimento do "vou voltar" e resposta automática.
4. Conferência da promessa pela chamada seguinte.
5. Tela "Precisam de contato".

### Quantos números de WhatsApp são necessários

A estimativa da coordenação é de **10 a 15 alunos entrando em risco por semana, em cada
turma**. Com 20 turmas, por exemplo, são 200 a 300 por semana. A capacidade de um número
é bem menor:

| Capacidade de um número | Por semana |
| --- | --- |
| Pelo limite diário (40 por dia, segunda a sábado) | 240 |
| Pelo limite mensal (800 por mês) | **cerca de 185** |
| Na primeira semana (aquecimento, 10 por dia) | 60 |

O limite mensal é o que aperta primeiro. **Um número só não dá conta: seriam pelo menos
2, e 3 com folga.** Esses limites foram definidos pelo próprio projeto, de propósito
abaixo do que se imagina que o WhatsApp tolera, porque ele não divulga o ponto em que
bloqueia um número. Só vale aumentá-los depois de algumas semanas de uso sem problema.

O volume real de mensagens deve ficar abaixo da estimativa, porque:

- muitos alunos voltam sozinhos antes de chegar a vez deles na fila, e a mensagem de
  quem saiu do risco é cancelada;
- cada aluno recebe uma mensagem por sumiço, não uma por semana;
- quem está sem telefone, não está ativo na planilha ou pediu SAIR não recebe.

**Para trocar a estimativa pelo número real**, o script `scripts/medir-risco-semanal.js`
conta, a partir das chamadas lançadas, quantos alunos entraram em risco em cada semana e
em cada turma, quantos receberiam a mensagem e quantos voltaram já na aula seguinte. Ele
só mostra contagens, sem dado de aluno. Roda no servidor com
`docker compose exec node_retencao node scripts/medir-risco-semanal.js`. Turmas cujo
professor ainda não usa o script de captura ficam de fora, então o número da escola é
maior que o medido.

**Recomendação: chips institucionais, não o celular pessoal de ninguém.** Com esse
volume, o risco de bloqueio é real, e um bloqueio no número pessoal faz a pessoa perder o
WhatsApp dela inteiro. Com 2 ou 3 chips da escola em celulares simples, um bloqueio vira
só um problema operacional. Cada chip assume um grupo de turmas, do jeito que o sistema
já funciona hoje. Como hoje cada número pertence a um usuário do painel, o caminho mais
simples é criar um usuário por chip (por exemplo "whatsapp-1", "whatsapp-2"), sem mudar o
banco.

### Em aberto

- **Quantos chips comprar.** Depende do resultado do script de medição.
- **Quem trabalha a fila:** toda a coordenação vê tudo, ou cada pessoa vê as suas turmas.
- **Piloto:** começar com 2 ou 3 turmas, medir quantos respondem e quantos voltam, e
  depois expandir.

## Outros passos

- **Medir o resultado.** Hoje "recuperado" é uma marcação manual. Pela chamada dá para
  calcular quantos alunos voltaram até alguns dias depois do contato, comparando quem
  recebeu mensagem, quem recebeu ligação e quem não foi contatado. É esse número que
  mostra se o projeto funciona e onde vale investir.
- **Frequência acumulada por turma** (% de presença por aluno). É o que pegaria o
  faltante crônico: quem falta uma vez por semana o semestre inteiro nunca tem dois dias
  seguidos, nunca entra na lista de risco e pode reprovar por falta sem ninguém notar.
  Já foi construída uma vez e desfeita, porque nasceria sem dados; o caminho está
  mapeado.
- **Importar CPF e data de nascimento** da planilha, se houver uso para eles.

## Decisões que cabem à diretoria

- **WhatsApp não oficial.** O envio usa um gateway não oficial, com risco aceito de
  bloqueio do número — que pode ser o número pessoal de quem envia. A diretoria precisa
  estar ciente.
- **Uso de inteligência artificial externa.** Um modelo de linguagem leria as respostas
  dos alunos muito melhor que o dicionário de palavras atual, mas isso significa enviar
  frases escritas por menores para uma empresa de fora. Não será adotado sem aprovação.
  O funil automático foi desenhado para funcionar sem ela.
- **Mensagem automática para alunos menores.** O funil passa a contatar o aluno sem uma
  pessoa revisar a lista antes. Vale a diretoria saber, e decidir se, no caso de menores,
  a mensagem deve ir para o responsável.
