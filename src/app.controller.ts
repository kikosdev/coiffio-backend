import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('App')
@Controller()
export class AppController {
  /** Sanity route — démontre l'enveloppe { data, message, statusCode }. */
  @ApiOperation({ summary: 'Health check sanity route' })
  @ApiResponse({ status: 200, description: 'Service healthy' })
  @Get('health')
  health(): { data: { status: string; service: string }; message: string } {
    return {
      data: { status: 'ok', service: 'salon-backend' },
      message: 'Service healthy',
    };
  }

  @ApiOperation({ summary: 'Public mobile configuration' })
  @ApiResponse({ status: 200, description: 'Public config values' })
  @Get('config/public')
  publicConfig(): { data: { privacyPolicyUrl: string }; message: string } {
    return {
      data: {
        privacyPolicyUrl: process.env.PRIVACY_POLICY_URL ?? 'https://coiffio.com/privacy',
      },
      message: 'OK',
    };
  }
}


