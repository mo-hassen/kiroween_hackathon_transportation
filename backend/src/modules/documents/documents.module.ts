import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/** Reusable private-document module; domain modules link documents through their own tables. */
@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
