# Sistema de Retenção e Resgate de Alunos — SENAI Ji-Paraná/RO

Backend e painel web para acompanhar a frequência dos alunos e agir cedo contra a evasão
escolar. A frequência é capturada direto da tela do SGE (sistema acadêmico TOTVS) no
momento em que o professor lança a chamada, e a coordenação enxerga num painel quem está
faltando, com quem já foi feito contato e por qual motivo o aluno está se afastando.

> **Dados sensíveis.** O sistema lida com dados pessoais de alunos de 14 a 23 anos
> (nome, matrícula, telefone). Cuidado redobrado com logs, exportações e qualquer
> exposição pública desses dados.

## Como funciona

```
SGE (portal Angular/PO-UI da TOTVS)
      │  professor lança a chamada normalmente
      ▼
Tampermonkey — userscript no navegador de cada professor
      │  POST /webhook/frequencia (cópia dos dados da tela)
      ▼
Backend Node + Express  ── Prisma ORM ──▶  MySQL (senai_retencao)
      │
      ▼
Painel EJS (/painel, /faltas, /risco) para a coordenação
```

O SGE não oferece relatório de frequência consolidado por turma nem API pública. Em vez
de esperar o suporte da TOTVS, o userscript
([`tampermonkey/sge-captura.user.js`](tampermonkey/sge-captura.user.js)) lê o DOM no clique
em "Salvar" e envia uma cópia para este backend — sem mudar o fluxo de trabalho do
professor.

O userscript usa **resposta otimista** (mostra sucesso antes da confirmação do servidor),
com retry e fila local. Então o backend pode receber lançamentos repetidos ou atrasados:
duplicatas são esperadas e resolvidas por constraint única + `upsert`, não são erro.

## Stack

- **Node.js** (CommonJS) + **Express v5**
- **Prisma ORM** + **MySQL** (`mysql2` como driver, adapter MariaDB)
- **EJS** para as views do painel — server-side, sem SPA e sem build step de frontend
- `jsonwebtoken` + `bcryptjs` (login), `multer` + `xlsx` (importação de planilha)
- Deploy em **Docker** atrás de um túnel **Cloudflare**

## Rodando localmente

Requisitos: Node.js 22+ e um MySQL acessível.

```bash
npm install
cp .env.example .env      # preencha DB_*, DATABASE_URL e JWT_SECRET
npx prisma migrate dev    # cria/atualiza as tabelas
npx prisma generate       # regenera o client após mudar o schema
npm run dev               # sobe com nodemon em http://localhost:3000
```

Depois abra `http://localhost:3000/` (redireciona para o login). Para criar o primeiro
usuário do painel:

```bash
npm run criar-usuario -- <usuario> <senha> "Nome opcional"
```

Outros comandos úteis:

| Comando | O que faz |
| --- | --- |
| `npm start` | sobe em produção (`node server.js`) |
| `npm run seed-admin` | garante o usuário admin definido em `SEED_ADMIN_USER`/`SEED_ADMIN_PASSWORD` (roda a cada deploy; nunca sobrescreve senha existente) |
| `npx prisma studio` | interface visual do banco no navegador |

### Variáveis de ambiente

Veja [`.env.example`](.env.example) para a lista completa e comentada. Em resumo:

- `PORT` — porta interna do Node.
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — usadas **em tempo de
  execução** pelo adapter do Prisma ([`src/config/prisma.js`](src/config/prisma.js)).
- `DATABASE_URL` — a mesma conexão em formato URL, usada apenas pelo **Prisma CLI**
  (`migrate`). Mantenha as duas em sincronia.
- `JWT_SECRET` — chave que assina o token do login (12h de validade).
- `CLOUDFLARE_TUNNEL_TOKEN` — só no servidor, para o container do túnel.
- `SEED_ADMIN_USER` / `SEED_ADMIN_PASSWORD` — opcionais, usadas pelo `seed-admin`.

## Estrutura

```
server.js                 monta Express, EJS e as rotas (sem lógica de negócio)
src/config/prisma.js      instância única do Prisma Client
src/routes/               caminhos HTTP → controller/middleware
src/controllers/          lógica de cada rota
src/middlewares/auth.js   autenticar (JWT) e exigirAdmin
src/views/                páginas EJS do painel + partials
public/                   CSS, imagens e assets estáticos
prisma/schema.prisma      schema do banco + migrations
scripts/                  seed-admin.js e criar-usuario.js
tampermonkey/             código-fonte do userscript dos professores
```

## Endpoints

Rotas marcadas como **protegidas** exigem o header `Authorization: Bearer <token>`,
obtido em `POST /auth/login`.

### Público

| Rota | Descrição |
| --- | --- |
| `GET /` | redireciona para `/login` |
| `GET /health` | healthcheck JSON |
| `GET /sge-captura.user.js` | serve o userscript com `Cache-Control: no-store` (alvo do `@updateURL`) |
| `POST /webhook/frequencia` | recebe `{ lancamentos: [...] }` do userscript — **não** adicione `autenticar` aqui sem atualizar o userscript junto |
| `POST /auth/login` | `{ usuario, senha }` → `{ token }` |

### Protegido

| Rota | Descrição |
| --- | --- |
| `GET /lancamentos` | lista lançamentos (sem filtro: os 100 mais recentes); filtros `?dataInicio=&dataFim=` e/ou `?turma=` |
| `GET /turmas` | turmas distintas já lançadas (popula o filtro da tela de Faltas) |
| `GET /alunos-risco` | alunos com faltas consecutivas em aberto; filtro `?turma=` |
| `POST /alunos/importar-telefones` | planilha Excel da secretaria (`multipart/form-data`, campo `arquivo`, até 5MB) |
| `GET /contatos?matricula=` | histórico de contatos de um aluno, mais recente primeiro |
| `POST /contatos` | registra um contato da coordenação |
| `PUT /contatos/:id` | corrige um contato já registrado |
| `GET /auth/usuarios` · `POST /auth/usuarios` | gestão de usuários do painel — **só admin** |

### Views

`GET /login`, `/painel`, `/faltas`, `/risco`, `/importar-telefones`, `/usuarios`.

As views **não** passam pelo middleware `autenticar`: elas só renderizam HTML, e a
proteção real acontece no JS de cada página, que redireciona para `/login` se não houver
token salvo e usa o token nas chamadas `fetch()`. Ou seja: o HTML do painel não é
secreto — os dados é que são, e esses vêm pela API protegida.

## Modelos (Prisma)

- **`Usuario`** (`usuarios`) — login da coordenação: `usuario` (único), `senhaHash`
  (bcrypt), `nome`, `admin`. Só quem tem `admin = true` acessa a tela `/usuarios`.
- **`Lancamento`** (`lancamentos`) — uma chamada capturada. Constraint única em
  `(matricula, dataAula, codigoTurma, uc)`. `dataAula` é guardada como string
  `dd/mm/aaaa` (formato do SGE) — por isso o filtro por intervalo gera a lista de datas do
  período e usa `in`, não `gte`/`lte`.
- **`Aluno`** (`alunos`) — hoje populada só com `matricula` + `telefone`, via importação da
  planilha. Os demais campos (nome, cpf, nascimento, situação) existem no schema mas ainda
  não são preenchidos por nenhum código.
- **`Contato`** (`contatos`) — histórico de contato com o aluno: `canal`
  (whatsapp/ligacao/presencial), `status`
  (respondido/sem_resposta/acompanhar/nunca_contato/recuperado), `motivo`
  (transporte/trabalho/saude/financeiro/desmotivacao_curso/problema_familiar/outro) e
  `observacao`. `contatadoPor` vem do usuário do token, não é digitado. O `motivo` é o que
  permite medir *por que* os alunos estão evadindo, e não só *quantos* faltaram.

Colunas do banco em `snake_case`, mapeadas para `camelCase` no Prisma via `@map()`.
**Sempre gere migration** (`npx prisma migrate dev`) — nunca altere tabelas direto no MySQL.

### Por que a UC faz parte da chave única

Uma turma pode ter dois professores lançando no mesmo dia, uma UC cada. Sem a UC na chave,
o segundo envio caía na mesma linha e sobrescrevia a falta lançada pelo primeiro —
inclusive zerando-a quando o aluno estava presente na outra UC. Com ela, cada UC tem sua
própria linha e a soma do dia é feita na leitura. Por isso `uc` é `NOT NULL DEFAULT ''`:
em MySQL `NULL` não colide com `NULL` num índice único, e a idempotência não valeria para
essas linhas.

O webhook faz `upsert` (não `create`) nessa chave: um segundo envio **atualiza** o
registro existente. É o que permite ao professor corrigir uma falta lançada por engano —
ele desmarca, salva de novo, e o userscript envia `qtd_faltas: 0` por cima.
`criadoEm === atualizadoEm` indica registro criado naquela chamada; valores diferentes
indicam correção.

### Critério de "aluno em risco"

`GET /alunos-risco` agrupa os lançamentos por (aluno, turma) e **agrega por dia** — um dia
pode ter mais de um lançamento, um por UC: as faltas somam, e presença em qualquer UC
marca o dia inteiro como presença (o aluno veio). A partir do dia mais recente, se o aluno
tem **2 dias de aula seguidos com falta e nenhuma presença no meio**, ele entra na lista.

É uma sequência *em aberto*, não soma acumulada do período: assim que aparece presença num
lançamento seguinte, entende-se que ele voltou e some da lista. A régua é "dia de aula
lançado", não intervalo de calendário — então a mesma regra vale para turma diária e para
semi-presencial (1 aula/semana, ex.: 06/08 e 13/08).

Cada item traz `diasSemVir` (dias de aula seguidos na sequência — é o que a tela mostra;
não dá para derivar dividindo as faltas por um nº fixo de aulas, porque um dia com duas
UCs tem mais aulas lançadas) e `totalFaltas` (aulas perdidas na sequência), enriquecidos
com `telefone` e `ultimoContato`.

## O userscript dos professores

[`tampermonkey/sge-captura.user.js`](tampermonkey/sge-captura.user.js) é servido pelo
próprio backend em `/sge-captura.user.js`. O Tampermonkey de cada professor consulta essa
URL periodicamente e baixa a versão nova **quando a `@version` do cabeçalho sobe**.

> ⚠️ **Toda alteração no script precisa vir acompanhada de um bump da `@version`** —
> senão ela não chega em ninguém.

O nome do professor não fica no código (seria sobrescrito pela atualização): é perguntado
uma vez e guardado no Tampermonkey da máquina (`GM_setValue`, chave
`sge_nome_professor`), com um item de menu "Alterar nome do professor" para trocar depois.

O script mantém um cache local (chave `sge_cache_estado_v2`) com o último `qtd_faltas`
confirmado pelo servidor por `matricula+data_aula+codigo_turma+uc`. A cada "Salvar" ele
captura a tela inteira mas só envia o que mudou: dia novo (essa chave nunca foi enviada —
envia mesmo com `qtd_faltas = 0`) ou correção (valor diferente do cache, inclusive
voltando a 0). Isso evita remandar a turma toda a cada clique, mas garante que **presença
também vira lançamento** — é o que permite ao `/alunos-risco` saber que um aluno com falta
em aberto voltou. O cache só é atualizado quando o servidor confirma, nunca de forma
otimista, para não perder uma correção em caso de falha de rede.

Se o layout do SGE mudar de novo (já mudou uma vez: TOTVS RM/ASP.NET WebForms →
Angular/PO-UI), os seletores DOM em `capturarFaltas()` e `extrairInfoTurma()` precisarão
ser reescritos a partir do HTML real da nova tela.

## Deploy

O sistema roda em containers no servidor da escola:

```
docker-compose.yml
├── mysql_retencao        MySQL 8.0 (volume retencao_db_data)
├── node_retencao         este backend (roda "prisma migrate deploy" no start)
└── cloudflared_retencao  túnel Cloudflare (profile "tunnel")
```

O deploy é **automático**: cada push em `main` dispara
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) num runner self-hosted, que
executa [`atualizar.sh`](atualizar.sh) — `git pull` + rebuild dos containers +
`seed-admin`.

> ⚠️ **Push direto em `main` já publica em produção.**

Para rodar manualmente no servidor: `./atualizar.sh`.

## Decisões já tomadas

Estas escolhas já passaram por discussão — se for propor mudança, pergunte antes:

- **Node + Express** (não Go/PHP/Python) — o sistema é mantido por um professor só;
  clareza e manutenibilidade valem mais que sofisticação técnica.
- **MySQL** (não Postgres) — experiência prévia de quem mantém.
- **Prisma** (não Sequelize/Knex) — curva de aprendizado menor, Prisma Studio incluído.
- **Captura via userscript lendo o DOM** — não existe API oficial do SGE, e scraping
  headless automatizado seria mais frágil e institucionalmente mais sensível.
- O webhook inicial era um Google Apps Script, migrado para este backend por lentidão de
  cold start. Documentação que mencione Apps Script está desatualizada.

## Roadmap

- [x] Captura de frequência via userscript → backend → MySQL
- [x] Importar planilha Excel da secretaria (só telefone por enquanto)
- [x] Painel para a coordenação (`/painel`, `/faltas`, `/importar-telefones`)
- [x] Deploy Docker com atualização automática via GitHub Actions
- [x] Gatilho de alerta por faltas consecutivas (`/alunos-risco`)
- [x] Registro manual de contato pela coordenação (tela `/risco`, com motivo da falta)
- [ ] Integração com a WhatsApp Business Cloud API (Meta) para alerta automático ao aluno
      (precisa de templates pré-aprovados pela Meta) — hoje o link de WhatsApp nas telas é
      manual (`wa.me`), não é uma API oficial integrada
- [ ] Importar também nome/cpf/nascimento/situação na planilha de alunos
- [ ] Notificação automática (hoje o aluno em risco só aparece na tela)
