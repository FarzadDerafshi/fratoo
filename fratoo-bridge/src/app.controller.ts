import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import type { VersionInfo } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Unauthenticated on purpose: lets ProdRelease.bat (and a quick curl) confirm which build is running. */
  @Get('version')
  getVersion(): VersionInfo {
    return this.appService.getVersion();
  }
}
