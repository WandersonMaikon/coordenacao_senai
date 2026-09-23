-- AlterTable: sugestão de motivo vinda da resposta do aluno no WhatsApp
ALTER TABLE `contatos`
    ADD COLUMN `motivo_sugerido` VARCHAR(50) NULL,
    ADD COLUMN `sugerido_por` VARCHAR(20) NULL;

-- CreateTable
CREATE TABLE `respostas_whatsapp` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `message_id` VARCHAR(191) NOT NULL,
    `chat_id` VARCHAR(64) NOT NULL,
    `telefone` VARCHAR(20) NULL,
    `matricula` VARCHAR(20) NULL,
    `mensagem_id` INTEGER NULL,
    `contato_id` INTEGER NULL,
    `texto` TEXT NOT NULL,
    `interpretacao` VARCHAR(20) NOT NULL,
    `motivo_sugerido` VARCHAR(50) NULL,
    `recebida_em` DATETIME(3) NOT NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `respostas_whatsapp_message_id_key`(`message_id`),
    INDEX `respostas_whatsapp_matricula_idx`(`matricula`),
    INDEX `respostas_whatsapp_chat_id_idx`(`chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
