-- DropForeignKey
ALTER TABLE `contatos` DROP FOREIGN KEY `contatos_matricula_fkey`;

-- DropForeignKey
ALTER TABLE `lancamentos` DROP FOREIGN KEY `lancamentos_matricula_fkey`;

-- CreateIndex
CREATE INDEX `lancamentos_matricula_idx` ON `lancamentos`(`matricula`);

-- RenameIndex
ALTER TABLE `contatos` RENAME INDEX `contatos_matricula_fkey` TO `contatos_matricula_idx`;
