import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NestWinstonLogger } from './common/logger/nest-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new NestWinstonLogger() });

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Convention #1 & #2 — enveloppe globale + filtre d'exception
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  // CORS — exact configured origins, plus origin-less native clients (React Native).
  const allowedOrigins = [
    process.env.FRONTEND_ORIGIN,
    process.env.DESKTOP_ORIGIN,
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
