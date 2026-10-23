import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

/**
 * Single-admin auth — there is no multi-user system here (this replaces
 * WordPress's user accounts, which this dashboard never needed more than
 * one of). Credentials live in env vars: ADMIN_USERNAME + ADMIN_PASSWORD_HASH
 * (a bcrypt hash, generated once via `npm run hash-password -- <password>`
 * — never store the plaintext password in .env). See
 * ProjectDocs/DEPLOYMENT.md for the setup command.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{ accessToken: string }> {
    const expectedUsername = this.config.getOrThrow<string>('ADMIN_USERNAME');
    const expectedHash = this.config.getOrThrow<string>('ADMIN_PASSWORD_HASH');

    // Constant-time-ish: always run bcrypt.compare even on a username
    // mismatch, so a wrong username doesn't return faster than a wrong
    // password and leak which one was wrong via timing.
    const usernameMatches = username === expectedUsername;
    const passwordMatches = await bcrypt.compare(password, expectedHash);

    if (!usernameMatches || !passwordMatches) {
      this.logger.warn(`Failed login attempt for username "${username}"`);
      throw new UnauthorizedException('Invalid credentials');
    }

    const accessToken = await this.jwt.signAsync({ sub: username });
    return { accessToken };
  }
}
