-- AlterTable
ALTER TABLE `whatsapp_sessoes` ADD COLUMN `falhas_seguidas` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `lotes_whatsapp` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `sessao_id` INTEGER NOT NULL,
    `usuario_id` INTEGER NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'em_andamento',
    `total` INTEGER NOT NULL,
    `aguardando` VARCHAR(255) NULL,
    `proximo_envio_em` DATETIME(3) NULL,
    `parado_por` VARCHAR(255) NULL,
    `iniciado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finalizado_em` DATETIME(3) NULL,
    `atualizado_em` DATETIME(3) NOT NULL,

    INDEX `lotes_whatsapp_sessao_id_status_idx`(`sessao_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mensagens_whatsapp` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `lote_id` INTEGER NOT NULL,
    `sessao_id` INTEGER NOT NULL,
    `usuario_id` INTEGER NOT NULL,
    `matricula` VARCHAR(20) NOT NULL,
    `nome_aluno` VARCHAR(255) NULL,
    `codigo_turma` VARCHAR(50) NOT NULL,
    `nome_turma` VARCHAR(255) NULL,
    `primeira_falta` VARCHAR(20) NOT NULL,
    `telefone` VARCHAR(20) NOT NULL,
    `texto` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pendente',
    `erro` VARCHAR(255) NULL,
    `falha_definitiva` BOOLEAN NOT NULL DEFAULT false,
    `chat_id` VARCHAR(64) NULL,
    `message_id` VARCHAR(191) NULL,
    `contato_id` INTEGER NULL,
    `enviada_em` DATETIME(3) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizado_em` DATETIME(3) NOT NULL,

    INDEX `mensagens_whatsapp_lote_id_status_idx`(`lote_id`, `status`),
    INDEX `mensagens_whatsapp_sessao_id_enviada_em_idx`(`sessao_id`, `enviada_em`),
    INDEX `mensagens_whatsapp_usuario_id_idx`(`usuario_id`),
    UNIQUE INDEX `mensagens_whatsapp_matricula_codigo_turma_primeira_falta_key`(`matricula`, `codigo_turma`, `primeira_falta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
