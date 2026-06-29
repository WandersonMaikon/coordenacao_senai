-- CreateTable
CREATE TABLE `lancamentos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `matricula` VARCHAR(20) NOT NULL,
    `nome_aluno` VARCHAR(255) NULL,
    `data_aula` VARCHAR(20) NULL,
    `id_aula` VARCHAR(50) NULL,
    `codigo_turma` VARCHAR(50) NULL,
    `nome_turma` VARCHAR(255) NULL,
    `uc` VARCHAR(255) NULL,
    `periodo_letivo` VARCHAR(20) NULL,
    `professor` VARCHAR(255) NULL,
    `qtd_faltas` INTEGER NOT NULL DEFAULT 1,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `lancamentos_matricula_data_aula_codigo_turma_key`(`matricula`, `data_aula`, `codigo_turma`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alunos` (
    `matricula` VARCHAR(20) NOT NULL,
    `nome` VARCHAR(255) NULL,
    `telefone` VARCHAR(20) NULL,
    `cpf` VARCHAR(20) NULL,
    `nascimento` DATETIME(3) NULL,
    `situacao` VARCHAR(50) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizado_em` DATETIME(3) NOT NULL,

    PRIMARY KEY (`matricula`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contatos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `matricula` VARCHAR(20) NOT NULL,
    `canal` VARCHAR(50) NULL,
    `status` VARCHAR(50) NULL,
    `observacao` TEXT NULL,
    `contatado_por` VARCHAR(255) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `lancamentos` ADD CONSTRAINT `lancamentos_matricula_fkey` FOREIGN KEY (`matricula`) REFERENCES `alunos`(`matricula`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contatos` ADD CONSTRAINT `contatos_matricula_fkey` FOREIGN KEY (`matricula`) REFERENCES `alunos`(`matricula`) ON DELETE RESTRICT ON UPDATE CASCADE;
