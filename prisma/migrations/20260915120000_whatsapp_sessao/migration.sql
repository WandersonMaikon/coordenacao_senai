-- CreateTable
CREATE TABLE `whatsapp_sessoes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `usuario_id` INTEGER NOT NULL,
    `telefone` VARCHAR(20) NULL,
    `telefone_conectado` VARCHAR(20) NULL,
    `tipo` VARCHAR(20) NOT NULL DEFAULT 'pessoal',
    `session_id` VARCHAR(64) NULL,
    `status` VARCHAR(30) NULL,
    `mensagem_modelo` TEXT NULL,
    `intervalo_min_seg` INTEGER NOT NULL DEFAULT 90,
    `intervalo_max_seg` INTEGER NOT NULL DEFAULT 180,
    `limite_dia` INTEGER NOT NULL DEFAULT 25,
    `limite_mes` INTEGER NOT NULL DEFAULT 500,
    `janela_inicio` VARCHAR(5) NOT NULL DEFAULT '08:00',
    `janela_fim` VARCHAR(5) NOT NULL DEFAULT '19:00',
    `pausado_motivo` VARCHAR(255) NULL,
    `conectado_em` DATETIME(3) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizado_em` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsapp_sessoes_usuario_id_key`(`usuario_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
