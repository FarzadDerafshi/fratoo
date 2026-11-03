import { ServiceUnavailableException } from '@nestjs/common';
import { footerHtml, PdfService } from './pdf.service';

describe('PdfService', () => {
  const service = new PdfService();
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts the page and footer to Gotenberg as A4 and returns the PDF', async () => {
    let url = '';
    let form: FormData | null = null;
    global.fetch = jest.fn(async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      form = init!.body as FormData;
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    }) as typeof fetch;

    const pdf = await service.htmlToPdf('<p>x</p>', 'IPA 2026.10');
    expect(pdf.toString()).toBe('%PDF');
    expect(url).toMatch(/\/forms\/chromium\/convert\/html$/);
    const f = form as unknown as FormData;
    expect(f.get('paperWidth')).toBe('8.27');
    expect(f.get('paperHeight')).toBe('11.7');
    expect(f.get('printBackground')).toBe('true');
    expect(f.get('waitForExpression')).toBe('window.reportReady === true');
    const names = f.getAll('files').map((v) => (v as File).name);
    expect(names).toEqual(['index.html', 'footer.html']);
  });

  it('answers 503 when Gotenberg is down or fails', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(service.htmlToPdf('<p>x</p>', 'x')).rejects.toBeInstanceOf(ServiceUnavailableException);

    global.fetch = jest.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(service.htmlToPdf('<p>x</p>', 'x')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('escapes the footer text and adds page numbers', () => {
    const html = footerHtml('A <b> & C');
    expect(html).toContain('A &lt;b&gt; &amp; C');
    expect(html).toContain('class="pageNumber"');
    expect(html).toContain('class="totalPages"');
  });
});
