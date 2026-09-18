-- CreateTable
CREATE TABLE `casos_resolvidos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `matricula` VARCHAR(20) NOT NULL,
    `codigo_turma` VARCHAR(50) NOT NULL,
    `nome_aluno` VARCHAR(255) NULL,
    `nome_turma` VARCHAR(255) NULL,
    `motivo` VARCHAR(50) NULL,
    `observacao` TEXT NULL,
    `resolvido_por` VARCHAR(255) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `casos_resolvidos_matricula_codigo_turma_key`(`matricula`, `codigo_turma`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
