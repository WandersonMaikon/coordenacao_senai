-- Total de aulas do dia naquela UC, para a tela de Frequência poder calcular
-- a % de cada aluno (faltas / aulas). Antes o backend recebia só quantas faltas
-- o aluno teve, sem saber de quantas aulas — dava pra somar falta, nunca
-- calcular frequência.
--
-- Nulo de propósito: os lançamentos gravados antes da v4.1 do userscript não têm
-- como saber esse número retroativamente. A tela de Frequência desconsidera
-- esses dias e informa quantos ficaram de fora do cálculo.

-- AlterTable
ALTER TABLE `lancamentos` ADD COLUMN `qtd_aulas` INTEGER NULL;
