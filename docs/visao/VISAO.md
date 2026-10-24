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
 ┌────────────────┬──────────────────────┬──────────────────────────┐
 "Amanhã eu volto"  Conta um motivo,       Não respondeu e continua
                    pede ajuda, pede SAIR  faltando
                    ou o sistema não
                    entendeu
 ↓                  ↓                      ↓
 Sistema responde   Vai para a coordenação 7 dias depois, 2ª (e última)
 "Combinado, te                            mensagem automática
 esperamos!"                               ↓
 ↓                                         Ainda sem resposta →
 A próxima chamada da turma decide:        vai para a coordenação
 veio   → sai do risco sozinho, caso fechado      (ligar, falar pessoalmente)
 faltou → "Prometeu e não voltou" → vai para a coordenação
```

Ninguém precisa "assumir turma": o envio sai de **um número do sistema** (chip
institucional) para os alunos em risco da escola inteira, sozinho, e a coordenação só
liga a chave e acompanha.

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
- **No máximo 2 mensagens automáticas por sumiço, com uma semana entre elas.** A 1ª vai
  no 2º dia de falta. Se o aluno não responder e continuar faltando, a 2ª vai 7 dias
  depois, com outro texto. Depois disso o robô para: mais insistência vira incômodo e
  aumenta o risco de o número ser denunciado. O caso passa a ser de uma pessoa, por
  ligação ou contato presencial.
- **Uma mensagem por aluno por semana**, mesmo que ele esteja em risco em duas turmas.
- **Promessa quebrada vai direto para uma pessoa.** Sem segunda mensagem automática:
  repetir o robô justamente quando o aluno sumiu de novo gasta limite e soa frio na hora
  em que mais importa ser gente.
- **Quem conversou com a coordenação nos últimos 7 dias não recebe a mensagem
  automática.** Passados 7 dias desse contato, se o aluno continua faltando, o WhatsApp
  volta a valer. Quem já estava em risco quando o envio foi ligado também recebe: a fila
  respeita o limite diário e se espalha pelos dias seguintes. (Decidido em 22/10/2026,
  no lugar da regra inicial que deixava com a coordenação quem tinha entrado em risco
  havia mais de 7 dias.)
- **O robô preenche o histórico, a pessoa confirma o motivo.** Envio, leitura, resposta
  do aluno, motivo sugerido e promessa viram registros do aluno sozinhos. Só o motivo
  precisa de um clique de confirmação para entrar no gráfico de motivos, porque é o
  indicador levado à diretoria e um erro de classificação ali custa caro.
- **Os limites de envio continuam valendo.** Se houver mais alunos em risco do que
  mensagens permitidas no dia, a fila começa por quem está há mais dias sem vir, e quem
  esperar demais sem receber vai para a coordenação.
- **Tudo fica no histórico do aluno.** Cada etapa vira um registro, e quem abrir o aluno
  vê a sequência inteira. Exemplo: "20/10 mensagem automática → 20/10 respondeu 'amanhã
  eu vou' → 22/10 faltou de novo, encaminhado à coordenação".

### A tela da coordenação: "Precisam de contato"

É a fila de trabalho da coordenação (rota `/contatar`): só quem o robô **não** resolve
e precisa de contato humano, por ligação, WhatsApp pessoal ou presencialmente. Cada
aluno aparece com o motivo de estar ali, em ordem de prioridade:

| Motivo | Prioridade |
| --- | --- |
| Pediu para falar com alguém ou trouxe assunto delicado | 1 |
| Prometeu voltar e não voltou | 2 |
| Contou um motivo (transporte, trabalho...), ou o sistema não entendeu a resposta, ou chegou um áudio | 3 |
| Recebeu as 2 mensagens automáticas e não respondeu | 4 |
| Pediu SAIR (não quer WhatsApp, mas continua precisando de contato) | 5 |
| Não dá para mandar WhatsApp: sem telefone, número sem WhatsApp | 5 |

Cada linha tem o telefone, o atalho para o WhatsApp e o histórico completo do que o robô
já fez. O aluno sai da lista sozinho quando alguém registra o contato ou quando ele volta
a ter presença na chamada. Toda a coordenação vê a lista inteira, com filtro por turma.

### A tela de acompanhamento do envio

Substitui o "assumir turma" da tela de WhatsApp. Mostra a cobertura da escola inteira:
quantos alunos em risco já receberam mensagem (e a porcentagem), quantos responderam,
prometeram voltar, estão sem resposta, estão na fila do dia, e quantos não podem receber
(sem telefone, sem WhatsApp, pediram SAIR).

### Ordem de construção

0. Confirmar que as respostas dos alunos chegam ao sistema. Ainda não foi visto com uma
   mensagem real, e sem isso o funil não funciona.
1. ~~Número do sistema e envio automático, sem "assumir turma" nem botão "Iniciar
   envio", com a tela de acompanhamento.~~ (no ar desde 22/10/2026)
2. ~~Regra da semana (2ª mensagem 7 dias depois) e uma mensagem por aluno.~~ (feito em
   23/10/2026; sem resposta 3 dias depois da 2ª, o aluno vai para "Precisam de contato")
3. ~~Tela "Precisam de contato", incluindo quem pediu SAIR.~~ (feito em 22/10/2026, rota
   `/contatar`)
4. ~~Pergunta fechada na mensagem, reconhecimento do "vou voltar", resposta automática e
   conferência da promessa pela chamada seguinte.~~ (feito em 22/10/2026; quem prometeu e
   faltou aparece na tela de envio automático até a tela "Precisam de contato" existir)
5. ~~Linha do tempo do robô no histórico do aluno, na tela de alunos em risco.~~ (feito em
   23/10/2026)
6. ~~Trava de faltas coletivas.~~ (feito em 23/10/2026)
7. ~~Roteiro de conversa: o robô conduz algumas trocas curtas antes de passar para a
   coordenação (pede texto quando chega áudio, pergunta o motivo de quem fala em
   desistir, pede o atestado de quem está doente, oferece conversa com a coordenação
   para transporte/trabalho/dinheiro) e fica quieto quando alguém da coordenação
   escreve à mão.~~ (feito em 24/10/2026, a partir de uma conversa real em que o aluno
   avisou que ia sair e mandou um áudio)

Cada etapa sobe sozinha e já serve para alguma coisa.

### Quantos números de WhatsApp são necessários

Medido em 20/10/2026 com `scripts/medir-risco-semanal.js`, sobre as chamadas de 31/08 a
19/10 (14 a 18 turmas com chamada lançada por semana):

- **Cerca de 90 alunos entram em risco por semana na escola inteira**, nas semanas
  completas (de 31 a 132). A estimativa inicial, de 10 a 15 por turma, só vale para as
  duas turmas de maior volume (Segurança do Trabalho 0010 e 0011, cerca de 10 por semana
  cada). A maioria das turmas fica entre 2 e 5.
- Quase todos teriam como receber a mensagem (telefone, situação ativa, sem SAIR).
- **1 em cada 3 volta sozinho na aula seguinte, e 2 em cada 3 continuam faltando.** Por
  isso a mensagem continua indo no 2º dia de falta: esperar o 3º economizaria um terço
  das mensagens, mas atrasaria o contato com a maioria, que é quem está sumindo.

| | Necessário | Capacidade de 1 número |
| --- | --- | --- |
| Semana típica | cerca de 90 | cerca de 185 (limite do mês) |
| Pior semana (07/09) | 132 | 240 (limite do dia) |
| Mês | cerca de 390 | 800 |
| Pior dia (05/10) | 56 | 40 |

**Um número dá conta.** Só o pior dia passa do limite, e quem não couber recebe no dia
seguinte, começando por quem está há mais dias sem vir. Um segundo número serve de
**reserva**: se um for bloqueado, o outro assume as turmas no mesmo dia. Os limites (40
por dia, 800 por mês, 10 por dia na primeira semana) foram definidos pelo próprio
projeto, de propósito abaixo do que se imagina que o WhatsApp tolera, porque ele não
divulga o ponto em que bloqueia um número.

**Chip institucional, não o celular pessoal de ninguém.** Um bloqueio no número pessoal
faz a pessoa perder o WhatsApp dela inteiro; num chip da escola, vira só um problema
operacional. Como hoje cada número pertence a um usuário do painel, o chip ganha um
usuário próprio (por exemplo "whatsapp-1"), e esse número é marcado como o número do
sistema, que envia para todas as turmas.

Para medir de novo:
`docker compose exec node_retencao node scripts/medir-risco-semanal.js`. Turma cujo
professor não usa o script de captura fica de fora da conta.

### Faltas coletivas

A medição mostrou dias em que muitos alunos entram em risco juntos: 56 no dia 05/10, e
na semana de 07/09 112 de 132 faltaram de novo. Isso parece evento coletivo (feriado
emendado, evento da escola, chuva, ônibus), não evasão individual. Mandar "sentimos sua
falta" para uma turma inteira que faltou junta gasta o limite do número e soa como robô.

Regra: **se mais da metade de uma turma entrar em risco no mesmo dia, o envio daquela
turma fica parado até a coordenação confirmar** que é para mandar.

Como ficou: conta-se a metade sobre os alunos que tiveram chamada naquele dia, com um mínimo
de 5 alunos entrando em risco juntos (3 de 5 faltando numa turma pequena não é evento). A tela
de envio automático mostra o aviso com dois botões, "Enviar mesmo assim" e "Não enviar (foi
um evento da turma)". Só a 1ª mensagem fica segura, e só enquanto a última falta do aluno é a
do dia coletivo: quem faltar de novo na aula seguinte recebe normalmente, com ou sem decisão,
porque aí já não é mais o evento.

### Piloto

Começar pelas turmas **APT-TST-I-0010 e APT-TST-I-0011**: são as de maior volume (cerca
de 21 alunos por semana, 3 a 4 mensagens por dia), cabem com folga até na semana de
aquecimento do número, e é onde o resultado vai aparecer mais rápido.

### Em aberto

- **O que aconteceu em 07/09 e 05/10.** Confirmar se foram mesmo faltas coletivas, para
  calibrar a regra acima.

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
- **Inteligência artificial para ler as respostas.** Desde 23/10/2026 o sistema usa uma IA
  gratuita que roda **no próprio servidor da escola** (Ollama, com o modelo Gemma): a frase do
  aluno não é enviada a nenhuma empresa. Ela só entende a resposta (promessa, desistência,
  motivo); quem responde ao aluno continuam sendo textos fixos escritos pela coordenação.
  Uma IA externa (de empresa, paga) leria ainda melhor, mas significaria enviar frases de
  menores para fora — isso continua sem ser adotado. Vale a diretoria saber da IA local.
- **Mensagem automática para alunos menores.** O funil passa a contatar o aluno sem uma
  pessoa revisar a lista antes. Vale a diretoria saber, e decidir se, no caso de menores,
  a mensagem deve ir para o responsável.
