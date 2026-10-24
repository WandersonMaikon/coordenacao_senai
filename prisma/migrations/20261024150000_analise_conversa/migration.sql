-- AlterTable
ALTER TABLE `mensagens_whatsapp` ADD COLUMN `conversa_resumo` TEXT NULL,
    ADD COLUMN `conversa_situacao` VARCHAR(20) NULL,
    ADD COLUMN `conversa_motivo` VARCHAR(50) NULL,
    ADD COLUMN `conversa_analisada_em` DATETIME(3) NULL;
