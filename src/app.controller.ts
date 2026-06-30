import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  /** Sanity route — démontre l'enveloppe { data, message, statusCode }. */
  @Get('health')
  health(): { data: { status: string; service: string }; message: string } {
    return {
      data: { status: 'ok', service: 'salon-backend' },
      message: 'Service healthy',
    };
  }
}
