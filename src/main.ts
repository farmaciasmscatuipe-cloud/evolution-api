// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';

import * as Sentry from '@sentry/node';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

async function initWA() {
  await waMonitor.loadInstance();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  // Provider
  let providerFiles: ProviderFiles | null = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  // Prisma
  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  // Middlewares
  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) return callback(null, true);
        if (ORIGIN.indexOf(requestOrigin) !== -1) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  // Views e arquivos estáticos
  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));
  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  // ✅ Healthcheck (Render)
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Rotas
  app.use('/', router);

  // Tratamento de erros
  app.use(
    async (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (
          webhook.EVENTS.ERRORS_WEBHOOK &&
          webhook.EVENTS.ERRORS_WEBHOOK !== '' &&
          webhook.EVENTS.ERRORS
        ) {
          const tzoffset = new Date().getTimezoneOffset() * 60000;
          const now = new Date(Date.now() - tzoffset).toISOString();

          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          try {
            const httpService = axios.create({
              baseURL: webhook.EVENTS.ERRORS_WEBHOOK,
              timeout: 5000,
            });
            await httpService.post('', errorData);
          } catch {
            logger.warn('Erro ao enviar webhook de erro');
          }
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });
    },
  );

  // Sentry
  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');
    Sentry.setupExpressErrorHandler(app);
  }

  // 🚀 PORTA (Render)
  const httpServer = configService.get<HttpServer>('SERVER');
  const port = Number(process.env.PORT) || httpServer.PORT || 3000;

  const server = app.listen(port, '0.0.0.0', () => {
    logger.log('HTTP - ON: ' + port);
  });

  // Eventos internos
  eventManager.init(server);

  // WhatsApp
  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  // Erros globais
  onUnexpectedError();
}

bootstrap();
