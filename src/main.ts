import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { NestWinstonLogger } from './common/logger/nest-logger.service';
import { configureApp } from './bootstrap/configure-app';

async function bootstrap() {
  // rawBody: true — expose req.rawBody (Buffer) sans changer le parsing JSON normal des
  // autres routes. Nécessaire pour vérifier la signature HMAC du webhook
  // POST /internal/entitlements/invalidate (Prompt 7) sur le corps EXACT reçu, pas un
  // JSON.stringify(req.body) reconstruit qui pourrait diverger de ce que l'émetteur a signé.
  const app = await NestFactory.create(AppModule, { logger: new NestWinstonLogger(), rawBody: true });

  configureApp(app);

  // CORS — exact configured origins, plus origin-less native clients (React Native).
  const allowedOrigins = [
    process.env.FRONTEND_ORIGIN,
    process.env.DESKTOP_ORIGIN,
    process.env.BACKOFFICE_ORIGIN,
    ...(process.env.MOBILE_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []),
  ].filter((o): o is string => !!o);
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Coiffio API')
    .setDescription('SalonOS backend API reference')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('access_token')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  await app.listen(process.env.PORT || 3000);
  new Logger('Bootstrap').log(`SalonOS API on http://localhost:${process.env.PORT}/api`);
  new Logger('Bootstrap').log(`Swagger docs on http://localhost:${process.env.PORT}/api/docs`);
}

void bootstrap();
