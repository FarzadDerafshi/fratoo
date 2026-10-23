import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePushSubscriptionDto, PushEndpointDto, TestPushDto } from './push.dto';
import { PushService } from './push.service';

@UseGuards(JwtAuthGuard)
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** The VAPID public key the browser subscribes with, and how many devices are subscribed. */
  @Get()
  async status() {
    return { publicKey: this.push.getPublicKey(), subscriptions: await this.push.countSubscriptions() };
  }

  @Post('subscriptions')
  @HttpCode(204)
  async subscribe(@Body() dto: CreatePushSubscriptionDto, @Headers('user-agent') userAgent?: string) {
    await this.push.subscribe(dto, userAgent ?? null);
  }

  @Post('subscriptions/remove')
  @HttpCode(204)
  async unsubscribe(@Body() dto: PushEndpointDto) {
    await this.push.unsubscribe(dto.endpoint);
  }

  @Post('test')
  test(@Body() dto: TestPushDto) {
    const payload = { title: 'Fratoo', body: 'Test notification — notifications work on this device.', url: '/settings', tag: 'test' };
    return dto.endpoint ? this.push.sendToEndpoint(dto.endpoint, payload) : this.push.sendToAll(payload);
  }
}
