import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('version', () => {
    it('reports the package.json version', () => {
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
      expect(appController.getVersion().version).toBe(pkg.version);
    });

    it('falls back to "dev" when no commit was baked in', () => {
      expect(appController.getVersion().commit).toBe(process.env.GIT_COMMIT || 'dev');
    });
  });
});
