import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('My TV Server API')
    .setDescription(
      'Personal TV tracking backend. This is the API contract the React Native client is built against. ' +
        'Auth is currently a hardcoded dev user — every request is treated as the same user.',
    )
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // 3001, not 3000 — the sibling nemesh/client (Next.js) project defaults to
  // 3000, so this fallback must never collide with it even when PORT isn't
  // set (e.g. a fresh checkout run before .env is copied). See README.md's
  // "Environment variables" table and .env.example — keep both in sync.
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Server listening on port ${port} — Swagger docs at /docs`);
}

bootstrap();
