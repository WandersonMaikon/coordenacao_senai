-- AlterTable
ALTER TABLE `alunos` ADD COLUMN `whatsapp_opt_out` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `usuario_turmas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `usuario_id` INTEGER NOT NULL,
    `codigo_turma` VARCHAR(50) NOT NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `usuario_turmas_codigo_turma_key`(`codigo_turma`),
    INDEX `usuario_turmas_usuario_id_idx`(`usuario_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
