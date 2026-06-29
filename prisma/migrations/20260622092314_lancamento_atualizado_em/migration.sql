/*
  Warnings:

  - Added the required column `atualizado_em` to the `lancamentos` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `lancamentos` ADD COLUMN `atualizado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
