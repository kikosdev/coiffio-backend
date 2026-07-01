import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SalonsService, NearbySalon } from './salons.service';
import { NearbyQueryDto } from './dto/nearby-query.dto';

/**
 * Public — pas de guard. La géoloc ne nécessite pas de compte (invité autorisé).
 */
@ApiTags('Salons')
@Controller('salons')
export class SalonsController {
  constructor(private readonly salons: SalonsService) {}

  @ApiOperation({ summary: 'Find nearby salons by geographic coordinates' })
  @ApiResponse({ status: 200, description: 'OK' })
  @Get('nearby')
  async nearby(@Query() query: NearbyQueryDto): Promise<{ data: NearbySalon[]; message: string }> {
    const data = await this.salons.findNearby(query.lat, query.lng, query.radiusKm);
    return { data, message: 'OK' };
  }
}
