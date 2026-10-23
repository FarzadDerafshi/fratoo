import { isLongNote, renderNotesHtml } from './notes-format';

describe('renderNotesHtml', () => {
  it('turns plain lines into a paragraph with line breaks', () => {
    expect(renderNotesHtml('AMERICAN PALE ALE.\nYeast at 27C.')).toBe('<p>AMERICAN PALE ALE.<br>Yeast at 27C.</p>');
  });

  it('renders bullets, numbered lists, labels and headings', () => {
    const html = renderNotesHtml(
      '## Review\nGood:\n\n* It finished.\n- Strong start.\n\nTweaks:\n1. Pitch cooler.\n2) Use DME.',
    );
    expect(html).toBe(
      '<h4>Review</h4><p class="label"><strong>Good:</strong></p>' +
        '<ul><li>It finished.</li><li>Strong start.</li></ul>' +
        '<p class="label"><strong>Tweaks:</strong></p>' +
        '<ol><li>Pitch cooler.</li><li>Use DME.</li></ol>',
    );
  });

  it('supports **bold** inline', () => {
    expect(renderNotesHtml('about **4.9%** in the bottle')).toBe('<p>about <strong>4.9%</strong> in the bottle</p>');
  });

  it('escapes HTML before formatting', () => {
    const html = renderNotesHtml('<script>alert(1)</script>\n- **<b>x</b>**');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });

  it('a long sentence ending in a colon stays a paragraph', () => {
    expect(renderNotesHtml('x'.repeat(70) + ':')).toMatch(/^<p>x+:<\/p>$/);
  });
});

describe('isLongNote', () => {
  it('short notes stay in the header', () => {
    expect(isLongNote('AMERICAN PALE ALE. Added Yeast 5hrs later at 27C. Capped at 7PM')).toBe(false);
  });

  it('long or many-line notes get their own card', () => {
    expect(isLongNote('a\nb\nc\nd\ne')).toBe(true);
    expect(isLongNote('x'.repeat(300))).toBe(true);
  });
});
