import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The standalone frontend (fratoo-web) talks to this API under /api —
  // nginx proxies it that way in production, and the Vite dev server does
  // the same locally. CORS stays enabled since this is a small single-admin
  // tool, not a multi-tenant service with a sensitive cross-origin surface.
  app.enableCors();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
