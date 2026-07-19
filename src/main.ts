import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Session auth is a bearer token (Authorization header), not a cookie —
  // see docs/auth.md's "Why a bearer token, not a cookie". No credentials
  // flag needed; CORS_ORIGIN is still a reasonable allowlist (unset locally,
  // where it falls back to reflecting any origin, matching the original
  // permissive app.enableCors()).
  const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : true;
  app.enableCors({ origin: corsOrigin });
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
        'Single-user app: every request is treated as the same dev user (DevUserMiddleware). Deployments that set ' +
        'APP_PASSWORD additionally require an `Authorization: Bearer <token>` header (token from POST /auth/login) ' +
        'on every route.',
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
