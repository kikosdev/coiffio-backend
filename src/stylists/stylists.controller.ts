import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { StylistsService } from './stylists.service';
import { Stylist } from '../schemas/stylist.schema';

@Controller('stylists')
export class StylistsController {
  constructor(private stylistsService: StylistsService) {}

  @Get()
  findAll() {
    return this.stylistsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stylistsService.findOne(id);
  }

  @Get(':id/slots')
  getSlots(
    @Param('id') id: string,
    @Query('date') date: string,
    @Query('duration') duration: string,
  ) {
    return this.stylistsService.getAvailableSlots(id, date, parseInt(duration, 10));
  }

  @UseGuards(AuthGuard('jwt'))
  @Post()
  create(@Body() body: Partial<Stylist>) {
    return this.stylistsService.create(body);
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Partial<Stylist>) {
    return this.stylistsService.update(id, body);
  }
}
