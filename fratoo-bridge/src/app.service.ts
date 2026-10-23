import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface VersionInfo {
  /** Product version — same number in fratoo-bridge and fratoo-web (see CHANGELOG.md "Versioning"). */
  version: string;
  /** Short git commit the image was built from, passed in by ProdRelease.bat; 'dev' outside Docker. */
  commit: string;
  /** When this process started — i.e. when the deploy (or restart) happened. */
  startedAt: string;
}

/** Read once at startup; also printed in the batch report's footnote (ReportsService). */
export const VERSION_INFO: VersionInfo = {
  // package.json sits one level above both src/ (ts-node, jest) and dist/ (Docker runtime).
  version: (
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version,
  commit: process.env.GIT_COMMIT || 'dev',
  startedAt: new Date().toISOString(),
};

@Injectable()
export class AppService {
  getVersion(): VersionInfo {
    return VERSION_INFO;
  }
}
