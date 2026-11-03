import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Turns the report page into a PDF with Gotenberg (headless Chromium in its
 * own container, GOTENBERG_URL, internal network only). The page is fully
 * self-contained (see report-assets.ts), so Gotenberg never calls back into
 * this API or the internet. Same pattern as MyRecipes' PdfService.
 */
@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  async htmlToPdf(html: string, footerText: string): Promise<Buffer> {
    const base = process.env.GOTENBERG_URL ?? 'http://pdf:3000';
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('files', new Blob([footerHtml(footerText)], { type: 'text/html' }), 'footer.html');
    // A4, 15 mm margins, keep the colours, wait for the fonts and the chart.
    for (const [k, v] of Object.entries({
      paperWidth: '8.27',
      paperHeight: '11.7',
      marginTop: '0.6',
      marginBottom: '0.6',
      marginLeft: '0.6',
      marginRight: '0.6',
      printBackground: 'true',
      skipNetworkIdleEvent: 'false',
      waitForExpression: 'window.reportReady === true',
    })) {
      form.append(k, v);
    }

    let res: globalThis.Response;
    try {
      res = await fetch(`${base}/forms/chromium/convert/html`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      this.logger.error(`Gotenberg unreachable: ${(err as Error).message}`);
      throw new ServiceUnavailableException('The PDF service is not available right now');
    }
    if (!res.ok) {
      this.logger.error(`Gotenberg ${res.status}: ${(await res.text()).slice(0, 300)}`);
      throw new ServiceUnavailableException('Could not make the PDF');
    }
    return Buffer.from(await res.arrayBuffer());
  }

  send(res: Response, pdf: Buffer, filename: string): void {
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  }
}

/**
 * Chromium's footer template: printed in the bottom margin of every page.
 * It has no access to the page's fonts or styles, hence the inline system font.
 */
export function footerHtml(text: string): string {
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; }
.f { width: 100%; margin: 0 0.6in; display: flex; justify-content: space-between;
	font-family: system-ui, sans-serif; font-size: 8px; color: #5a6276; }
</style></head>
<body><div class="f"><span>${safe}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div></body></html>`;
}
